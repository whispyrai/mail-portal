import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("attachment cleanup finalizes against the post-R2 queue snapshot", async () => {
	const source = await readFile(
		new URL("./index.ts", import.meta.url),
		"utf8",
	);
	const method = source.match(
		/async #processAttachmentCleanup\(\): Promise<boolean> \{[\s\S]*?\n\t\}/,
	)?.[0];
	assert.ok(method);
	const r2Yield = method.indexOf("await this.env.BUCKET.delete");
	const latestRead = method.indexOf(
		"await this.ctx.storage.get<AttachmentCleanupJob[]>",
		r2Yield,
	);
	const finalWrite = method.indexOf(
		"await this.ctx.storage.put(ATTACHMENT_CLEANUP_QUEUE_KEY, remaining)",
		latestRead,
	);

	assert.ok(r2Yield >= 0);
	assert.ok(latestRead > r2Yield);
	assert.ok(finalWrite > latestRead);
	assert.match(
		method,
		/latestQueue\.filter\(\(candidate\) => candidate\.id !== job\.id\)/,
	);
	assert.doesNotMatch(method, /queue\.shift\(\)/);
});
