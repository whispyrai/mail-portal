import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");
const threadMessage = readFileSync(
	new URL("./email-panel/ThreadMessage.tsx", import.meta.url),
	"utf8",
);

test("opening a cited message expands, scrolls, and focuses that exact source", () => {
	assert.match(panel, /pendingMessageFocusRef\.current = currentEmailId/);
	assert.match(panel, /setExpandedMessages\(new Set\(\[currentEmailId\]\)\)/);
	assert.match(panel, /dataset\.intelligenceMessageId === pendingId/);
	assert.match(panel, /target\.scrollIntoView\(\{ block: "start" \}\)/);
	assert.match(panel, /target\.focus\(\{ preventScroll: true \}\)/);
	assert.match(panel, /onFocusMessage=\{focusMessage\}/);
});

test("thread and single-message sources expose focusable labeled anchors", () => {
	assert.match(threadMessage, /data-intelligence-message-id=\{email\.id\}/);
	assert.match(threadMessage, /aria-label=\{`Message from \$\{senderLabel\}/);
	assert.match(panel, /data-intelligence-message-id=\{email\.id\}[\s\S]*?tabIndex=\{-1\}/);
});
