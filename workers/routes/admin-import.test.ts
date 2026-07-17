import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { Email } from "postal-mime";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import { createAdminImportRouteHandler } from "./admin-import.ts";

type TestContext = {
  Bindings: Env;
  Variables: { session?: SessionClaims };
};

function routeFixture() {
  const calls = {
    mailboxAccess: 0,
    mailboxLookup: 0,
    bodyReads: 0,
    parses: 0,
    imports: 0,
  };
  const observed: { mailboxId?: string; folder?: string } = {};
  const app = new Hono<TestContext>();
  app.use("*", async (c, next) => {
    c.set("session", {
      sub: "admin-1",
      email: "admin@wiserchat.ai",
      role: "ADMIN",
      mailbox: "admin@wiserchat.ai",
    });
    await next();
  });
  app.post(
    "/import/:mailboxId",
    createAdminImportRouteHandler({
      async canAccessMailbox(_env, _userId, mailboxId) {
        calls.mailboxAccess += 1;
        observed.mailboxId = mailboxId;
        return true;
      },
      async mailboxExists() {
        calls.mailboxLookup += 1;
        return true;
      },
      async readRawEmail() {
        calls.bodyReads += 1;
        return new TextEncoder().encode(
          "From: sender@example.com\r\nMessage-ID: <route@example.com>\r\n\r\nBody",
        ).buffer as ArrayBuffer;
      },
      async parseRawEmail() {
        calls.parses += 1;
        return {
          messageId: "<route@example.com>",
          from: { address: "sender@example.com" },
          to: [{ address: "team@example.com" }],
          headers: [],
          headerLines: [],
          attachments: [],
        } as Email;
      },
      async importEmail(_env, _parsed, folder) {
        calls.imports += 1;
        observed.folder = folder;
        return {
          status: "imported" as const,
          id: "a".repeat(32),
          folder,
          identitySource: "message-id" as const,
        };
      },
    }),
  );
  return { app, calls, observed };
}

async function request(app: Hono<TestContext>, query: string) {
  return app.request(
    `http://mail.wiserchat.ai/import/TEAM%40EXAMPLE.COM${query ? `?${query}` : ""}`,
    { method: "POST", body: "body-must-not-be-read-for-invalid-authority" },
    {} as Env,
  );
}

test("duplicate folder parameters fail before mailbox, body, claim, or mutation work", async () => {
  for (const query of [
    "folder=Inbox&folder=Trash",
    "folder=Trash&folder=Inbox",
    "folder=Inbox&folder=Inbox",
    "folder=&folder=Inbox",
    "folder=Inbox&folder=",
  ]) {
    const { app, calls } = routeFixture();
    const response = await request(app, query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(
      await response.json(),
      { error: "exactly one folder query param is required" },
      query,
    );
    assert.deepEqual(
      calls,
      {
        mailboxAccess: 0,
        mailboxLookup: 0,
        bodyReads: 0,
        parses: 0,
        imports: 0,
      },
      query,
    );
  }
});

test("missing or single empty folder authority fails before any mailbox or body work", async () => {
  for (const query of ["", "folder="]) {
    const { app, calls } = routeFixture();
    const response = await request(app, query);
    assert.equal(response.status, 400, query || "missing");
    assert.equal(calls.mailboxAccess, 0);
    assert.equal(calls.mailboxLookup, 0);
    assert.equal(calls.bodyReads, 0);
    assert.equal(calls.parses, 0);
    assert.equal(calls.imports, 0);
  }
});

test("one valid folder value reaches the canonical import path exactly once", async () => {
  const { app, calls, observed } = routeFixture();
  const response = await request(app, "folder=Inbox");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    status: "imported",
    id: "a".repeat(32),
    folder: "inbox",
    identitySource: "message-id",
  });
  assert.deepEqual(calls, {
    mailboxAccess: 1,
    mailboxLookup: 1,
    bodyReads: 1,
    parses: 1,
    imports: 1,
  });
  assert.deepEqual(observed, {
    mailboxId: "team@example.com",
    folder: "inbox",
  });
});
