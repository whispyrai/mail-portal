import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  createLabelCreateHandler,
	handleDeleteLabel,
	handleListLabels,
	handleMutateLabels,
	handleUpdateLabel,
} from "./labels.ts";

function appWith(stub: Record<string, (...args: any[]) => any>,
  revalidateAccess: () => Promise<boolean> = async () => true,
) {
	const app = new Hono<any>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub);
		c.set("session", { sub: "user-1" });
    c.set("authorizedMailboxId", "support@example.com");
    await next();
	});
	app.get("/labels", handleListLabels as never);
	app.post("/labels", createLabelCreateHandler({ revalidateAccess }) as never);
	app.put("/labels/:labelId", handleUpdateLabel as never);
	app.delete("/labels/:labelId", handleDeleteLabel as never);
	app.post("/label-mutations", handleMutateLabels as never);
	return app;
}

test("active mailbox members can create, list, update, and delete mailbox labels", async () => {
	const calls: unknown[][] = [];
	const app = appWith({
		async getAutomationTargetUsage() { return []; },
		async listLabels() { return [{ id: "label-1", name: "Priority", color: "red" }]; },
		async createMailboxResourceIdempotently(input: unknown) { calls.push(["create", input]); return {
        status: "created",
        resource: { id: "label-1", name: "Priority", color: "red" },
      }; },
		async updateLabel(...args: unknown[]) { calls.push(["update", ...args]); return { id: "label-1", name: "Urgent", color: "orange" }; },
		async deleteLabel(...args: unknown[]) { calls.push(["delete", ...args]); return true; },
	});
	assert.equal((await app.request("/labels")).status, 200);
	assert.equal((await app.request("/labels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Priority", color: "red",
          operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
        }) })).status, 201);
	assert.equal((await app.request("/labels/label-1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Urgent", color: "orange" }) })).status, 200);
	assert.equal((await app.request("/labels/label-1", { method: "DELETE" })).status, 204);
	assert.equal(calls.length, 3);
	assert.deepEqual((calls[0]![1] as { actor: unknown }).actor, { kind: "user", id: "user-1" });
});

test("label create refuses a revoked or unavailable commit authorization", async () => {
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
    const response = await appWith(
      {
        async createMailboxResourceIdempotently() {
          durableObjectCalls++;
          return { status: "created" };
        },
      },
      scenario.revalidateAccess,
    ).request("/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Priority",
        color: "red",
        operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
      }),
    });
    assert.equal(response.status, scenario.expectedStatus);
    assert.equal(durableObjectCalls, 0);
  }
});

test("label create replays and reports later lifecycle truth", async () => {
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const body = JSON.stringify({ name: "Priority", color: "red", operationId });
  const replay = await appWith({
    async createMailboxResourceIdempotently() {
      return {
        status: "replayed",
        resource: { id: "label-1", name: "Priority", color: "red" },
      };
    },
  }).request("/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);

  for (const status of [
    "creation_superseded",
    "creation_unavailable",
  ] as const) {
    const response = await appWith({
      async createMailboxResourceIdempotently() {
        return {
          status,
          resourceId: "label-1",
          currentRevision: "2026-07-15T00:00:00.000Z",
        };
      },
    }).request("/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, status);
  }
});

test("label deletion reports the bounded Automation target conflict", async () => {
	let deleted = false;
	const app = appWith({
		async getAutomationTargetUsage() { return ["Vendor invoices"]; },
		async deleteLabel() { deleted = true; return true; },
	});
	const response = await app.request("/labels/label-1", { method: "DELETE" });
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Target is used by Automation Rule: Vendor invoices",
		code: "RULE_TARGET_IN_USE",
	});
	assert.equal(deleted, false);
});

test("label mutations validate bounded targets and preserve partial mailbox results", async () => {
	const app = appWith({
		async mutateLabels(command: unknown, actor: unknown) {
			assert.deepEqual(command, {
				labelId: "label-1",
				action: "apply",
				targets: [{ emailId: "email-1", folderId: "inbox" }],
			});
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return { status: "completed", results: [{ emailId: "email-1", status: "updated", affectedCount: 1 }] };
		},
	});
	const response = await app.request("/label-mutations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			labelId: "label-1",
			action: "apply",
			targets: [{ emailId: "email-1", folderId: "inbox" }],
		}),
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json() as any).results[0].status, "updated");

	const invalid = await app.request("/label-mutations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ labelId: "label-1", action: "apply", targets: [] }),
	});
	assert.equal(invalid.status, 400);
});
