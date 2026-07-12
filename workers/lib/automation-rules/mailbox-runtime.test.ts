import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
	AutomationActionPlan,
	AutomationRunClaim,
	AutomationRulesSql,
} from "./index.ts";
import {
	applyAutomationActionPlan,
	readAutomationDryRunContexts,
	readAutomationPlanningContext,
} from "./mailbox-runtime.ts";

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_deletable INTEGER NOT NULL);
		CREATE TABLE emails (
		 id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, thread_id TEXT, sender TEXT, subject TEXT,
		 date TEXT, starred INTEGER, recipient_memory_origin TEXT, previous_folder_id TEXT, trashed_at TEXT
		);
		CREATE TABLE attachments (
		 id TEXT PRIMARY KEY, email_id TEXT NOT NULL, filename TEXT NOT NULL, disposition TEXT
		);
		CREATE TABLE labels (id TEXT PRIMARY KEY);
		CREATE TABLE email_labels (
		 email_id TEXT NOT NULL, label_id TEXT NOT NULL, created_at TEXT NOT NULL,
		 PRIMARY KEY(email_id, label_id)
		);
		INSERT INTO folders VALUES
		 ('inbox', 'Inbox', 0), ('archive', 'Archive', 0), ('project', 'Project', 1),
		 ('_cancelled_outbound', 'Internal', 1);
		INSERT INTO labels VALUES ('finance'), ('vip');
	`);
	const sql: AutomationRulesSql = {
		exec<T extends Record<string, ArrayBuffer | string | number | null>>(
			query: string,
			...bindings: (ArrayBuffer | string | number | null)[]
		) {
			assert.ok(bindings.length <= 100, `query exceeded Cloudflare's 100-bind limit: ${bindings.length}`);
			return database.prepare(query).all(...bindings) as T[];
		},
	};
	return { database, sql };
}

test("planning context uses the exact current Inbox scope and fully-satisfied labels", () => {
	const { database, sql } = fixture();
	database.exec(`
		INSERT INTO emails VALUES
		 ('m1', 'inbox', 'thread-1', 'Sender@Example.com', 'Invoice', '2026-07-12T10:00:00.000Z', 0, 'live_inbound', NULL, NULL),
		 ('m2', 'inbox', 'thread-1', 'sender@example.com', 'Re: Invoice', '2026-07-12T10:01:00.000Z', 0, 'live_inbound', NULL, NULL);
		INSERT INTO attachments VALUES ('a1', 'm1', 'diagram.png', 'inline');
		INSERT INTO email_labels VALUES
		 ('m1', 'finance', '2026-07-12T10:00:00.000Z'),
		 ('m2', 'finance', '2026-07-12T10:00:00.000Z'),
		 ('m1', 'vip', '2026-07-12T10:00:00.000Z');
	`);
	const context = readAutomationPlanningContext(sql, "m1");
	assert.ok(context);
	assert.deepEqual(context.snapshot.attachments, [
		{ filename: "diagram.png", disposition: "inline" },
	]);
	assert.deepEqual(context.currentInboxScope, {
		conversationMessageIds: ["m1", "m2"],
		existingLabelIds: ["finance"],
		triggerIsStarred: false,
	});
	assert.deepEqual(context.availableLabelIds, ["finance", "vip"]);
	assert.deepEqual(context.availableMoveFolderIds, ["archive", "project"]);
	database.close();
});

test("one finalized plan applies labels, trigger star, move, and attributed activity", () => {
	const { database, sql } = fixture();
	database.exec(`
		INSERT INTO emails VALUES
		 ('m1', 'inbox', 'thread-1', 'sender@example.com', 'Invoice', '2026-07-12T10:00:00.000Z', 0, 'live_inbound', NULL, NULL),
		 ('m2', 'inbox', 'thread-1', 'sender@example.com', 'Re: Invoice', '2026-07-12T10:01:00.000Z', 0, 'live_inbound', NULL, NULL);
		INSERT INTO email_labels VALUES ('m1', 'vip', '2026-07-12T10:00:00.000Z');
	`);
	const context = readAutomationPlanningContext(sql, "m1");
	assert.ok(context);
	const claim = {
		id: "automation:m1",
		triggerMessageId: "m1",
		rulesetGeneration: 1,
		attemptCount: 1,
		leaseToken: "lease",
		leaseExpiresAt: "2026-07-12T10:05:00.000Z",
		rules: [],
	} satisfies AutomationRunClaim;
	const plan = {
		state: "applied",
		evaluatedCount: 1,
		matchedCount: 1,
		appliedCount: 3,
		stoppedByRuleId: null,
		applyLabels: [{ labelId: "vip", ruleId: "rule-label", ruleVersion: 2 }],
		star: { ruleId: "rule-star", ruleVersion: 3 },
		move: { folderId: "project", ruleId: "rule-move", ruleVersion: 4 },
		results: [],
	} satisfies AutomationActionPlan;
	const activity: unknown[] = [];
	applyAutomationActionPlan(sql, claim, context, plan, (item) => activity.push(item));

	assert.deepEqual(
		JSON.parse(JSON.stringify(
			database.prepare("SELECT email_id, label_id FROM email_labels ORDER BY email_id").all(),
		)),
		[
			{ email_id: "m1", label_id: "vip" },
			{ email_id: "m2", label_id: "vip" },
		],
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(
			database.prepare("SELECT id, folder_id, starred FROM emails ORDER BY id").all(),
		)),
		[
			{ id: "m1", folder_id: "project", starred: 1 },
			{ id: "m2", folder_id: "project", starred: 0 },
		],
	);
	assert.deepEqual(
		(activity as Array<{ action: string; actor: { id: string } }>).map((item) => [
			item.action,
			item.actor.id,
		]),
		[
			["label_applied", "rule-label"],
			["email_updated", "rule-star"],
			["email_moved", "rule-move"],
		],
	);
	database.close();
});

test("dry-run candidates are newest live inbound Messages from only the last thirty days", () => {
	const { database, sql } = fixture();
	database.exec(`
		INSERT INTO emails VALUES
		 ('newer', 'inbox', NULL, 'a@example.com', 'Newer', '2026-07-12T10:00:00.000Z', 0, 'live_inbound', NULL, NULL),
		 ('older', 'archive', NULL, 'b@example.com', 'Older', '2026-07-11T10:00:00.000Z', 0, 'live_inbound', NULL, NULL),
		 ('imported', 'inbox', NULL, 'c@example.com', 'Imported', '2026-07-12T11:00:00.000Z', 0, 'admin_import', NULL, NULL),
		 ('expired', 'inbox', NULL, 'd@example.com', 'Expired', '2026-05-01T10:00:00.000Z', 0, 'live_inbound', NULL, NULL);
	`);
	const contexts = readAutomationDryRunContexts(sql, Date.parse("2026-07-12T12:00:00.000Z"));
	assert.deepEqual(contexts.map((context) => context.snapshot.messageId), ["newer", "older"]);
	assert.ok(contexts[0]?.currentInboxScope);
	assert.equal(contexts[1]?.currentInboxScope, null);
	database.close();
});

test("maximum Conversation action batch stays inside a bounded SQLite budget", (context) => {
	const { database, sql } = fixture();
	const insertedAt = "2026-07-12T10:00:00.000Z";
	const insertMessage = database.prepare(`
		INSERT INTO emails VALUES (?, 'inbox', 'thread-maximum', 'sender@example.com',
		 'Invoice', ?, 0, 'live_inbound', NULL, NULL)
	`);
	for (let message = 0; message < 200; message += 1) {
		insertMessage.run(`maximum-${message}`, insertedAt);
	}
	const insertLabel = database.prepare("INSERT INTO labels(id) VALUES (?)");
	for (let label = 0; label < 20; label += 1) insertLabel.run(`maximum-label-${label}`);
	const planning = readAutomationPlanningContext(sql, "maximum-0");
	assert.ok(planning);
	const claim = {
		id: "automation:maximum-0",
		triggerMessageId: "maximum-0",
		rulesetGeneration: 1,
		attemptCount: 1,
		leaseToken: "lease",
		leaseExpiresAt: "2026-07-12T10:05:00.000Z",
		rules: [],
	} satisfies AutomationRunClaim;
	const plan = {
		state: "applied",
		evaluatedCount: 1,
		matchedCount: 1,
		appliedCount: 22,
		stoppedByRuleId: null,
		applyLabels: Array.from({ length: 20 }, (_, label) => ({
			labelId: `maximum-label-${label}`,
			ruleId: "maximum-rule",
			ruleVersion: 1,
		})),
		star: { ruleId: "maximum-rule", ruleVersion: 1 },
		move: { folderId: "archive", ruleId: "maximum-rule", ruleVersion: 1 },
		results: [],
	} satisfies AutomationActionPlan;
	const started = performance.now();
	applyAutomationActionPlan(sql, claim, planning, plan, () => undefined);
	const elapsedMs = performance.now() - started;
	assert.equal(
		database.prepare("SELECT COUNT(*) AS count FROM email_labels").get()?.count,
		4_000,
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS count FROM emails WHERE folder_id = 'archive'").get()?.count,
		200,
	);
	assert.ok(elapsedMs < 5_000, `maximum action batch took ${elapsedMs.toFixed(1)} ms`);
	context.diagnostic(`maximum Automation action batch: ${elapsedMs.toFixed(1)} ms`);
	database.close();
});
