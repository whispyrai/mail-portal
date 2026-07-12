import assert from "node:assert/strict";
import test from "node:test";
import {
	AutomationRulesApiError,
	AutomationRulesResponseError,
	createAutomationRule,
	fetchAutomationRun,
	fetchAutomationRules,
	setAutomationRuleEnabled,
} from "./automation-rules.ts";

const definition = {
	schemaVersion: 1 as const,
	name: "Invoices",
	match: "all" as const,
	conditions: [{ kind: "sender_domain" as const, operator: "is_any_of" as const, values: ["vendor.test"] }],
	actions: [{ kind: "star" as const }],
	stopProcessing: false,
};

const rule = {
	id: "rule-1",
	name: "Invoices",
	state: "draft",
	position: 0,
	revision: 1,
	activeVersion: null,
	draftVersion: 1,
	activeDefinition: null,
	draftDefinition: definition,
	createdBy: "actor-1",
	createdAt: "2026-07-12T10:00:00.000Z",
	updatedBy: "actor-1",
	updatedAt: "2026-07-12T10:00:00.000Z",
	archivedBy: null,
	archivedAt: null,
	targetHealth: "ready",
	lastRunAt: null,
	lastMatchedAt: null,
};

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("rules transport encodes the Mailbox and accepts only the strict DTO", async () => {
	let requested = "";
	const result = await fetchAutomationRules("team@example.test", {
		fetcher: async (input) => {
			requested = String(input);
			return response({ rules: [rule], rulesetGeneration: 0, orderRevision: 0, canManage: false });
		},
	});
	assert.equal(requested, "/api/v1/mailboxes/team%40example.test/automation-rules");
	assert.equal(result.rules[0]?.draftDefinition?.name, "Invoices");
	assert.equal(result.canManage, false);
});

test("rules transport rejects unknown response keys", async () => {
	await assert.rejects(
		fetchAutomationRules("mailbox", {
			fetcher: async () => response({ rules: [], rulesetGeneration: 0, orderRevision: 0, canManage: true, secret: "leak" }),
		}),
		AutomationRulesResponseError,
	);
});

test("rules transport preserves direct 403 status", async () => {
	await assert.rejects(
		fetchAutomationRules("mailbox", {
			fetcher: async () => response({ error: "Forbidden" }, 403),
		}),
		(error: unknown) => error instanceof AutomationRulesApiError && error.status === 403,
	);
});

test("create draft sends the strict definition and expected order revision", async () => {
	let sentBody: unknown;
	await createAutomationRule("mailbox", {
		definition,
		expectedOrderRevision: 7,
	}, async (_input, init) => {
		sentBody = JSON.parse(String(init?.body));
		return response({
			rule,
			rulesetGeneration: 0,
			orderRevision: 8,
			canManage: true,
		});
	});
	assert.deepEqual(sentBody, { definition, expectedOrderRevision: 7 });
});

test("enable transport sends only the revision fence", async () => {
	let sentBody: unknown;
	await setAutomationRuleEnabled("mailbox", "rule-1", true, {
		expectedRevision: 7,
	}, async (_input, init) => {
		sentBody = JSON.parse(String(init?.body));
		return response({
			rule,
			rulesetGeneration: 1,
			orderRevision: 1,
			canManage: true,
		});
	});
	assert.deepEqual(sentBody, { expectedRevision: 7 });
});

test("run detail transport accepts the server's available-message contract", async () => {
	const result = await fetchAutomationRun("mailbox", "run-1", {
		fetcher: async () => response({
			run: {
				id: "run-1",
				message: {
					state: "available",
					messageId: "message-1",
					conversationId: "conversation-1",
					sender: "sender@example.test",
					subject: "Invoice",
					date: "2026-07-12T10:00:00.000Z",
					href: "/mailbox/mailbox/open/message-1",
				},
				rulesetGeneration: 1,
				state: "no_match",
				attemptCount: 1,
				evaluatedCount: 1,
				matchedCount: 0,
				appliedCount: 0,
				stoppedByRuleId: null,
				completedAt: "2026-07-12T10:00:01.000Z",
				failureCategory: null,
				createdAt: "2026-07-12T10:00:00.000Z",
				updatedAt: "2026-07-12T10:00:01.000Z",
				results: [],
			},
			canManage: false,
		}),
	});
	assert.equal(result.run.message.messageId, "message-1");
});
