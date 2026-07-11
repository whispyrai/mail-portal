import assert from "node:assert/strict";
import test from "node:test";
import type { EnqueueOutboundCommand } from "./outbound-delivery-contract.ts";
import {
	DeliveryLeaseError,
	DuplicateRiskAcknowledgementRequiredError,
	TruthfulOutboxService,
	type OutboundDeliveryAttempt,
	type OutboundDeliveryStorage,
	type OutboundDeliveryTransaction,
	type StoredOutboundDelivery,
} from "./outbound-delivery-service.ts";

class MemoryOutboundDeliveryStorage implements OutboundDeliveryStorage {
	readonly deliveries = new Map<string, StoredOutboundDelivery>();
	readonly snapshots = new Map<string, EnqueueOutboundCommand["snapshot"]>();
	readonly attempts = new Map<string, OutboundDeliveryAttempt>();
	readonly drafts = new Map<string, number>([["draft-1", 3]]);

	transaction<T>(work: (tx: OutboundDeliveryTransaction) => T): T {
		return work(this);
	}

	findDeliveryByIdempotencyKey(key: string) {
		return (
			[...this.deliveries.values()].find(
				(delivery) => delivery.idempotencyKey === key,
			) ?? null
		);
	}

	assertSourceDraftVersion(id: string, version: number) {
		const currentVersion = this.drafts.get(id);
		if (currentVersion === undefined) return { status: "not_found" as const };
		return currentVersion === version
			? { status: "valid" as const }
			: { status: "version_conflict" as const, currentVersion };
	}

	getDelivery(id: string) {
		return this.deliveries.get(id) ?? null;
	}

	listDeliveries() {
		return [...this.deliveries.values()];
	}

	insertDelivery(delivery: StoredOutboundDelivery) {
		this.deliveries.set(delivery.id, delivery);
	}

	updateDelivery(delivery: StoredOutboundDelivery) {
		this.deliveries.set(delivery.id, delivery);
	}

	insertSnapshot(
		emailId: string,
		snapshot: EnqueueOutboundCommand["snapshot"],
	) {
		this.snapshots.set(emailId, structuredClone(snapshot));
	}

	getSnapshot(emailId: string) {
		return this.snapshots.get(emailId) ?? null;
	}

	insertAttempt(attempt: OutboundDeliveryAttempt) {
		this.attempts.set(attempt.id, attempt);
	}

	findAttemptByLease(deliveryId: string, leaseToken: string) {
		return (
			[...this.attempts.values()].find(
				(attempt) =>
					attempt.deliveryId === deliveryId &&
					attempt.leaseToken === leaseToken,
			) ?? null
		);
	}

	updateAttempt(attempt: OutboundDeliveryAttempt) {
		this.attempts.set(attempt.id, attempt);
	}
}

function command(
	overrides: Partial<EnqueueOutboundCommand> = {},
): EnqueueOutboundCommand {
	return {
		idempotencyKey: "send-click-1",
		source: "ui",
		actor: { kind: "user", id: "user-1" },
		requestedAt: "2026-07-11T10:00:00.000Z",
		undoUntil: "2026-07-11T10:00:10.000Z",
		snapshot: {
			mailboxId: "hello@example.com",
			draftId: "draft-1",
			draftVersion: 3,
			kind: "compose",
			to: ["recipient@example.com"],
			cc: [],
			bcc: [],
			from: "hello@example.com",
			subject: "Hello",
			text: "A durable snapshot",
			threadId: "thread-1",
			attachmentIds: [],
		},
		...overrides,
	};
}

function createService(
	storage = new MemoryOutboundDeliveryStorage(),
	defaultMaxAttempts = 4,
) {
	let id = 0;
	return {
		storage,
		service: new TruthfulOutboxService(storage, {
			createId: (prefix) => `${prefix}-${++id}`,
			defaultMaxAttempts,
		}),
	};
}

test("repeating a mailbox-scoped idempotency key replays one atomic enqueue", () => {
	const { service } = createService();

	const first = service.enqueue(command());
	const replay = service.enqueue(
		command({
			snapshot: { ...command().snapshot, subject: "Changed after retry" },
		}),
	);

	assert.equal(first.replayed, false);
	assert.equal(replay.replayed, true);
	assert.equal(replay.delivery.id, first.delivery.id);
	assert.equal(replay.delivery.emailId, first.delivery.emailId);
	assert.equal(replay.delivery.status, "queued");
	assert.equal(replay.snapshot.subject, "Hello");
	assert.equal(service.list().length, 1);
});

test("direct compose enqueues and sends without inventing a source draft", () => {
	const { service } = createService();
	const { draftId: _draftId, draftVersion: _draftVersion, ...directSnapshot } =
		command().snapshot;

	const enqueued = service.enqueue(
		command({ snapshot: directSnapshot as EnqueueOutboundCommand["snapshot"] }),
	);
	assert.equal(enqueued.delivery.draftId, undefined);
	assert.equal(enqueued.delivery.draftVersion, undefined);

	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);
	const sent = service.finalizeAccepted(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		"ses-message-direct",
		"2026-07-11T10:00:11.000Z",
	);
	assert.equal(sent.sourceDraftAction, "none");
});

test("enqueue rejects partial source draft linkage", () => {
	const { service } = createService();
	const { draftVersion: _draftVersion, ...missingVersion } = command().snapshot;

	assert.throws(
		() =>
			service.enqueue(
				command({
					snapshot: missingVersion as EnqueueOutboundCommand["snapshot"],
				}),
			),
		/Source draft ID and version must be provided together/,
	);
});

test("enqueue atomically rejects a source draft revision that changed after the route read it", () => {
	const { service, storage } = createService();
	storage.drafts.set("draft-1", 4);

	assert.throws(
		() => service.enqueue(command()),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "SourceDraftConflictError" &&
			error.message.includes("version_conflict"),
	);
	assert.equal(storage.deliveries.size, 0);
	assert.equal(storage.snapshots.size, 0);
});

test("undo and Send Later deadlines both gate an atomic lease claim", () => {
	const { service } = createService();
	service.enqueue(
		command({
			scheduledFor: "2026-07-11T12:00:00.000Z",
		}),
	);

	assert.equal(
		service.claimNext("2026-07-11T10:00:11.000Z", 30_000),
		null,
	);
	assert.equal(
		service.claimNext("2026-07-11T11:59:59.999Z", 30_000),
		null,
	);

	const claimed = service.claimNext(
		"2026-07-11T12:00:00.000Z",
		30_000,
	);
	assert.ok(claimed);
	assert.equal(claimed.delivery.status, "sending");
	assert.equal(claimed.delivery.attemptCount, 1);
	assert.equal(claimed.delivery.leaseExpiresAt, "2026-07-11T12:00:30.000Z");
	assert.equal(claimed.attempt.attemptNumber, 1);
	assert.equal(claimed.snapshot.subject, "Hello");
});

test("a delivery waiting for an automatic retry can still be cancelled", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext("2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(claimed);
	service.finalizeRetryableFailure(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			retryAt: "2026-07-11T10:01:00.000Z",
			code: "ses_http_429",
		},
	);
	const cancelled = service.cancel(
		claimed.delivery.id,
		{ kind: "user", id: "user-1" },
		"2026-07-11T10:00:12.000Z",
	);
	assert.equal(cancelled.delivery.status, "cancelled");
});

test("an expired sending lease becomes unknown and is never automatically reclaimed", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);

	assert.deepEqual(
		service.recoverExpiredLeases("2026-07-11T10:00:39.999Z"),
		[],
	);
	const recovered = service.recoverExpiredLeases(
		"2026-07-11T10:00:40.000Z",
	);

	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(recovered[0]?.attempt.status, "unknown");
	assert.equal(recovered[0]?.delivery.unknownAt, "2026-07-11T10:00:40.000Z");
	assert.equal(
		service.claimNext("2026-07-11T10:00:41.000Z", 30_000),
		null,
	);
});

test("a proven retryable rejection waits in retrying before a new leased attempt", () => {
	const { service } = createService();
	service.enqueue(command());
	const first = service.claimNext("2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(first);

	const retrying = service.finalizeRetryableFailure(
		first.delivery.id,
		first.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			retryAt: "2026-07-11T10:00:41.000Z",
			code: "ses_http_429",
			message: "Throttled",
			httpStatus: 429,
		},
	);

	assert.equal(retrying.delivery.status, "retrying");
	assert.equal(retrying.delivery.nextAttemptAt, "2026-07-11T10:00:41.000Z");
	assert.equal(retrying.attempt.status, "rejected_retryable");
	assert.equal(
		service.claimNext("2026-07-11T10:00:40.999Z", 30_000),
		null,
	);
	const second = service.claimNext("2026-07-11T10:00:41.000Z", 30_000);
	assert.ok(second);
	assert.equal(second.delivery.status, "sending");
	assert.equal(second.attempt.attemptNumber, 2);
});

test("a retryable rejection becomes failed when the automatic attempt budget is exhausted", () => {
	const { service } = createService(
		new MemoryOutboundDeliveryStorage(),
		1,
	);
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);

	const exhausted = service.finalizeRetryableFailure(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			retryAt: "2026-07-11T10:00:41.000Z",
			code: "ses_http_503",
			httpStatus: 503,
		},
	);

	assert.equal(exhausted.delivery.status, "failed");
	assert.equal(exhausted.delivery.nextAttemptAt, undefined);
	assert.equal(exhausted.sourceDraftAction, "retain");
});

test("only a matching lease plus SES MessageId confirms sent and consumes the source draft", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);

	assert.throws(
		() =>
			service.finalizeAccepted(
				claimed.delivery.id,
				"wrong-lease",
				"ses-message-1",
				"2026-07-11T10:00:11.000Z",
			),
		DeliveryLeaseError,
	);
	const sent = service.finalizeAccepted(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		"ses-message-1",
		"2026-07-11T10:00:11.000Z",
	);

	assert.equal(sent.delivery.status, "sent");
	assert.equal(sent.delivery.sesMessageId, "ses-message-1");
	assert.equal(sent.delivery.sentAt, "2026-07-11T10:00:11.000Z");
	assert.equal(sent.attempt.status, "accepted");
	assert.equal(sent.sourceDraftAction, "consume");
});

test("a later provider bounce is recorded separately from confirmed SES acceptance", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);
	const sent = service.finalizeAccepted(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		"ses-message-1",
		"2026-07-11T10:00:11.000Z",
	);

	const bounced = service.markBounced(sent.delivery.id, {
		at: "2026-07-11T10:05:00.000Z",
		code: "mailbox_does_not_exist",
		message: "Permanent bounce",
	});

	assert.equal(bounced.status, "bounced");
	assert.equal(bounced.sesMessageId, "ses-message-1");
	assert.equal(bounced.sentAt, "2026-07-11T10:00:11.000Z");
	assert.equal(bounced.lastErrorCode, "mailbox_does_not_exist");
});

test("cancelling queued mail prevents dispatch and retains the recoverable draft", () => {
	const { service } = createService();
	const enqueued = service.enqueue(command());

	const cancelled = service.cancel(
		enqueued.delivery.id,
		{ kind: "user", id: "user-1" },
		"2026-07-11T10:00:05.000Z",
	);

	assert.equal(cancelled.delivery.status, "cancelled");
	assert.equal(cancelled.delivery.cancelledAt, "2026-07-11T10:00:05.000Z");
	assert.equal(cancelled.sourceDraftAction, "retain");
	assert.equal(
		service.claimNext("2026-07-11T10:00:10.000Z", 30_000),
		null,
	);
});

test("a definitive failure retains the draft and an explicit retry creates a new attempt", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);

	const failed = service.finalizeDefinitiveFailure(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			code: "ses_http_400",
			message: "Rejected",
			httpStatus: 400,
		},
	);
	assert.equal(failed.delivery.status, "failed");
	assert.equal(failed.sourceDraftAction, "retain");

	const retried = service.retryFailed(
		failed.delivery.id,
		{ kind: "user", id: "user-1" },
		"2026-07-11T10:01:00.000Z",
	);
	assert.equal(retried.delivery.status, "queued");
	assert.equal(retried.sourceDraftAction, "retain");
	const second = service.claimNext("2026-07-11T10:01:00.000Z", 30_000);
	assert.ok(second);
	assert.equal(second.attempt.attemptNumber, 2);
});

test("an ambiguous outcome retains the draft and retry requires duplicate-risk acknowledgement", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);

	const unknown = service.finalizeUnknown(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			code: "transport_ambiguous",
			message: "Provider response was lost",
		},
	);
	assert.equal(unknown.delivery.status, "unknown");
	assert.equal(unknown.sourceDraftAction, "retain");
	assert.throws(
		() =>
			service.retryUnknown(
				unknown.delivery.id,
				{ kind: "user", id: "user-1" },
				false as true,
				"2026-07-11T10:01:00.000Z",
			),
		DuplicateRiskAcknowledgementRequiredError,
	);

	const retried = service.retryUnknown(
		unknown.delivery.id,
		{ kind: "user", id: "user-1" },
		true,
		"2026-07-11T10:01:00.000Z",
	);
	assert.equal(retried.delivery.status, "queued");
	assert.equal(retried.sourceDraftAction, "retain");
});

test("an authenticated provider bounce resolves an ambiguous send without retry", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = service.claimNext("2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(claimed);
	const unknown = service.finalizeUnknown(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			code: "transport_ambiguous",
		},
	);

	const bounced = service.markBounced(unknown.delivery.id, {
		at: "2026-07-11T10:01:00.000Z",
		code: "ses_bounce",
		sesMessageId: "ses-message-1",
	});
	assert.equal(bounced.status, "bounced");
	assert.equal(bounced.sesMessageId, "ses-message-1");
});
