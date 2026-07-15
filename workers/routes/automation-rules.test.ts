import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createAutomationRuleRoutes,
	type AutomationRouteDependencies,
} from "./automation-rules.ts";

const mailboxId = "team@wiserchat.ai";
const base = `https://mail.test/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`;
const definition = {
	schemaVersion: 1 as const,
	name: "Vendor invoices",
	match: "all" as const,
	conditions: [{
		kind: "sender_domain" as const,
		operator: "is_any_of" as const,
		values: ["vendor.test"],
	}],
	actions: [{ kind: "star" as const }],
	stopProcessing: false,
};
const rule = {
	id: "rule-1",
	name: definition.name,
	state: "draft" as const,
	position: 0,
	revision: 1,
	activeVersion: null,
	draftVersion: 1,
	activeDefinition: null,
	draftDefinition: definition,
	createdBy: "user-1",
	createdAt: "2026-07-12T10:00:00.000Z",
	updatedBy: "user-1",
	updatedAt: "2026-07-12T10:00:00.000Z",
	archivedBy: null,
	archivedAt: null,
	targetHealth: "ready" as const,
	lastRunAt: null,
	lastMatchedAt: null,
};

function appWith(
	stub: Record<string, (...args: any[]) => any>,
	dependencies: AutomationRouteDependencies,
) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("session", {
			sub: "user-1",
			email: "user@wiserchat.ai",
			role: "ADMIN",
			mailbox: "user@wiserchat.ai",
		});
		c.set("authorizedMailboxId", mailboxId);
		c.set("mailboxStub", stub as never);
		await next();
	});
	app.route("/", createAutomationRuleRoutes(dependencies));
	return app;
}

function access(input: {
	manage?: boolean | boolean[];
	disclose?: boolean | boolean[];
} = {}): AutomationRouteDependencies {
	const manage = Array.isArray(input.manage) ? [...input.manage] : [input.manage ?? true];
	const disclose = Array.isArray(input.disclose) ? [...input.disclose] : [input.disclose ?? true];
	return {
		async canManage() { return manage.length > 1 ? manage.shift()! : manage[0]!; },
		async canDisclose() { return disclose.length > 1 ? disclose.shift()! : disclose[0]!; },
	};
}

test("Automation management uses the middleware-authorized Mailbox identity", async () => {
	let managedMailbox = "";
	const app = appWith({
		async listAutomationRules() {
			return { rules: [], rulesetGeneration: 0, orderRevision: 0 };
		},
	}, {
		async canManage(_c, _actorUserId, authorizedMailboxId) {
			managedMailbox = authorizedMailboxId;
			return true;
		},
		async canDisclose() { return true; },
	});
	const alias = encodeURIComponent(" TEAM@WISERCHAT.AI ");
	const response = await app.request(
		`https://mail.test/api/v1/mailboxes/${alias}/automation-rules`,
	);

	assert.equal(response.status, 200);
	assert.equal(managedMailbox, mailboxId);
});

test("a current Shared member reads strict Automation summaries without mutation authority", async () => {
	const app = appWith({
		async listAutomationRules() {
			return { rules: [rule], rulesetGeneration: 2, orderRevision: 3 };
		},
	}, access({ manage: false }));
	const response = await app.request(`${base}/automation-rules`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		rules: [rule],
		rulesetGeneration: 2,
		orderRevision: 3,
		canManage: false,
	});
});

test("a non-manager is rejected before request parsing or Durable Object mutation", async () => {
	let called = false;
	const app = appWith({
		async createAutomationRuleDraft() { called = true; },
	}, access({ manage: false }));
	const response = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "not-json",
	});
	assert.equal(response.status, 403);
	assert.equal(called, false);
});

test("an authorized manager creates only a strict revision-fenced draft", async () => {
	const calls: unknown[] = [];
	const app = appWith({
		async createAutomationRuleDraft(input: unknown) {
			calls.push(input);
			return { rule, rulesetGeneration: 0, orderRevision: 1 };
		},
	}, access());
	const invalid = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0, extra: true }),
	});
	assert.equal(invalid.status, 400);
	assert.equal(calls.length, 0);

	const response = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
	});
	assert.equal(response.status, 201);
	assert.deepEqual(calls, [{ definition, expectedOrderRevision: 0, actorId: "user-1" }]);
	assert.deepEqual(await response.json(), {
		rule,
		rulesetGeneration: 0,
		orderRevision: 1,
		canManage: true,
	});
});

test("in-flight management revocation suppresses a committed mutation response", async () => {
	let committed = false;
	const app = appWith({
		async createAutomationRuleDraft() {
			committed = true;
			return { rule, rulesetGeneration: 0, orderRevision: 1 };
		},
	}, access({ manage: [true, false] }));
	const response = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
	});
	assert.equal(committed, true);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("in-flight revocation suppresses both read and mutation failures", async () => {
	const readApp = appWith({
		async listAutomationRules() { throw new Error("private read failure"); },
	}, access({ disclose: false }));
	const read = await readApp.request(`${base}/automation-rules`);
	assert.equal(read.status, 403);
	assert.doesNotMatch(await read.text(), /private read failure/u);

	const writeApp = appWith({
		async createAutomationRuleDraft() {
			const error = new Error("private mutation conflict");
			error.name = "AutomationRuleError:CONFLICT";
			throw error;
		},
	}, access({ manage: [true, false] }));
	const write = await writeApp.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
	});
	assert.equal(write.status, 403);
	assert.doesNotMatch(await write.text(), /private mutation conflict/u);
});

test("oversize declarations and malformed history queries fail before mailbox reads", async () => {
	let read = false;
	const app = appWith({
		async createAutomationRuleDraft() { read = true; },
		async listAutomationRuns() { read = true; return { runs: [], next: null }; },
	}, access());
	const oversized = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"content-length": "999999",
		},
		body: "{}",
	});
	assert.equal(oversized.status, 413);
	const fractional = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"content-length": "1.5",
		},
		body: "{}",
	});
	assert.equal(fractional.status, 400);
	const malformed = await app.request(`${base}/automation-runs?state=pending&state=failed`);
	assert.equal(malformed.status, 400);
	assert.equal(read, false);
});

test("Run history resolves current links without copying mail bodies or action target IDs", async () => {
	const app = appWith({
		async getAutomationRun() {
			return {
				id: "automation:message-1",
				triggerMessageId: "message-1",
				message: {
					emailId: "message-1",
					folderId: "project",
					conversationId: "thread-1",
					sender: "sender@example.com",
					subject: "Invoice",
					date: "2026-07-12T10:00:00.000Z",
				},
				rulesetGeneration: 1,
				state: "applied",
				attemptCount: 1,
				evaluatedCount: 1,
				matchedCount: 1,
				appliedCount: 1,
				stoppedByRuleId: null,
				completedAt: "2026-07-12T10:00:01.000Z",
				failureCategory: null,
				createdAt: "2026-07-12T10:00:00.000Z",
				updatedAt: "2026-07-12T10:00:01.000Z",
				results: [{
					ordinal: 0,
					ruleId: "rule-1",
					ruleName: "Vendor invoices",
					ruleVersion: 1,
					outcome: "applied",
					matchedConditionIndexes: [0],
					plannedActions: ["apply_labels"],
					actionResults: [{ action: "apply_labels", status: "applied", targetId: "private-label-id" }],
					failureCategory: null,
					attemptCount: 1,
					createdAt: "2026-07-12T10:00:01.000Z",
				}],
			};
		},
	}, access({ manage: false }));
	const response = await app.request(`${base}/automation-runs/automation%3Amessage-1`);
	assert.equal(response.status, 200);
	const text = await response.text();
	assert.doesNotMatch(text, /private-label-id|body|raw_headers/i);
	const payload = JSON.parse(text);
	assert.equal(payload.run.message.messageId, "message-1");
	assert.equal("emailId" in payload.run.message, false);
	assert.equal(payload.run.message.href, `/mailbox/team%40wiserchat.ai/open/message-1`);
	assert.deepEqual(payload.run.results[0].actionResults, [
		{ action: "apply_labels", status: "applied" },
	]);
});

test("enable accepts only the revision fence and never a zero-result bypass", async () => {
	let calls = 0;
	const app = appWith({
		async setAutomationRuleEnabled(input: unknown) {
			calls += 1;
			assert.deepEqual(input, {
				ruleId: "rule-1",
				enabled: true,
				actorId: "user-1",
				expectedRevision: 1,
			});
			return { rule, rulesetGeneration: 1, orderRevision: 1 };
		},
	}, access());
	const bypass = await app.request(`${base}/automation-rules/rule-1/enable`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision: 1, acknowledgedZero: true }),
	});
	assert.equal(bypass.status, 400);
	assert.equal(calls, 0);

	const response = await app.request(`${base}/automation-rules/rule-1/enable`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision: 1 }),
	});
	assert.equal(response.status, 200);
	assert.equal(calls, 1);
});

test("dry run requires one saved rule draft identity before Durable Object work", async () => {
	let calls = 0;
	const app = appWith({
		async dryRunAutomationRule() {
			calls += 1;
		},
	}, access());
	for (const body of [
		{ definition, acknowledgedZero: false },
		{ definition, ruleId: "rule-1", acknowledgedZero: false },
		{ definition, ruleVersion: 1, acknowledgedZero: false },
	]) {
		const response = await app.request(`${base}/automation-rules/dry-run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 400);
	}
	assert.equal(calls, 0);
});

test("serialized Durable Object error names retain stable conflict mapping", async () => {
	const app = appWith({
		async createAutomationRuleDraft() {
			const error = new Error("Automation Rule changed; refresh and try again");
			error.name = "AutomationRuleError:CONFLICT";
			throw error;
		},
	}, access());
	const response = await app.request(`${base}/automation-rules`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
	});
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Automation Rule changed; refresh and try again",
		code: "CONFLICT",
	});
});
