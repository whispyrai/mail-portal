import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	classMethodText,
	parseTypescriptSource,
} from "../testing/typescript-source.ts";

test("attachment cleanup finalizes against the post-R2 queue snapshot", async () => {
	const source = await readFile(
		new URL("./index.ts", import.meta.url),
		"utf8",
	);
	const method = classMethodText(
		parseTypescriptSource(source, "index.ts"),
		"processAttachmentCleanup",
	);
	const r2Yield = method.indexOf("await this.env.BUCKET.delete");
	const latestRead = method.indexOf(
		"await transaction.get<AttachmentCleanupJob[]>",
		r2Yield,
	);
	const finalWrite = method.indexOf(
		"await transaction.put(ATTACHMENT_CLEANUP_QUEUE_KEY, remaining)",
		latestRead,
	);

	assert.ok(r2Yield >= 0);
	assert.ok(latestRead > r2Yield);
	assert.ok(finalWrite > latestRead);
	assert.match(
		method,
		/latestQueue\.filter\([\s\S]*candidate\.id !== job\.id \|\| candidate\.generation !== job\.generation/,
	);
	assert.doesNotMatch(method, /queue\.shift\(\)/);
});

test("mailbox reads restore a lost legacy attachment-cleanup alarm", async () => {
	const source = await readFile(
		new URL("./index.ts", import.meta.url),
		"utf8",
	);
	const parsed = parseTypescriptSource(source, "index.ts");
	const selfHeal = classMethodText(parsed, "selfHealCleanupAlarm");
	assert.match(
		selfHeal,
		/ctx\.storage\.get<AttachmentCleanupJob\[\]>\(\s*ATTACHMENT_CLEANUP_QUEUE_KEY/,
	);
	assert.match(selfHeal, /attachmentCleanupNextAt/);
	assert.match(selfHeal, /Math\.max\(now, Math\.min\(\.\.\.candidates\)\)/);
	assert.match(selfHeal, /await this\.#scheduleAlarmAt/);

	for (const methodName of ["getEmails", "getEmail", "getThreadedEmails"]) {
		assert.match(
			classMethodText(parsed, methodName),
			/await this\.#selfHealCleanupAlarm\(\)/,
		);
	}
});
