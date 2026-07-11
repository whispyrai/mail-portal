import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchConversationIntelligence,
  ConversationIntelligenceApiError,
} from "./conversation-intelligence.ts";

test("client requests mailbox-scoped intelligence and makes refresh explicit", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const response = await fetchConversationIntelligence(
    "team@example.com",
    "message/1",
    true,
    async (url, init) => {
      request = { url: String(url), init };
      return new Response(
        JSON.stringify({
          state: "budget_paused",
          reason: "admin_review_required",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  assert.equal(
    request?.url,
    "/api/v1/mailboxes/team%40example.com/emails/message%2F1/intelligence",
  );
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { refresh: true });
  assert.equal(response.state, "budget_paused");
});

test("client surfaces a stable API error without exposing response internals", async () => {
  await assert.rejects(
    () =>
      fetchConversationIntelligence(
        "team@example.com",
        "m1",
        false,
        async () =>
          new Response(JSON.stringify({ error: "Temporarily unavailable" }), {
            status: 502,
          }),
      ),
    (error: unknown) =>
      error instanceof ConversationIntelligenceApiError &&
      error.status === 502 &&
      error.message === "Temporarily unavailable",
  );
});
