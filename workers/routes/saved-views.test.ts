import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { Env } from "../types.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { SavedViewError, type SavedViewRecord } from "../lib/saved-views.ts";
import {
  createSavedViewsApp,
  type SavedViewOperations,
  type SavedViewsContext,
} from "./saved-views.ts";

const session: SessionClaims = {
  sub: "usr_1",
  email: "one@example.com",
  role: "AGENT",
  mailbox: "one@example.com",
};

const view: SavedViewRecord = {
  id: "view_1",
  ownerUserId: "usr_1",
  mailboxAddress: "support@example.com",
  name: "Urgent unread",
  filters: { folder: "inbox", isRead: false, labelId: "label_urgent" },
  sort: { column: "date", direction: "DESC" },
  createdAt: 10,
  updatedAt: 10,
};

function operations(
  overrides: Partial<SavedViewOperations> = {},
): SavedViewOperations {
  return {
    async list() {
      return [view];
    },
    async use() {
      return view;
    },
    async create() {
      return view;
    },
    async update() {
      return view;
    },
    async delete() {},
    ...overrides,
  };
}

function testApp(input?: {
  session?: SessionClaims | null;
  operations?: SavedViewOperations;
}) {
  const app = new Hono<SavedViewsContext>();
  app.use("*", async (c, next) => {
    if (input?.session !== null) c.set("session", input?.session ?? session);
		c.set("authorizedMailboxId", "support@example.com");
    await next();
  });
  app.route(
    "/",
    createSavedViewsApp({
      service: () => input?.operations ?? operations(),
    }),
  );
  return app;
}

function request(
  app: Hono<SavedViewsContext>,
  path: string,
  init?: RequestInit,
) {
  return app.request(`http://mail.example.com${path}`, init, {} as Env);
}

test("saved view routes require a signed-in owner", async () => {
  const response = await request(
    testApp({ session: null }),
    "/api/v1/mailboxes/support%40example.com/saved-views",
  );
  assert.equal(response.status, 401);
});

test("list and use return owner-safe definitions and a non-broadening label query", async () => {
  let usedBy = "";
  const app = testApp({
    operations: operations({
      async use(viewId, userId, mailboxAddress) {
        assert.equal(viewId, "view_1");
        usedBy = userId;
        assert.equal(mailboxAddress, "support@example.com");
        return view;
      },
    }),
  });
  const listed = await request(
    app,
    "/api/v1/mailboxes/support%40example.com/saved-views",
  );
  assert.deepEqual(await listed.json(), {
    views: [
      {
        id: "view_1",
        mailboxAddress: "support@example.com",
        name: "Urgent unread",
        filters: { folder: "inbox", isRead: false, labelId: "label_urgent" },
        sort: { column: "date", direction: "DESC" },
        createdAt: 10,
        updatedAt: 10,
      },
    ],
  });
  const used = await request(
    app,
    "/api/v1/mailboxes/support%40example.com/saved-views/view_1/use",
    { method: "POST" },
  );
  assert.equal(used.status, 200);
  assert.equal(usedBy, "usr_1");
  assert.equal(
    ((await used.json()) as { searchParams: Record<string, string> })
      .searchParams.label_id,
    "label_urgent",
  );
});

test("create, replace, and delete are owner and mailbox scoped", async () => {
  const calls: string[] = [];
  const app = testApp({
    operations: operations({
      async create(userId, mailboxAddress) {
        calls.push(`create:${userId}:${mailboxAddress}`);
        return view;
      },
      async update(viewId, userId, mailboxAddress) {
        calls.push(`update:${viewId}:${userId}:${mailboxAddress}`);
        return view;
      },
      async delete(viewId, userId, mailboxAddress) {
        calls.push(`delete:${viewId}:${userId}:${mailboxAddress}`);
      },
    }),
  });
  const body = JSON.stringify({
    name: "Urgent unread",
    filters: { folder: "inbox", isRead: false },
    sort: { column: "date", direction: "DESC" },
  });
  assert.equal(
    (
      await request(
        app,
        "/api/v1/mailboxes/support%40example.com/saved-views",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        app,
        "/api/v1/mailboxes/support%40example.com/saved-views/view_1",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        app,
        "/api/v1/mailboxes/support%40example.com/saved-views/view_1",
        {
          method: "DELETE",
        },
      )
    ).status,
    204,
  );
  assert.deepEqual(calls, [
    "create:usr_1:support@example.com",
    "update:view_1:usr_1:support@example.com",
    "delete:view_1:usr_1:support@example.com",
  ]);
});

test("saved view errors map to stable API responses", async () => {
  for (const [error, status] of [
    [new SavedViewError("INVALID", "Invalid"), 400],
    [new SavedViewError("FORBIDDEN", "Forbidden"), 403],
    [new SavedViewError("NOT_FOUND", "Missing"), 404],
    [new SavedViewError("CONFLICT", "Duplicate"), 409],
  ] as const) {
    const response = await request(
      testApp({
        operations: operations({
          async list() {
            throw error;
          },
        }),
      }),
      "/api/v1/mailboxes/support%40example.com/saved-views",
    );
    assert.equal(response.status, status);
  }
});
