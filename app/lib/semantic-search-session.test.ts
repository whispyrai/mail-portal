import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxChange } from "../../shared/mailbox-change-feed.ts";
import {
	clearSemanticSearchSession,
	clearSemanticSearchSessionForMailbox,
	clearSemanticSearchSessionForMailboxChanges,
	subscribeSemanticSearchSession,
	readSemanticSearchSession,
	semanticSearchResultIdentity,
	writeSemanticSearchSession,
} from "./semantic-search-session.ts";

function change(resource: MailboxChange["resource"]): MailboxChange {
	return {
		sequence: 1,
		schemaVersion: 1,
		committedAt: "2026-07-13T10:00:00.000Z",
		resource,
		entityId: "entity-1",
		parentId: null,
		operation: "updated",
	};
}

function store() {
	writeSemanticSearchSession({
		actorEmail: "operator@example.com",
		createdAt: "2026-07-13T10:00:00.000Z",
		draftQuery: "renewal concern",
		submittedQuery: "renewal risk",
		response: {
			state: "complete",
			accessChanged: false,
			results: [],
			mailboxes: [{
				mailboxId: "mailbox-1",
				mailboxAddress: "team@example.com",
				state: "complete",
			}],
		},
		expandedResultIds: [semanticSearchResultIdentity("mailbox-1", "message-1")],
		scrollTop: 240,
	});
}

test("semantic workspace snapshots remain module-memory-only and are cloned", () => {
	clearSemanticSearchSession();
	store();
	const first = readSemanticSearchSession();
	assert.equal(first?.draftQuery, "renewal concern");
	first?.expandedResultIds.push("mutated");
	assert.equal(readSemanticSearchSession()?.expandedResultIds.length, 1);
	clearSemanticSearchSession();
	assert.equal(readSemanticSearchSession(), null);
});

test("semantic session subscribers are notified without receiving evidence payloads", () => {
	let notifications = 0;
	const unsubscribe = subscribeSemanticSearchSession(() => {
		notifications += 1;
	});
	store();
	clearSemanticSearchSession();
	unsubscribe();
	assert.equal(notifications, 2);
});

test("revocation clears cross-Mailbox evidence only when the Mailbox was represented", () => {
	store();
	assert.equal(clearSemanticSearchSessionForMailbox("other-mailbox"), false);
	assert.ok(readSemanticSearchSession());
	assert.equal(clearSemanticSearchSessionForMailbox("mailbox-1"), true);
	assert.equal(readSemanticSearchSession(), null);
});

test("content-bearing mailbox changes clear evidence while unrelated changes do not", () => {
	for (const resource of ["message", "attachment", "folder"] as const) {
		store();
		assert.equal(clearSemanticSearchSessionForMailboxChanges("mailbox-1", [change(resource)]), true);
		assert.equal(readSemanticSearchSession(), null);
	}
	store();
	assert.equal(clearSemanticSearchSessionForMailboxChanges("mailbox-1", [change("label")]), false);
	assert.ok(readSemanticSearchSession());
	clearSemanticSearchSession();
});
