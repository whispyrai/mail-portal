import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("../mcp/index.ts", import.meta.url),
	"utf8",
);

test("MCP exposes read, search, and reviewable draft tools only", () => {
	for (const allowed of [
		"list_emails",
		"get_email",
		"get_thread",
		"search_emails",
		"draft_reply",
		"create_draft",
		"update_draft",
	]) {
		assert.match(
			source,
			new RegExp("this\\.server\\.tool\\(\\s*[\"']" + allowed + "[\"']"),
		);
	}

	for (const forbidden of [
		"delete_email",
		"send_reply",
		"send_email",
		"mark_email_read",
		"move_email",
	]) {
		assert.doesNotMatch(
			source,
			new RegExp("this\\.server\\.tool\\(\\s*[\"']" + forbidden + "[\"']"),
		);
	}
});
