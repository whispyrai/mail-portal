import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SnoozeDialog.tsx", import.meta.url), "utf8");

test("Snooze dialog is local-time aware, scoped, responsive, and undoable", () => {
	assert.match(source, /datetime-local/);
	assert.match(source, /This message/);
	assert.match(source, /Conversation/);
	assert.match(source, /aria-pressed=\{!conversation\}/);
	assert.match(source, /aria-pressed=\{conversation\}/);
	assert.match(source, /Later today/);
	assert.match(source, /Tomorrow/);
	assert.match(source, /Next week/);
	assert.match(source, /mailbox-wide and visible to every shared member/i);
	assert.match(source, /Undoing….*"Undo"/s);
	assert.match(source, /role="alert"/);
	assert.match(source, /w-\[calc\(100vw-1rem\)\]/);
});
