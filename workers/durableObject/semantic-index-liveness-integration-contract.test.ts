import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const durableObject = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const globalSearch = readFileSync(new URL("../lib/global-semantic-search.ts", import.meta.url), "utf8");
const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");

test("semantic indexing is durably scheduled and advances before later shared alarm lanes", () => {
	assert.match(globalSearch, /scheduleSemanticIndexAdvance\(mailboxId\)/);
	assert.doesNotMatch(globalSearch, /scheduleAdvance:[\s\S]*advanceSemanticIndex\(/);
	assert.match(durableObject, /async scheduleSemanticIndexAdvance\(mailboxId: string\)/);
	assert.match(durableObject, /SEMANTIC_SCHEDULER_MAILBOX_KEY/);
	assert.match(durableObject, /advanceSemanticMailboxIndex\(/);
	assert.match(
		durableObject,
		/converter: createWorkersAiSemanticRichDocumentConverter\(this\.env\)/,
	);
	assert.doesNotMatch(durableObject, /advanceSemanticAttachmentExtraction\(/);
	assert.match(durableObject, /\.nextAdvanceAt\(Date\.now\(\)\)/);
	const alarmStart = durableObject.indexOf("async alarm(): Promise<void>");
	const semanticPass = durableObject.indexOf("#processSemanticIndexAlarm(alarmNow)", alarmStart);
	const automationPass = durableObject.indexOf("#processAutomationRulesAlarm()", alarmStart);
	assert.ok(alarmStart >= 0 && semanticPass > alarmStart && automationPass > semanticPass);
});

test("semantic indexing has an administrator-gated rebuild path and redacted scheduler logs", () => {
	assert.match(admin, /adminApp\.use\("\*"[\s\S]*session\.role !== "ADMIN"/);
	assert.match(admin, /post\("\/mailboxes\/:mailboxId\/semantic-rebuild"/);
	assert.match(admin, /rebuildSemanticIndex\(mailboxId\)/);
	assert.match(durableObject, /async rebuildSemanticIndex\(mailboxId: string\)/);
	for (const logCall of durableObject.matchAll(/console\.error\("\[semantic-index\][\s\S]*?\);/g)) {
		assert.doesNotMatch(logCall[0], /mailboxId|content|query|excerpt|address/);
	}
});

test("attachment candidate authority never turns an R2 outage or replacement into a complete zero", () => {
	const resolver = durableObject.slice(
		durableObject.indexOf("async resolveSemanticCandidates"),
		durableObject.indexOf("claimTodayBriefGeneration"),
	);
	assert.match(resolver, /this\.env\.BUCKET\.head\(attachmentKey\(/);
	assert.doesNotMatch(resolver, /BUCKET\.head[\s\S]*?\.catch\(\(\) => null\)/);
	assert.match(resolver, /invalidateAttachmentAuthority\(/);
	assert.match(resolver, /r2_authority_changed/);
	assert.match(resolver, /r2_object_missing/);
});
