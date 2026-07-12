import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { OutboundMessageSnapshot } from "../lib/outbound-delivery-contract.ts";
import {
	attemptRowToStored,
	deliveryRowToStored,
	deserializeOutboundSnapshot,
	pendingAttachmentsToRows,
	serializeOutboundSnapshot,
} from "./outbound-storage.ts";

function snapshot(
	overrides: Partial<OutboundMessageSnapshot> = {},
): OutboundMessageSnapshot {
	return {
		mailboxId: "team@example.com",
		draftId: "draft-1",
		draftVersion: 4,
		kind: "reply",
		to: ["client@example.com"],
		cc: [],
		bcc: ["audit@example.com"],
		from: "team@example.com",
		subject: "Re: Proposal",
		html: "<p>Accepted</p>",
		inReplyTo: "original@example.com",
		references: ["first@example.com", "original@example.com"],
		threadId: "thread-1",
		attachmentIds: [],
		...overrides,
	};
}

test("outbound snapshots round-trip as a versioned immutable envelope", () => {
	const original = snapshot();
	const serialized = serializeOutboundSnapshot(original);
	original.subject = "Mutated after enqueue";

	const restored = deserializeOutboundSnapshot(serialized);
	assert.ok(restored);
	assert.equal(restored.subject, "Re: Proposal");
	assert.deepEqual(restored.bcc, ["audit@example.com"]);
	assert.deepEqual(restored.references, [
		"first@example.com",
		"original@example.com",
	]);

	restored.subject = "Mutated after read";
	assert.equal(deserializeOutboundSnapshot(serialized)?.subject, "Re: Proposal");
	assert.equal(deserializeOutboundSnapshot("not-json"), null);
	assert.equal(
		deserializeOutboundSnapshot(JSON.stringify([{ key: "from", value: "x" }])),
		null,
	);
});

test("direct compose snapshots round-trip without source draft linkage", () => {
	const { draftId: _draftId, draftVersion: _draftVersion, ...directCompose } =
		snapshot({ kind: "compose" });

	const restored = deserializeOutboundSnapshot(
		serializeOutboundSnapshot(
			directCompose as OutboundMessageSnapshot,
		),
	);

	assert.ok(restored);
	assert.equal(restored.draftId, undefined);
	assert.equal(restored.draftVersion, undefined);
});

test("delivery and attempt rows map nullable storage fields to service values", () => {
	const delivery = deliveryRowToStored(
		{
			id: "delivery-1",
			email_id: "email-1",
			source_draft_id: "draft-1",
			source_draft_version: 4,
			idempotency_key: "click-1",
			kind: "reply",
			source: "ui",
			actor_kind: "user",
			actor_id: "user-1",
			status: "retrying",
			available_at: "2026-07-11T10:00:10.000Z",
			undo_until: "2026-07-11T10:00:10.000Z",
			scheduled_for: null,
			next_attempt_at: "2026-07-11T10:01:00.000Z",
			attempt_count: 1,
			max_attempts: 4,
			lease_token: null,
			lease_expires_at: null,
			ses_message_id: null,
			last_error_code: "throttled",
			last_error_message: null,
			created_at: "2026-07-11T10:00:00.000Z",
			updated_at: "2026-07-11T10:00:30.000Z",
			sent_at: null,
			failed_at: null,
			unknown_at: null,
			cancelled_at: null,
		},
		"team@example.com",
	);
	assert.equal(delivery.mailboxId, "team@example.com");
	assert.equal(delivery.draftVersion, 4);
	assert.equal(delivery.nextAttemptAt, "2026-07-11T10:01:00.000Z");
	assert.equal(delivery.leaseToken, undefined);

	const attempt = attemptRowToStored({
		id: "attempt-1",
		delivery_id: "delivery-1",
		attempt_number: 1,
		status: "accepted",
		lease_token: "lease-1",
		started_at: "2026-07-11T10:00:10.000Z",
		finished_at: "2026-07-11T10:00:11.000Z",
		ses_message_id: "ses-1",
		http_status: 200,
		error_code: null,
		error_message: null,
	});
	assert.equal(attempt.status, "accepted");
	assert.equal(attempt.httpStatus, 200);
	assert.equal(attempt.errorCode, undefined);
});

test("delivery rows preserve absent source draft linkage as absent", () => {
	const delivery = deliveryRowToStored(
		{
			id: "delivery-direct",
			email_id: "email-direct",
			source_draft_id: null,
			source_draft_version: null,
			idempotency_key: "click-direct",
			kind: "compose",
			source: "api",
			actor_kind: "user",
			actor_id: "user-1",
			status: "queued",
			available_at: "2026-07-11T10:00:10.000Z",
			undo_until: "2026-07-11T10:00:10.000Z",
			scheduled_for: null,
			next_attempt_at: null,
			attempt_count: 0,
			max_attempts: 4,
			lease_token: null,
			lease_expires_at: null,
			ses_message_id: null,
			last_error_code: null,
			last_error_message: null,
			created_at: "2026-07-11T10:00:00.000Z",
			updated_at: "2026-07-11T10:00:00.000Z",
			sent_at: null,
			failed_at: null,
			unknown_at: null,
			cancelled_at: null,
		},
		"team@example.com",
	);

	assert.equal(delivery.draftId, undefined);
	assert.equal(delivery.draftVersion, undefined);
});

test("pending attachment metadata must exactly cover the immutable snapshot", () => {
	const withAttachment = snapshot({ attachmentIds: ["attachment-1"] });
	assert.deepEqual(
		pendingAttachmentsToRows("email-1", withAttachment, [
			{
				id: "attachment-1",
				email_id: "email-1",
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				size: 1234,
				content_id: null,
				disposition: "attachment",
			},
		]),
		[
			{
				id: "attachment-1",
				email_id: "email-1",
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				size: 1234,
				content_id: null,
				disposition: "attachment",
			},
		],
	);

	assert.throws(
		() => pendingAttachmentsToRows("email-1", withAttachment, []),
		/Missing pending attachment metadata/,
	);
	assert.throws(
		() =>
			pendingAttachmentsToRows("email-1", withAttachment, [
				{
					id: "attachment-1",
					email_id: "another-email",
					filename: "proposal.pdf",
					mimetype: "application/pdf",
					size: 1234,
				},
			]),
		/belongs to a different email snapshot/,
	);
});

test("pending rows preserve inline CID and erase ordinary legacy CID", () => {
	const withAttachments = snapshot({ attachmentIds: ["inline-1", "ordinary-1"] });
	const rows = pendingAttachmentsToRows("email-1", withAttachments, [
		{
			id: "inline-1",
			filename: "diagram.png",
			mimetype: "image/png",
			size: 3,
			disposition: "inline",
			contentId: "diagram@example.com",
		},
		{
			id: "ordinary-1",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 4,
			disposition: "attachment",
			content_id: "legacy-ordinary@example.com",
		},
	]);

	assert.equal(rows[0]?.content_id, "diagram@example.com");
	assert.equal(rows[1]?.content_id, null);
});

test("outbound attachment projection includes CID only for authoritative inline metadata", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/attachment\.disposition === "inline" && attachment\.content_id[\s\S]*?\{ contentId: attachment\.content_id \}/,
	);
});

test("the Durable Object validates authoritative inline mappings before outbox mutation", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/async enqueueOutbound\([\s\S]*?validateResolvedInlineImages\([\s\S]*?if \(!inlineMapping\.ok\)[\s\S]*?this\.#outboxService\(attachments, emailId\)\.enqueue\(command\)/,
	);
});

test("accepted reconciliation also finds an exact source draft after the email moved", () => {
	const source = readFileSync(
		new URL("./outbound-storage.ts", import.meta.url),
		"utf8",
	);

	assert.match(source, /source_draft\.id = .*source_draft_id/s);
	assert.match(source, /source_draft\.draft_version = .*source_draft_version/s);
});
