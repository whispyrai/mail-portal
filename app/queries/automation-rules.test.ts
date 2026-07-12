import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildAutomationRulesQueryOptions } from "./automation-rules.ts";
import { AutomationRulesApiError } from "../services/automation-rules.ts";

test("rules query owns a Mailbox-scoped key and reports direct revocation", async () => {
	let revoked = "";
	const options = buildAutomationRulesQueryOptions(
		"team@example.test",
		(mailboxId) => { revoked = mailboxId; },
		async () => { throw new AutomationRulesApiError(403, "Forbidden"); },
	);
	assert.deepEqual(options.queryKey, ["automations", "team@example.test", "rules"]);
	await assert.rejects(options.queryFn({ signal: new AbortController().signal }));
	assert.equal(revoked, "team@example.test");
	assert.equal(options.retry(0, new AutomationRulesApiError(403, "Forbidden")), false);
});

test("create mutation forwards definition and expected order revision as one strict input", async () => {
	const source = await readFile(new URL("./automation-rules.ts", import.meta.url), "utf8");
	assert.match(source, /expectedOrderRevision: number/);
	assert.match(source, /createAutomationRule\(mailboxId, input\)/);
	assert.doesNotMatch(source, /createAutomationRule\(mailboxId, definition\)/);
});
