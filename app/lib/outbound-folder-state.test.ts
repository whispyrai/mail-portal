import assert from "node:assert/strict";
import test from "node:test";
import {
	outboxFolderView,
	shouldLoadOutboundState,
	visibleOutboxEmails,
} from "./outbound-folder-state.ts";

test("Sent loads outbound state so a provider bounce remains visible", () => {
	assert.equal(shouldLoadOutboundState("sent"), true);
	assert.equal(shouldLoadOutboundState("outbox"), true);
	assert.equal(shouldLoadOutboundState("inbox"), false);
});

test("Outbox keeps the server's authoritative count after filtering terminal legacy rows", () => {
	const emails = [{ id: "queued" }, { id: "cancelled" }];
	const deliveries = new Map([
		["queued", { status: "queued" }],
		["cancelled", { status: "cancelled" }],
	]);
	const result = outboxFolderView(emails, deliveries, 76);
	assert.deepEqual(result, {
		emails: [{ id: "queued" }],
		totalCount: 76,
	});
});

test("a cancelled snapshot stays visible while durable recovery needs retry", () => {
	const email = { id: "outbox-recovery" };
	assert.deepEqual(
		visibleOutboxEmails(
			[email],
			new Map([[
				"outbox-recovery",
				{ status: "cancelled", cancelRecoveryPending: true },
			]]),
		),
		[email],
	);
});
