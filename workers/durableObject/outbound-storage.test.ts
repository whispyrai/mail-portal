import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { OutboundMessageSnapshot } from "../lib/outbound-delivery-contract.ts";
import {
	attemptRowToStored,
	deliveryRowToStored,
	deserializeOutboundSnapshot,
	isCanonicalUtcTimestamp,
	pendingAttachmentsToRows,
	serializeOutboundSnapshot,
} from "./outbound-storage.ts";

test("active outbox timestamps require exact canonical UTC milliseconds", () => {
	assert.equal(isCanonicalUtcTimestamp("2026-07-11T10:00:10.000Z"), true);
	for (const malformed of [
		"",
		"garbage",
		"2026-07-11T12:00:10.000+02:00",
		"2026-07-11T10:00:10Z",
	]) {
		assert.equal(isCanonicalUtcTimestamp(malformed), false, malformed);
	}
});

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
		attachmentByteIdentities: [],
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
	assert.equal(
		deserializeOutboundSnapshot(serialized)?.subject,
		"Re: Proposal",
	);
	assert.equal(deserializeOutboundSnapshot("not-json"), null);
	assert.equal(
		deserializeOutboundSnapshot(JSON.stringify([{ key: "from", value: "x" }])),
		null,
	);
});

test("version 1 snapshots preserve previously accepted empty reference members", () => {
	const restored = deserializeOutboundSnapshot(
		JSON.stringify({
			kind: "mail-portal/outbound-snapshot",
			version: 1,
			snapshot: {
				...snapshot({ references: [""] }),
				attachmentByteIdentities: undefined,
			},
		}),
	);

	assert.deepEqual(restored?.references, [""]);
});

test("version 1 attachment snapshots remain readable but carry no false byte proof", () => {
	const legacy = {
		...snapshot(),
		attachmentIds: ["legacy-attachment"],
		attachmentByteIdentities: undefined,
	};
	const restored = deserializeOutboundSnapshot(
		JSON.stringify({
			kind: "mail-portal/outbound-snapshot",
			version: 1,
			snapshot: legacy,
		}),
	);
	assert.deepEqual(restored?.attachmentIds, ["legacy-attachment"]);
	assert.equal(restored?.attachmentByteIdentities, undefined);
});

test("new snapshot serialization refuses attachment IDs without byte identity", () => {
	assert.throws(
		() =>
		serializeOutboundSnapshot(
				snapshot({
					attachmentIds: ["attachment-1"],
					attachmentByteIdentities: undefined,
				}),
		),
		/exact attachment byte manifest/,
	);
});

test("direct compose snapshots round-trip without source draft linkage", () => {
	const {
		draftId: _draftId,
		draftVersion: _draftVersion,
		...directCompose
	} = snapshot({ kind: "compose" });

	const restored = deserializeOutboundSnapshot(
		serializeOutboundSnapshot(directCompose as OutboundMessageSnapshot),
	);

	assert.ok(restored);
	assert.equal(restored.draftId, undefined);
	assert.equal(restored.draftVersion, undefined);
});

test("outbound snapshot hydration rejects every malformed send boundary", () => {
	const valid = snapshot({
		attachmentIds: ["attachment-1"],
		attachmentByteIdentities: [
			{
				id: "attachment-1",
				byteLength: 3,
				sha256: "a".repeat(64),
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				disposition: "attachment",
			},
		],
	});
	const malformed: Array<[string, unknown]> = [
		["mailbox", { ...valid, mailboxId: " Team@Example.com " }],
		["sender mismatch", { ...valid, from: "other@example.com" }],
		["recipient member", { ...valid, to: [123] }],
		["no recipients", { ...valid, to: [], cc: [], bcc: [] }],
		["body", { ...valid, html: 42 }],
		["references", { ...valid, references: [null] }],
		["empty v2 reference", { ...valid, references: [""] }],
		["thread", { ...valid, threadId: "" }],
		["duplicate attachment", { ...valid, attachmentIds: ["a", "a"] }],
		[
			"missing byte manifest",
			{ ...valid, attachmentByteIdentities: undefined },
		],
		[
			"byte manifest id",
		{
				...valid,
				attachmentByteIdentities: [
					{
						id: "other",
						byteLength: 3,
						sha256: "a".repeat(64),
						filename: "proposal.pdf",
						mimetype: "application/pdf",
						disposition: "attachment",
					},
				],
			},
		],
		["partial draft", { ...valid, draftVersion: undefined }],
	];

	for (const [label, value] of malformed) {
		assert.equal(
			deserializeOutboundSnapshot(
				JSON.stringify({
					kind: "mail-portal/outbound-snapshot",
					version: 2,
					snapshot: value,
				}),
			),
			null,
			label,
		);
	}
});

test("delivery and attempt rows map nullable storage fields to service values", () => {
	const row = {
			id: "delivery-1",
			email_id: "email-1",
			source_draft_id: "draft-1",
			source_draft_version: 4,
			idempotency_key: "click-1",
			command_fingerprint: "a".repeat(64),
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
			preflight_deferral_count: 3,
			cancellation_recovery_attempt_count: 2,
			retry_origin_status: "unknown",
			dispatch_phase: "provider",
			active_attempt_id: "attempt-1",
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
			accepted_attempt_count: 1,
			duplicate_acceptance_at: null,
	} as Parameters<typeof deliveryRowToStored>[0];
	const delivery = deliveryRowToStored(row, "team@example.com");
	assert.equal(delivery.mailboxId, "team@example.com");
	assert.equal(delivery.draftVersion, 4);
	assert.equal(delivery.nextAttemptAt, "2026-07-11T10:01:00.000Z");
	assert.equal(delivery.leaseToken, undefined);
	assert.equal(delivery.commandFingerprint, "a".repeat(64));
	assert.equal(delivery.preflightDeferralCount, 3);
	assert.equal(delivery.cancellationRecoveryAttemptCount, 2);
	assert.equal(delivery.retryOriginStatus, "unknown");
	assert.equal(delivery.dispatchPhase, "provider");
	assert.equal(delivery.activeAttemptId, "attempt-1");
	assert.equal(delivery.acceptedAttemptCount, 1);
	const phasePoison = deliveryRowToStored(
		{ ...row, dispatch_phase: "mystery" },
		"team@example.com",
	);
	assert.equal(phasePoison.dispatchPhase, undefined);
	assert.equal(
		phasePoison.recoveryIntegrityCode,
		"outbound_dispatch_phase_invalid",
	);
	for (const poisoned of [
		{ ...row, attempt_count: -1 },
		{ ...row, max_attempts: 0 },
		{ ...row, updated_at: "not-a-time" },
		{ ...row, retry_origin_status: "sent" },
		{ ...row, status: "sent", retry_origin_status: "unknown" },
	]) {
		assert.throws(
			() => deliveryRowToStored(poisoned, "team@example.com"),
			/Invalid core fields/,
		);
	}

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
		provider_state: "delivered",
		provider_event_at: "2026-07-11T10:00:12.000Z",
		provider_event_id: "event-1",
	});
	assert.equal(attempt.status, "accepted");
	assert.equal(attempt.httpStatus, 200);
	assert.equal(attempt.errorCode, undefined);
	assert.equal(attempt.providerState, "delivered");
	assert.equal(attempt.providerEventId, "event-1");
	const attemptPoison = attemptRowToStored({
		...({
			id: "attempt-poison",
			delivery_id: "delivery-1",
			attempt_number: 1,
			status: "mystery",
			lease_token: "lease-poison",
			started_at: "2026-07-11T10:00:10.000Z",
			finished_at: null,
			ses_message_id: null,
			http_status: null,
			error_code: null,
			error_message: null,
			provider_state: "mystery",
			provider_event_at: null,
			provider_event_id: null,
		} as Parameters<typeof attemptRowToStored>[0]),
	});
	assert.equal(attemptPoison.status, "unknown");
	assert.equal(attemptPoison.providerState, "none");
	assert.equal(
		attemptPoison.storageIntegrityCode,
		"outbound_attempt_record_invalid",
	);
});

test("delivery rows preserve absent source draft linkage as absent", () => {
	const delivery = deliveryRowToStored(
		{
			id: "delivery-direct",
			email_id: "email-direct",
			source_draft_id: null,
			source_draft_version: null,
			idempotency_key: "click-direct",
			command_fingerprint: null,
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
			preflight_deferral_count: 0,
			cancellation_recovery_attempt_count: 0,
			retry_origin_status: null,
			dispatch_phase: null,
			active_attempt_id: null,
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
			accepted_attempt_count: 0,
			duplicate_acceptance_at: null,
		},
		"team@example.com",
	);

	assert.equal(delivery.draftId, undefined);
	assert.equal(delivery.draftVersion, undefined);
});

test("pending attachment metadata must exactly cover the immutable snapshot", () => {
	const withAttachment = snapshot({
		attachmentIds: ["attachment-1"],
		attachmentByteIdentities: [
			{
				id: "attachment-1",
				byteLength: 1234,
				sha256: "a".repeat(64),
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				disposition: "attachment",
			},
		],
	});
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
				content_sha256: "a".repeat(64),
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
					filename: "changed.pdf",
					mimetype: "application/pdf",
					size: 1234,
					disposition: "attachment",
					content_sha256: "a".repeat(64),
				},
			]),
		/does not match the immutable manifest/,
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
	const withAttachments = snapshot({
		attachmentIds: ["inline-1", "ordinary-1"],
		attachmentByteIdentities: [
			{
				id: "inline-1",
				byteLength: 3,
				sha256: "a".repeat(64),
				filename: "diagram.png",
				mimetype: "image/png",
				disposition: "inline",
				contentId: "diagram@example.com",
			},
			{
				id: "ordinary-1",
				byteLength: 4,
				sha256: "b".repeat(64),
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				disposition: "attachment",
			},
		],
	});
	const rows = pendingAttachmentsToRows("email-1", withAttachments, [
		{
			id: "inline-1",
			filename: "diagram.png",
			mimetype: "image/png",
			size: 3,
			disposition: "inline",
			contentId: "diagram@example.com",
			content_sha256: "a".repeat(64),
		},
		{
			id: "ordinary-1",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 4,
			disposition: "attachment",
			content_id: "legacy-ordinary@example.com",
			content_sha256: "b".repeat(64),
		},
	]);

	assert.equal(rows[0]?.content_id, "diagram@example.com");
	assert.equal(rows[1]?.content_id, null);
});

test("outbound attachment projection includes CID only for authoritative inline metadata", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/identity\.disposition === "inline" && identity\.contentId[\s\S]*?\{ contentId: identity\.contentId \}/,
	);
});

test("the Durable Object validates authoritative inline mappings before outbox mutation", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/async #enqueueOutboundInternal\([\s\S]*?validateResolvedInlineImages\([\s\S]*?if \(!inlineMapping\.ok\)[\s\S]*?this\.#outboxService\(attachments, emailId\)\.enqueue\(\s*command/,
	);
});

test("accepted reconciliation also finds an exact source draft after the email moved", () => {
	const source = readFileSync(
		new URL("./outbound-storage.ts", import.meta.url),
		"utf8",
	);

	assert.match(source, /source_draft\.id = .*source_draft_id/s);
	assert.match(source, /source_draft\.draft_version = .*source_draft_version/s);
	assert.match(
		source,
		/WHEN .*status.* = 'sent'[\s\S]*?folder_id.*outbox[\s\S]*?source_draft\.draft_version/s,
	);
});

test("malformed active timing is selected as immediate integrity work", () => {
	const source = readFileSync(
		new URL("./outbound-storage.ts", import.meta.url),
		"utf8",
	);
	assert.match(
		source,
		/strftime\('%Y-%m-%dT%H:%M:%fZ'.*available_at.*IS NULL/s,
	);
	assert.match(
		source,
		/strftime\('%Y-%m-%dT%H:%M:%fZ'.*next_attempt_at.*IS NULL/s,
	);
	assert.match(source, /THEN '1970-01-01T00:00:00\.000Z'/);
});
