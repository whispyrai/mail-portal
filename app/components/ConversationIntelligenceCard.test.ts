import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const card = readFileSync(
  new URL("./ConversationIntelligenceCard.tsx", import.meta.url),
  "utf8",
);
const query = readFileSync(
  new URL("../queries/conversation-intelligence.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");

test("Intelligence card is calm, collapsible, and exposes every cited result state", () => {
  assert.match(card, /aria-expanded/);
  assert.match(card, /Cached/);
  assert.match(card, /Generated/);
  assert.match(card, /budget/i);
  assert.match(card, /Summary/);
  assert.match(card, /Key points/);
  assert.match(card, /Follow-ups/);
  assert.match(card, /Commitments/);
  assert.match(card, /Human review required/);
  assert.match(card, /onFocusMessage/);
  assert.match(card, /Refresh intelligence/);
  assert.match(card, /ConversationQuestion/);
});

test("card performs only read/refresh intelligence requests and no mailbox mutation", () => {
  assert.match(query, /fetchConversationIntelligence/);
  assert.match(
    query,
    /request\(variables\.mailboxId, variables\.emailId, true\)/,
  );
  assert.doesNotMatch(
    card,
    /useSend|useMove|useDelete|useSchedule|mutateEmail/,
  );
  assert.doesNotMatch(card, /Automatically send|Apply action/);
});

test("selected Draft and Outbox messages never mount conversation intelligence", () => {
  assert.match(panel, /isIntelligenceUnsupported/);
  assert.match(
    panel,
    /!isIntelligenceUnsupported\s*&&\s*mailboxId\s*&&\s*\(/,
  );
});

test("collapsed intelligence is persistent and makes no request until opened", () => {
  assert.match(card, /conversationIntelligenceExpanded: expanded/);
  assert.match(card, /setConversationIntelligenceExpanded\(!expanded\)/);
  assert.match(
    card,
    /useConversationIntelligence\([\s\S]*?mailboxId,[\s\S]*?emailId,[\s\S]*?expanded,[\s\S]*?\)/,
  );
  assert.match(query, /enabled: enabled && Boolean\(mailboxId && emailId\)/);
  assert.match(card, /\{expanded && \([\s\S]*?aria-label="Refresh intelligence"/);
});

test("messages render before optional intelligence and activity sections", () => {
  const messageList = panel.indexOf("allMessages.map((msg, idx)");
  const intelligence = panel.indexOf("<ConversationIntelligenceCard", messageList);
  const activity = panel.indexOf("<ConversationActivity", messageList);
  assert.ok(messageList >= 0);
  assert.ok(intelligence > messageList);
  assert.ok(activity > messageList);
});
