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
