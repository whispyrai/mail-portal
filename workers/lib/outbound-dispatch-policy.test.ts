import assert from "node:assert/strict";
import test from "node:test";
import {
	cancellationRecoveryPending,
	MAILBOX_DAILY_SEND_LIMIT,
	MAILBOX_HOURLY_SEND_LIMIT,
	CANCELLED_OUTBOUND_FOLDER_ID,
	nextBulkEnqueueAt,
	planCancelledOutboundRecovery,
	planDispatchQuota,
} from "./outbound-dispatch-policy.ts";

const now = "2026-07-11T12:00:00.000Z";

test("dispatch quota counts the claimed delivery as an active reservation", () => {
	assert.deepEqual(
		planDispatchQuota({
			sentLastHour: MAILBOX_HOURLY_SEND_LIMIT - 1,
			sentLastDay: MAILBOX_HOURLY_SEND_LIMIT - 1,
			activeReservations: 1,
			now,
		}),
		{ allowed: true },
	);

	assert.deepEqual(
		planDispatchQuota({
			sentLastHour: MAILBOX_HOURLY_SEND_LIMIT,
			sentLastDay: MAILBOX_HOURLY_SEND_LIMIT,
			activeReservations: 1,
			oldestSentInHour: "2026-07-11T11:15:00.000Z",
			now,
		}),
		{
			allowed: false,
			code: "mailbox_hourly_send_limit",
			retryAt: "2026-07-11T12:15:01.000Z",
		},
	);
});

test("daily dispatch quota waits for the oldest accepted message to leave the window", () => {
	assert.deepEqual(
		planDispatchQuota({
			sentLastHour: 0,
			sentLastDay: MAILBOX_DAILY_SEND_LIMIT,
			activeReservations: 1,
			oldestSentInDay: "2026-07-10T13:00:00.000Z",
			now,
		}),
		{
			allowed: false,
			code: "mailbox_daily_send_limit",
			retryAt: "2026-07-11T13:00:01.000Z",
		},
	);
});

test("bulk cadence stays between 1.5 and 2.5 seconds even when other alarms fire", () => {
	assert.equal(nextBulkEnqueueAt(10_000, 0), 11_500);
	assert.equal(nextBulkEnqueueAt(10_000, 0.999_999), 12_499);
	assert.equal(nextBulkEnqueueAt(10_000, -1), 11_500);
	assert.equal(nextBulkEnqueueAt(10_000, 2), 12_499);
});

test("cancelling an unsaved composition recovers its immutable snapshot as a draft", () => {
	assert.deepEqual(
		planCancelledOutboundRecovery({ sourceDraftEquivalent: false }),
		{
			folderId: CANCELLED_OUTBOUND_FOLDER_ID,
			createRecoveredDraft: true,
			deleteSnapshotAttachments: false,
		},
	);
});

test("cancelling a send linked to an existing draft retains that draft and retires duplicate attachment copies", () => {
	assert.deepEqual(
		planCancelledOutboundRecovery({ sourceDraftEquivalent: true }),
		{
			folderId: CANCELLED_OUTBOUND_FOLDER_ID,
			createRecoveredDraft: false,
			deleteSnapshotAttachments: true,
		},
	);
});

test("cancelling a draft-backed send also recovers the snapshot when current draft content diverged", () => {
	assert.deepEqual(
		planCancelledOutboundRecovery({ sourceDraftEquivalent: false }),
		{
			folderId: CANCELLED_OUTBOUND_FOLDER_ID,
			createRecoveredDraft: true,
			deleteSnapshotAttachments: false,
		},
	);
});

test("the retired snapshot folder is the durable cancellation recovery marker", () => {
	assert.equal(cancellationRecoveryPending("cancelled", "outbox"), true);
	assert.equal(
		cancellationRecoveryPending("cancelled", CANCELLED_OUTBOUND_FOLDER_ID),
		false,
	);
	assert.equal(cancellationRecoveryPending("queued", "outbox"), false);
});
