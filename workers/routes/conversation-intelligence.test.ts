import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import {
  ConversationIntelligenceNotFoundError,
  ConversationIntelligenceUnsupportedStateError,
  type ConversationIntelligenceRuntimeResponse,
} from "../lib/conversation-intelligence-runtime.ts";
import {
  createConversationIntelligenceApp,
  type ConversationIntelligenceRouteContext,
} from "./conversation-intelligence.ts";

const session = {
  sub: "usr-1",
  email: "user@example.com",
  role: "AGENT",
} as SessionClaims;

function app(input: {
  session?: SessionClaims;
  stub?: unknown;
  run?: (input: {
    mailboxId: string;
    actorUserId: string;
    emailId: string;
    force: boolean;
    stub: unknown;
  }) => Promise<ConversationIntelligenceRuntimeResponse>;
}) {
  const root = new Hono<ConversationIntelligenceRouteContext>();
  root.use("*", async (c, next) => {
    if (input.session) c.set("session", input.session);
    if (input.stub) c.set("mailboxStub", input.stub as never);
		c.set("authorizedMailboxId", "team@example.com");
    await next();
  });
  root.route(
    "/",
    createConversationIntelligenceApp({
      run:
        input.run ??
        (async () => ({
          state: "budget_paused",
          reason: "admin_review_required",
        })),
    }),
  );
  return root;
}

test("conversation intelligence requires both authentication and the authorized mailbox seam", async () => {
  const path = "/api/v1/mailboxes/team%40example.com/emails/m1/intelligence";
  assert.equal(
    (await app({ stub: {} }).request(path, { method: "POST" }, {} as Env))
      .status,
    401,
  );
  assert.equal(
    (await app({ session }).request(path, { method: "POST" }, {} as Env))
      .status,
    403,
  );
});

test("route derives actor and mailbox scope server-side and accepts only explicit refresh", async () => {
  let received: unknown;
  const response = await app({
    session,
    stub: { authorized: true },
    run: async (input) => {
      received = input;
      return { state: "budget_paused", reason: "admin_review_required" };
    },
  }).request(
    "/api/v1/mailboxes/Team%40Example.com/emails/m1/intelligence",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh: true }),
    },
    {} as Env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    mailboxId: "team@example.com",
    actorUserId: "usr-1",
    emailId: "m1",
    force: true,
    stub: { authorized: true },
  });

  const invalid = await app({ session, stub: {} }).request(
    "/api/v1/mailboxes/team%40example.com/emails/m1/intelligence",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh: true, automate: "send" }),
    },
    {} as Env,
  );
  assert.equal(invalid.status, 400);
});

test("route maps missing conversations and provider failures without leaking prompts", async () => {
  const path =
    "/api/v1/mailboxes/team%40example.com/emails/missing/intelligence";
  const missing = await app({
    session,
    stub: {},
    run: async () => {
      throw new ConversationIntelligenceNotFoundError();
    },
  }).request(path, { method: "POST" }, {} as Env);
  assert.equal(missing.status, 404);

  const failed = await app({
    session,
    stub: {},
    run: async () => {
      throw new Error("provider included private prompt text");
    },
  }).request(path, { method: "POST" }, {} as Env);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    error: "Conversation intelligence is temporarily unavailable.",
  });
});

test("route communicates that Draft and Outbox intelligence is unsupported", async () => {
  for (const folderId of ["draft", "outbox"] as const) {
    const response = await app({
      session,
      stub: {},
      run: async () => {
        throw new ConversationIntelligenceUnsupportedStateError(folderId);
      },
    }).request(
      "/api/v1/mailboxes/team%40example.com/emails/selected/intelligence",
      { method: "POST" },
      {} as Env,
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Conversation intelligence is unavailable for Drafts and Outbox messages.",
      code: "unsupported_message_state",
    });
  }
});
