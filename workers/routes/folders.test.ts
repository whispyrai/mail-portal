import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { createFolderCreateHandler, handleDeleteFolder } from "./folders.ts";

const mailboxId = "hello@wiserchat.ai";
const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
const authorizedCreateFolder = createFolderCreateHandler({
  revalidateAccess: async () => true,
});

test("folder create returns fresh and replay responses with one validated intent", async () => {
  const outcomes = [
    {
      status: "created",
      resource: { id: "client-work", name: "Client work", unreadCount: 0 },
    },
    {
      status: "replayed",
      resource: { id: "client-work", name: "Client work", unreadCount: 0 },
    },
  ];
  const inputs: unknown[] = [];
  const app = new Hono<MailboxContext>();
  app.use("*", async (c, next) => {
    c.set("authorizedMailboxId", mailboxId);
    c.set("session", {
      sub: "user-1",
      email: "hesham@wiserchat.ai",
      role: "AGENT",
      mailbox: mailboxId,
    });
    c.set("mailboxStub", {
      async createMailboxResourceIdempotently(input: unknown) {
        inputs.push(input);
        return outcomes.shift();
      },
    } as never);
    await next();
  });
  app.post("/folders", authorizedCreateFolder);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "  Client   work ", operationId }),
  };
  const fresh = await app.request("/folders", init);
  const replay = await app.request("/folders", init);
  assert.equal(fresh.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(((await fresh.json()) as { replayed: boolean }).replayed, false);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
  assert.equal((inputs[0] as { resourceId: string }).resourceId, "client-work");
  assert.deepEqual((inputs[0] as { actor: unknown }).actor, {
    kind: "user",
    id: "user-1",
  });
});

test("folder create exposes lifecycle recovery without recreating", async () => {
  for (const status of [
    "creation_superseded",
    "creation_unavailable",
  ] as const) {
    const app = new Hono<MailboxContext>();
    app.use("*", async (c, next) => {
      c.set("authorizedMailboxId", mailboxId);
      c.set("session", { sub: "user-1" } as never);
      c.set("mailboxStub", {
        async createMailboxResourceIdempotently() {
          return {
            status,
            resourceId: "client-work",
            currentRevision: "2026-07-15T00:00:00.000Z",
          };
        },
      } as never);
      await next();
    });
    app.post("/folders", authorizedCreateFolder);
    const response = await app.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Client work", operationId }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, status);
  }
});

test("folder create refuses a revoked or unavailable commit authorization", async () => {
  for (const scenario of [
    { expectedStatus: 403, revalidateAccess: async () => false },
    {
      expectedStatus: 503,
      revalidateAccess: async () => {
        throw new Error("D1 unavailable");
      },
    },
  ]) {
    let durableObjectCalls = 0;
    const app = new Hono<MailboxContext>();
    app.use("*", async (c, next) => {
      c.set("authorizedMailboxId", mailboxId);
      c.set("session", { sub: "user-1" } as never);
      c.set("mailboxStub", {
        async createMailboxResourceIdempotently() {
          durableObjectCalls++;
          return { status: "created" };
        },
      } as never);
      await next();
    });
    app.post(
      "/folders",
      createFolderCreateHandler({
        revalidateAccess: scenario.revalidateAccess,
      }),
    );
    const response = await app.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Client work", operationId }),
    });
    assert.equal(response.status, scenario.expectedStatus);
    assert.equal(durableObjectCalls, 0);
  }
});

function testApp(result: "deleted" | "not_found" | "protected" | "not_empty") {
	const stub = {
		async getAutomationTargetUsage() { return []; },
		async deleteFolder(id: string, actor: unknown) {
			assert.equal(id, "projects");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return result;
		},
	};
	const env = {};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "hesham@wiserchat.ai",
			role: "AGENT",
			mailbox: "hesham@wiserchat.ai",
		});
		await next();
	});
	app.delete(
		"/api/v1/mailboxes/:mailboxId/folders/:id",
		handleDeleteFolder,
	);

	return { app, env };
}

test("deleting an empty custom folder succeeds", async () => {
	const { app, env } = testApp("deleted");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 204);
	assert.equal(await response.text(), "");
});

test("deleting a non-empty custom folder is rejected", async () => {
	const { app, env } = testApp("not_empty");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Move or delete all emails before deleting this folder",
	});
});

test("deleting a protected system folder is forbidden", async () => {
	const { app, env } = testApp("protected");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "System folders cannot be deleted",
	});
});

test("deleting an unknown folder returns not found", async () => {
	const { app, env } = testApp("not_found");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Folder not found" });
});
