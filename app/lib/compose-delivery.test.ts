import assert from "node:assert/strict";
import test from "node:test";
import {
	composeDeliveryPersistenceKey,
	planComposeSend,
} from "./compose-delivery.ts";

const snapshot = {
	to: "person@example.com",
	cc: "",
	bcc: "",
	subject: "Report attached",
	body: "<p>I attached the report.</p>",
	attachments: [],
};

test("send planning validates recipients before attachment intent", () => {
	assert.deepEqual(
		planComposeSend({ snapshot: { ...snapshot, to: " , " } }),
		{ action: "error", message: "Add at least one recipient." },
	);
});

test("missing-attachment confirmation belongs to the exact current fingerprint", () => {
	const first = planComposeSend({ snapshot });
	assert.equal(first.action, "confirm-missing-attachment");
	if (first.action !== "confirm-missing-attachment") return;

	const confirmed = planComposeSend({
		snapshot,
		confirmedMissingAttachmentFingerprint: first.fingerprint,
	});
	assert.deepEqual(confirmed, { action: "send", attachmentRefs: [] });

	const edited = planComposeSend({
		snapshot: { ...snapshot, subject: "Updated report attached" },
		confirmedMissingAttachmentFingerprint: first.fingerprint,
	});
	assert.equal(edited.action, "confirm-missing-attachment");
});

test("delivery persistence identity is exact to draft revision and schedule", () => {
	assert.equal(
		composeDeliveryPersistenceKey({
			mailboxId: "team@example.com",
			draftId: "draft-1",
			draftVersion: 4,
			scheduledFor: "2026-08-01T09:00:00.000Z",
			mode: "reply",
			originalEmailId: "original-1",
		}),
		"mail-send:team@example.com:draft-1:4:2026-08-01T09:00:00.000Z:reply:original-1",
	);
});
