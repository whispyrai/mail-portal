import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { ConversationIntelligenceResponse } from "../services/conversation-intelligence.ts";
import {
  buildConversationIntelligenceRefreshOptions,
  conversationIntelligenceKey,
  isCurrentConversationIntelligenceRefresh,
} from "./conversation-intelligence.ts";

const cachedA: ConversationIntelligenceResponse = {
  state: "budget_paused",
  reason: "A finished",
};

test("a deferred A refresh cannot overwrite or report refresh state on conversation B", async () => {
  let resolveA: ((value: ConversationIntelligenceResponse) => void) | undefined;
  const request = async (mailboxId: string, emailId: string) => {
    assert.equal(mailboxId, "team-a@example.com");
    assert.equal(emailId, "message-a");
    return new Promise<ConversationIntelligenceResponse>((resolve) => {
      resolveA = resolve;
    });
  };
  const queryClient = new QueryClient();
  const refreshA = buildConversationIntelligenceRefreshOptions(
    queryClient,
    "team-a@example.com",
    "message-a",
    request,
  );
  const variablesA = {
    mailboxId: "team-a@example.com",
    emailId: "message-a",
  };
  const pendingA = refreshA.mutationFn(variablesA);

  const refreshB = buildConversationIntelligenceRefreshOptions(
    queryClient,
    "team-b@example.com",
    "message-b",
    request,
  );
  assert.notDeepEqual(refreshA.mutationKey, refreshB.mutationKey);
  assert.equal(
    isCurrentConversationIntelligenceRefresh(
      variablesA,
      "team-b@example.com",
      "message-b",
    ),
    false,
  );

  resolveA?.(cachedA);
  const responseA = await pendingA;
  // Simulate the stricter case where a rerender has installed B's callbacks
  // before the earlier A request resolves.
  refreshB.onSuccess(responseA, variablesA);
  assert.deepEqual(
    queryClient.getQueryData(
      conversationIntelligenceKey("team-a@example.com", "message-a"),
    ),
    cachedA,
  );
  assert.equal(
    queryClient.getQueryData(
      conversationIntelligenceKey("team-b@example.com", "message-b"),
    ),
    undefined,
  );
});
