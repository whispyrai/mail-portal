import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const durableObject = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const inbound = await readFile(new URL("../inbound-email.ts", import.meta.url), "utf8");
const storeEmail = await readFile(new URL("../lib/store-email.ts", import.meta.url), "utf8");
const automationModule = await readFile(new URL("../lib/automation-rules/index.ts", import.meta.url), "utf8");

test("only live receive supplies the explicit Automation trigger through shared storage", () => {
	assert.match(inbound, /automationTrigger:\s*"live_inbound"/u);
	assert.match(storeEmail, /automation_trigger:\s*options\.automationTrigger/u);
	assert.match(
		durableObject,
		/email\.automation_trigger !== "live_inbound"[\s\S]*?folderId !== Folders\.INBOX[\s\S]*?RecipientMemoryOrigins\.LIVE_INBOUND/u,
	);
	assert.doesNotMatch(storeEmail, /recipient_memory_origin[\s\S]{0,120}automationTrigger\s*=/u);
});

test("Message acceptance reserves durable provenance before isolating captured-version failure", () => {
	assert.match(durableObject, /captureLiveInbound\(email\.id, email\.date\)/u);
	const reservation = automationModule.indexOf("INSERT INTO automation_runs");
	const savepoint = automationModule.indexOf("SAVEPOINT automation_rule_snapshot", reservation);
	assert.ok(reservation >= 0 && savepoint > reservation);
	assert.match(automationModule, /ROLLBACK TO SAVEPOINT automation_rule_snapshot/u);
	assert.match(automationModule, /failure_category = 'capture_failed'/u);
	assert.match(durableObject, /capture failed after Message acceptance/u);
});

test("the shared alarm executes bounded Automation work before push and recovers every due state", () => {
	const alarmStart = durableObject.indexOf("async alarm(): Promise<void>");
	const automationPass = durableObject.indexOf("#processAutomationRulesAlarm()", alarmStart);
	const pushPass = durableObject.indexOf("processPushOutbox({", alarmStart);
	assert.ok(alarmStart >= 0 && automationPass > alarmStart && pushPass > automationPass);
	assert.match(durableObject, /processed < 2/u);
	assert.match(
		durableObject,
		/SELECT next_attempt_at AS due_at FROM automation_runs[\s\S]*?SELECT lease_expires_at AS due_at FROM automation_runs/u,
	);
});

test("winning rule actions finalize inside the lease-owned transaction callback", () => {
	assert.match(
		durableObject,
		/automation\.finalizeClaim\(claim, plan, \(ownedPlan\) => \{[\s\S]*?applyAutomationActionPlan/u,
	);
	assert.match(durableObject, /activity\.actor[\s\S]*?activity\.metadata/u);
	assert.match(durableObject, /getAutomationTargetUsage/u);
});
