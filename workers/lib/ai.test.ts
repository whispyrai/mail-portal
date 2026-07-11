import assert from "node:assert/strict";
import test from "node:test";
import { verifyDraft } from "./ai.ts";

test("draft verification is deterministic and never calls a model", async () => {
	const body =
		"<p>Hello Sam,</p><p>Draft saved.</p><p>This is the complete customer-facing draft.</p>";

	assert.equal(
		await verifyDraft(body),
		"<p>Hello Sam,</p><p>This is the complete customer-facing draft.</p>",
	);
});

test("draft verification preserves ordinary business content and quoted replies", async () => {
	const body =
		'<p>See https://example.com/docs and call get_email in your integration.</p><blockquote><p>Draft saved.</p></blockquote>';
	assert.equal(await verifyDraft(body), body);
});
