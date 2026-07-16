import assert from "node:assert/strict";
import test from "node:test";
import type { EnqueueOutboundCommand } from "./outbound-delivery-contract.ts";
import {
	aggregateAcceptedAttemptProviderTruth,
	canReconcileConcurrentProviderTerminal,
	DeliveryLeaseError,
	DuplicateRiskAcknowledgementRequiredError,
	OutboundIdempotencyConflictError,
	TruthfulOutboxService,
	type DispatchableDeliveryCandidate,
	type OutboundDeliveryAttempt,
	type OutboundDeliveryStorage,
	type OutboundDeliveryTransaction,
	type StoredOutboundDelivery,
} from "./outbound-delivery-service.ts";

test("accepted attempt aggregation preserves recipient-scoped provider truth", () => {
	assert.equal(aggregateAcceptedAttemptProviderTruth([]), "unknown");
	assert.equal(aggregateAcceptedAttemptProviderTruth(["corrupt"]), "unknown");
	assert.equal(aggregateAcceptedAttemptProviderTruth(["bounced"]), "bounced");
	assert.equal(
		aggregateAcceptedAttemptProviderTruth([
			"bounced",
			"bounce_scope_unknown",
		]),
		"unknown",
	);
	for (const successful of ["none", "delivered", "complained"] as const) {
		assert.equal(
			aggregateAcceptedAttemptProviderTruth([
				"bounced",
				"bounce_scope_unknown",
				successful,
			]),
			"sent",
		);
	}
});

test("concurrent provider responses reconcile every terminal state that can own acceptance", () => {
	for (const status of ["sent", "bounced", "unknown"] as const) {
		assert.equal(canReconcileConcurrentProviderTerminal(status), true);
	}
	for (const status of ["queued", "retrying", "sending", "failed", "cancelled"] as const) {
		assert.equal(canReconcileConcurrentProviderTerminal(status), false);
	}
});

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

	findNextDispatchableCandidate(
		now: string,
	): DispatchableDeliveryCandidate | null {
		const delivery = [...this.deliveries.values()]
			.filter(
				(candidate) =>
					(candidate.status === "queued" && candidate.availableAt <= now) ||
					(candidate.status === "retrying" &&
						candidate.nextAttemptAt !== undefined &&
						candidate.nextAttemptAt <= now),
			)
			.sort(
				(a, b) =>
					(a.nextAttemptAt ?? a.availableAt).localeCompare(
						b.nextAttemptAt ?? b.availableAt,
					) || a.createdAt.localeCompare(b.createdAt),
			)[0];
		if (!delivery) return null;
		if (
			delivery.dispatchPhase !== undefined ||
			delivery.activeAttemptId !== undefined ||
			delivery.leaseToken !== undefined ||
			delivery.leaseExpiresAt !== undefined
		) {
			return {
				state: "integrity_failure",
				deliveryId: delivery.id,
				status: delivery.status as "queued" | "retrying",
				code: "outbound_dispatch_metadata_invalid",
				outcome:
					delivery.dispatchPhase === "provider" ||
					delivery.activeAttemptId !== undefined
						? "unknown"
						: "failed",
			};
		}
		return { state: "ready", delivery };
	}

	failDispatchableIntegrity(
		candidate: Extract<
			DispatchableDeliveryCandidate,
			{ state: "integrity_failure" }
		>,
		at: string,
	) {
		const delivery = this.deliveries.get(candidate.deliveryId);
		if (!delivery || delivery.status !== candidate.status) {
			throw new Error("Dispatch integrity repair lost ownership");
		}
		const failed: StoredOutboundDelivery = {
			...delivery,
			status: candidate.outcome,
			nextAttemptAt: undefined,
			dispatchPhase: undefined,
			activeAttemptId: undefined,
			leaseToken: undefined,
			leaseExpiresAt: undefined,
			failedAt: candidate.outcome === "failed" ? at : undefined,
			unknownAt: candidate.outcome === "unknown" ? at : undefined,
			updatedAt: at,
			lastErrorCode: candidate.code,
			lastErrorMessage:
				"The local dispatch record is inconsistent and cannot be sent safely.",
		};
		this.deliveries.set(failed.id, failed);
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

	listAttemptsByDelivery(deliveryId: string) {
		return [...this.attempts.values()].filter(
			(attempt) => attempt.deliveryId === deliveryId,
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
		commandFingerprint: "a".repeat(64),
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

let providerAttemptSequence = 0;

function claimProvider(
	service: TruthfulOutboxService,
	now: string,
	preflightLeaseDurationMs: number,
	providerLeaseDurationMs = 60_000,
) {
	const preflight = service.claimNextForPreflight(
		now,
		preflightLeaseDurationMs,
	);
	if (!preflight) return null;
	return service.beginProviderAttempt(
		preflight.delivery.id,
		preflight.delivery.leaseToken!,
		`attempt-test-${++providerAttemptSequence}`,
		now,
		providerLeaseDurationMs,
	);
}

test("repeating a mailbox-scoped idempotency key replays one atomic enqueue", () => {
	const { service } = createService();

	const first = service.enqueue(command());
	const replay = service.enqueue(command());

	assert.equal(first.replayed, false);
	assert.equal(replay.replayed, true);
	assert.equal(replay.delivery.id, first.delivery.id);
	assert.equal(replay.delivery.emailId, first.delivery.emailId);
	assert.equal(replay.delivery.status, "queued");
	assert.equal(replay.snapshot.subject, "Hello");
	assert.equal(service.list().length, 1);
});

test("a changed command cannot replay an existing idempotency key", () => {
	const { service } = createService();
	service.enqueue(command());

	assert.throws(
		() =>
			service.enqueue(
				command({
					commandFingerprint: "b".repeat(64),
					snapshot: { ...command().snapshot, subject: "Changed after retry" },
				}),
			),
		(error: unknown) =>
			error instanceof OutboundIdempotencyConflictError &&
			error.reason === "command_mismatch",
	);
	assert.equal(service.list().length, 1);
});

test("a legacy delivery without a fingerprint is never claimed as verified replay", () => {
	const { service, storage } = createService();
	const first = service.enqueue(command());
	storage.deliveries.set(first.delivery.id, {
		...first.delivery,
		commandFingerprint: undefined,
	});

	assert.throws(
		() => service.enqueue(command()),
		(error: unknown) =>
			error instanceof OutboundIdempotencyConflictError &&
			error.reason === "legacy_idempotency_unverifiable",
	);
});

test("a source draft revision can authorize only one delivery even when the client key changes", () => {
	const { service } = createService();
	const first = service.enqueue(command());
	const replay = service.enqueue(
		command({ idempotencyKey: "new-key-after-reload" }),
	);

	assert.equal(replay.replayed, true);
	assert.equal(replay.delivery.id, first.delivery.id);
	assert.equal(service.list().length, 1);
});

test("a cancelled source-revision replay is explicit and never masquerades as a new enqueue", () => {
	const { service } = createService();
	const first = service.enqueue(command());
	service.cancel(
		first.delivery.id,
		{ kind: "user", id: "user-1" },
		"2026-07-11T10:00:05.000Z",
	);

	const replay = service.enqueue(
		command({ idempotencyKey: "deliberate-send-after-undo" }),
	);

	assert.equal(replay.outcome, "terminal_replay");
	assert.equal(replay.delivery.status, "cancelled");
	assert.equal(replay.delivery.id, first.delivery.id);
	assert.equal(service.list().length, 1);
});

test("direct compose enqueues and sends without inventing a source draft", () => {
	const { service } = createService();
	const {
		draftId: _draftId,
		draftVersion: _draftVersion,
		...directSnapshot
	} = command().snapshot;

	const enqueued = service.enqueue(
		command({ snapshot: directSnapshot as EnqueueOutboundCommand["snapshot"] }),
	);
	assert.equal(enqueued.delivery.draftId, undefined);
	assert.equal(enqueued.delivery.draftVersion, undefined);

	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
		claimProvider(service, "2026-07-11T10:00:11.000Z", 30_000),
		null,
	);
	assert.equal(
		claimProvider(service, "2026-07-11T11:59:59.999Z", 30_000),
		null,
	);

	const claimed = claimProvider(service, "2026-07-11T12:00:00.000Z", 30_000);
	assert.ok(claimed);
	assert.equal(claimed.delivery.status, "sending");
	assert.equal(claimed.delivery.attemptCount, 1);
	assert.equal(claimed.delivery.leaseExpiresAt, "2026-07-11T12:01:00.000Z");
	assert.equal(claimed.attempt.attemptNumber, 1);
	assert.equal(claimed.snapshot.subject, "Hello");
});

test("a corrupt head snapshot fails locally and cannot block the next due send", () => {
	const { service, storage } = createService();
	const {
		draftId: _draftId,
		draftVersion: _draftVersion,
		...directSnapshot
	} = command().snapshot;
	const bad = service.enqueue(
		command({
			idempotencyKey: "bad-snapshot",
			requestedAt: "2026-07-11T09:59:59.000Z",
			undoUntil: "2026-07-11T10:00:00.000Z",
			snapshot: {
				...directSnapshot,
				subject: "Corrupt immutable snapshot",
			} as EnqueueOutboundCommand["snapshot"],
		}),
	);
	const good = service.enqueue(
		command({
			idempotencyKey: "valid-snapshot",
			requestedAt: "2026-07-11T10:00:00.000Z",
			undoUntil: "2026-07-11T10:00:01.000Z",
			snapshot: {
				...directSnapshot,
				subject: "Valid immutable snapshot",
			} as EnqueueOutboundCommand["snapshot"],
		}),
	);
	storage.snapshots.delete(bad.delivery.emailId);

	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	assert.equal(preflight.delivery.id, good.delivery.id);
	assert.equal(preflight.snapshot.subject, "Valid immutable snapshot");
	assert.equal(storage.deliveries.get(bad.delivery.id)?.status, "failed");
	assert.equal(
		storage.deliveries.get(bad.delivery.id)?.lastErrorCode,
		"outbound_snapshot_invalid",
	);
	assert.equal(storage.deliveries.get(bad.delivery.id)?.attemptCount, 0);
	assert.equal(storage.deliveries.get(bad.delivery.id)?.leaseToken, undefined);
	assert.equal(storage.attempts.size, 0);
});

test("provider-shaped dispatch metadata becomes unknown and cannot poison the due queue", () => {
	const { service, storage } = createService();
	const {
		draftId: _draftId,
		draftVersion: _draftVersion,
		...directSnapshot
	} = command().snapshot;
	const bad = service.enqueue(
		command({
			idempotencyKey: "bad-dispatch-metadata",
			requestedAt: "2026-07-11T09:59:59.000Z",
			undoUntil: "2026-07-11T10:00:00.000Z",
			snapshot: directSnapshot as EnqueueOutboundCommand["snapshot"],
		}),
	);
	const good = service.enqueue(
		command({
			idempotencyKey: "good-after-bad-metadata",
			requestedAt: "2026-07-11T10:00:00.000Z",
			undoUntil: "2026-07-11T10:00:01.000Z",
			snapshot: {
				...directSnapshot,
				subject: "Good after bad metadata",
			} as EnqueueOutboundCommand["snapshot"],
		}),
	);
	storage.deliveries.set(bad.delivery.id, {
		...bad.delivery,
		dispatchPhase: "provider",
		activeAttemptId: "missing-attempt",
	});

	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	assert.equal(preflight.delivery.id, good.delivery.id);
	assert.equal(storage.deliveries.get(bad.delivery.id)?.status, "unknown");
	assert.equal(
		storage.deliveries.get(bad.delivery.id)?.lastErrorCode,
		"outbound_dispatch_metadata_invalid",
	);
	assert.equal(storage.attempts.size, 0);
});

test("bounded poison scanning makes durable progress across alarm passes", () => {
	const { service, storage } = createService();
	const {
		draftId: _draftId,
		draftVersion: _draftVersion,
		...directSnapshot
	} = command().snapshot;
	const corrupt = Array.from(
		{
			length:
				TruthfulOutboxService.MAX_PREFLIGHT_INTEGRITY_FAILURES_PER_CLAIM + 1,
		},
		(_, index) =>
			service.enqueue(
				command({
					idempotencyKey: `corrupt-${index}`,
					requestedAt: "2026-07-11T10:00:00.000Z",
					undoUntil: "2026-07-11T10:00:01.000Z",
					snapshot: {
						...directSnapshot,
						subject: `Corrupt ${index}`,
					} as EnqueueOutboundCommand["snapshot"],
				}),
			),
	);
	for (const item of corrupt) storage.snapshots.delete(item.delivery.emailId);
	const good = service.enqueue(
		command({
			idempotencyKey: "good-after-bounded-poison",
			requestedAt: "2026-07-11T10:00:00.000Z",
			undoUntil: "2026-07-11T10:00:01.000Z",
			snapshot: {
				...directSnapshot,
				subject: "Good after bounded poison",
			} as EnqueueOutboundCommand["snapshot"],
		}),
	);

	assert.equal(
		service.claimNextForPreflight("2026-07-11T10:00:10.000Z", 30_000),
		null,
	);
	assert.equal(
		corrupt.filter(
			(item) => storage.deliveries.get(item.delivery.id)?.status === "failed",
		).length,
		TruthfulOutboxService.MAX_PREFLIGHT_INTEGRITY_FAILURES_PER_CLAIM,
	);
	const claimed = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(claimed);
	assert.equal(claimed.delivery.id, good.delivery.id);
	assert.equal(storage.attempts.size, 0);
});

test("preflight deferrals never consume the provider attempt budget", () => {
	const { service, storage } = createService(
		new MemoryOutboundDeliveryStorage(),
		4,
	);
	service.enqueue(command());
	let now = Date.parse("2026-07-11T10:00:10.000Z");
	for (let index = 0; index < 6; index += 1) {
		const at = new Date(now).toISOString();
		const preflight = service.claimNextForPreflight(at, 30_000);
		assert.ok(preflight);
		assert.equal(preflight.delivery.attemptCount, 0);
		assert.equal(preflight.delivery.dispatchPhase, "preflight");
		assert.equal(storage.attempts.size, 0);
		now += 1_000;
		const deferred = service.deferPreflight(
			preflight.delivery.id,
			preflight.delivery.leaseToken!,
			{
				at,
				retryAt: new Date(now).toISOString(),
				code: index % 2 === 0 ? "authority_check_unavailable" : "hourly_limit",
			},
		);
		assert.equal(deferred.delivery.status, "retrying");
		assert.equal(deferred.delivery.attemptCount, 0);
		assert.equal(deferred.delivery.preflightDeferralCount, index + 1);
	}

	const preflight = service.claimNextForPreflight(
		new Date(now).toISOString(),
		30_000,
	);
	assert.ok(preflight);
	const dispatch = service.beginProviderAttempt(
		preflight.delivery.id,
		preflight.delivery.leaseToken!,
		"attempt-event-1",
		new Date(now).toISOString(),
		60_000,
	);
	assert.equal(dispatch.attempt.attemptNumber, 1);
	assert.equal(dispatch.delivery.attemptCount, 1);
	assert.equal(dispatch.delivery.dispatchPhase, "provider");
	assert.equal(dispatch.delivery.activeAttemptId, dispatch.attempt.id);
	assert.equal(storage.attempts.size, 1);
});

test("permanent local preflight failure creates no provider attempt", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	const failed = service.failPreflight(
		preflight.delivery.id,
		preflight.delivery.leaseToken!,
		{
			at: "2026-07-11T10:00:11.000Z",
			code: "attachment_integrity_failed",
		},
	);
	assert.equal(failed.delivery.status, "failed");
	assert.equal(failed.delivery.attemptCount, 0);
	assert.equal(storage.attempts.size, 0);
});

test("provider finalizers cannot consume a preflight-only lease", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);

	assert.throws(
		() =>
			service.finalizeAccepted(
				preflight.delivery.id,
				preflight.delivery.leaseToken!,
				"ses-impossible",
				"2026-07-11T10:00:11.000Z",
			),
		DeliveryLeaseError,
	);
	assert.equal(storage.attempts.size, 0);
});

test("provider begin requires the exact unexpired preflight lease and extends it atomically", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	assert.throws(
		() =>
			service.beginProviderAttempt(
				preflight.delivery.id,
				"wrong-lease",
				"attempt-wrong-lease",
				"2026-07-11T10:00:11.000Z",
				60_000,
			),
		DeliveryLeaseError,
	);
	assert.equal(storage.attempts.size, 0);
	assert.throws(
		() =>
			service.beginProviderAttempt(
				preflight.delivery.id,
				preflight.delivery.leaseToken!,
				"",
				"2026-07-11T10:00:11.000Z",
				60_000,
			),
		DeliveryLeaseError,
	);

	const dispatch = service.beginProviderAttempt(
		preflight.delivery.id,
		preflight.delivery.leaseToken!,
		"attempt-exact-lease",
		"2026-07-11T10:00:39.999Z",
		60_000,
	);
	assert.equal(dispatch.delivery.leaseExpiresAt, "2026-07-11T10:01:39.999Z");
	assert.equal(dispatch.delivery.activeAttemptId, dispatch.attempt.id);
	assert.throws(
		() =>
			service.beginProviderAttempt(
				preflight.delivery.id,
				preflight.delivery.leaseToken!,
				"attempt-reused-lease",
				"2026-07-11T10:00:39.999Z",
				60_000,
			),
		DeliveryLeaseError,
	);
	assert.equal(storage.attempts.size, 1);
	storage.deliveries.set(dispatch.delivery.id, {
		...dispatch.delivery,
		activeAttemptId: "different-attempt",
	});
	assert.throws(
		() =>
			service.finalizeAccepted(
				dispatch.delivery.id,
				dispatch.attempt.leaseToken,
				"ses-mismatched-active-attempt",
				"2026-07-11T10:00:40.000Z",
			),
		DeliveryLeaseError,
	);
});

test("provider begin rejects the preflight lease at its exact expiry boundary", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);

	assert.throws(
		() =>
			service.beginProviderAttempt(
				preflight.delivery.id,
				preflight.delivery.leaseToken!,
				"attempt-expired",
				"2026-07-11T10:00:40.000Z",
				60_000,
			),
		DeliveryLeaseError,
	);
	assert.equal(storage.attempts.size, 0);
	assert.equal(storage.deliveries.get(preflight.delivery.id)?.attemptCount, 0);
});

test("provider begin rejects a preflight row that already has an active attempt", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	storage.attempts.set("attempt-existing", {
		id: "attempt-existing",
		deliveryId: preflight.delivery.id,
		attemptNumber: 1,
		status: "sending",
		leaseToken: "different-provider-lease",
		startedAt: "2026-07-11T10:00:09.000Z",
		providerState: "none",
	});

	assert.throws(
		() =>
			service.beginProviderAttempt(
				preflight.delivery.id,
				preflight.delivery.leaseToken!,
				"attempt-new",
				"2026-07-11T10:00:11.000Z",
				30_000,
			),
		DeliveryLeaseError,
	);
	assert.equal(storage.attempts.size, 1);
	assert.equal(storage.deliveries.get(preflight.delivery.id)?.attemptCount, 0);
});

test("provider begin rejects same-lease terminal and different-lease accepted attempts", () => {
	for (const existing of [
		{ lease: "same", status: "rejected_permanent" as const },
		{ lease: "other", status: "accepted" as const },
	]) {
		const { service, storage } = createService();
		service.enqueue(command());
		const preflight = service.claimNextForPreflight(
			"2026-07-11T10:00:10.000Z",
			30_000,
		);
		assert.ok(preflight);
		storage.attempts.set("attempt-existing", {
			id: "attempt-existing",
			deliveryId: preflight.delivery.id,
			attemptNumber: 1,
			status: existing.status,
			leaseToken:
				existing.lease === "same"
					? preflight.delivery.leaseToken!
					: "other-lease",
			startedAt: "2026-07-11T10:00:09.000Z",
			providerState: "none",
		});
		assert.throws(
			() =>
				service.beginProviderAttempt(
					preflight.delivery.id,
					preflight.delivery.leaseToken!,
					"attempt-new",
					"2026-07-11T10:00:11.000Z",
					30_000,
				),
			DeliveryLeaseError,
		);
	}
});

for (const safePriorStatus of ["rejected_retryable", "unknown"] as const) {
	test(`provider begin allows a prior ${safePriorStatus} attempt under another lease`, () => {
		const { service, storage } = createService();
		service.enqueue(command());
		const preflight = service.claimNextForPreflight(
			"2026-07-11T10:00:10.000Z",
			30_000,
		);
		assert.ok(preflight);
		storage.attempts.set("attempt-prior", {
			id: "attempt-prior",
			deliveryId: preflight.delivery.id,
			attemptNumber: 1,
			status: safePriorStatus,
			leaseToken: "prior-lease",
			startedAt: "2026-07-11T09:59:00.000Z",
			providerState: "none",
		});
		const begun = service.beginProviderAttempt(
			preflight.delivery.id,
			preflight.delivery.leaseToken!,
			"attempt-new",
			"2026-07-11T10:00:11.000Z",
			30_000,
		);
		assert.equal(begun.attempt.id, "attempt-new");
	});
}

test("expired preflight safely requeues while expired provider dispatch becomes unknown", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	const preflightRecovery = service.recoverExpiredLeases(
		"2026-07-11T10:00:40.000Z",
	);
	assert.equal(preflightRecovery[0]?.phase, "preflight");
	assert.equal(preflightRecovery[0]?.delivery.status, "retrying");
	assert.equal(preflightRecovery[0]?.delivery.attemptCount, 0);
	assert.equal(storage.attempts.size, 0);

	const reclaimed = service.claimNextForPreflight(
		"2026-07-11T10:00:40.000Z",
		30_000,
	);
	assert.ok(reclaimed);
	const dispatch = service.beginProviderAttempt(
		reclaimed.delivery.id,
		reclaimed.delivery.leaseToken!,
		"attempt-event-2",
		"2026-07-11T10:00:40.000Z",
		30_000,
	);
	const providerRecovery = service.recoverExpiredLeases(
		"2026-07-11T10:01:10.000Z",
	);
	assert.equal(providerRecovery[0]?.phase, "provider");
	assert.equal(providerRecovery[0]?.delivery.status, "unknown");
	assert.equal(
		providerRecovery[0]?.phase === "provider"
			? providerRecovery[0].attempt?.id
			: null,
		dispatch.attempt.id,
	);
});

test("missing provider attempt recovery becomes unknown without stalling the queue", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const dispatch = claimProvider(
		service,
		"2026-07-11T10:00:10.000Z",
		30_000,
		30_000,
	);
	assert.ok(dispatch);
	storage.attempts.clear();

	const recovered = service.recoverExpiredLeases("2026-07-11T10:00:40.000Z");
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.phase, "provider");
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(
		recovered[0]?.delivery.lastErrorCode,
		"provider_attempt_integrity_missing",
	);
	assert.equal(
		recovered[0]?.phase === "provider" ? recovered[0].attempt : null,
		undefined,
	);
});

test("invalid expired dispatch phase is unknown because provider dispatch cannot be excluded", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const dispatch = claimProvider(
		service,
		"2026-07-11T10:00:10.000Z",
		30_000,
		30_000,
	);
	assert.ok(dispatch);
	storage.deliveries.set(dispatch.delivery.id, {
		...dispatch.delivery,
		dispatchPhase: undefined,
		activeAttemptId: undefined,
		recoveryIntegrityCode: "outbound_dispatch_phase_invalid",
	});

	const recovered = service.recoverExpiredLeases("2026-07-11T10:00:40.000Z");
	assert.equal(recovered[0]?.phase, "provider");
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(
		recovered[0]?.delivery.lastErrorCode,
		"outbound_dispatch_phase_invalid",
	);
	assert.equal(
		recovered[0]?.phase === "provider" ? recovered[0].attempt?.status : null,
		"unknown",
	);
});

test("an expired preflight lease with any provider attempt becomes unknown", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	storage.attempts.set("attempt-corrupt", {
		id: "attempt-corrupt",
		deliveryId: preflight.delivery.id,
		attemptNumber: 1,
		status: "sending",
		leaseToken: preflight.delivery.leaseToken!,
		startedAt: "2026-07-11T10:00:11.000Z",
		providerState: "none",
	});

	const recovered = service.recoverExpiredLeases("2026-07-11T10:00:40.000Z");

	assert.equal(recovered[0]?.phase, "provider");
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(recovered[0]?.delivery.lastErrorCode, "lease_expired");
	assert.equal(storage.attempts.get("attempt-corrupt")?.status, "unknown");
});

test("an expired preflight lease with a different active provider lease becomes unknown", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const preflight = service.claimNextForPreflight(
		"2026-07-11T10:00:10.000Z",
		30_000,
	);
	assert.ok(preflight);
	storage.attempts.set("attempt-other-lease", {
		id: "attempt-other-lease",
		deliveryId: preflight.delivery.id,
		attemptNumber: 1,
		status: "sending",
		leaseToken: "other-lease",
		startedAt: "2026-07-11T10:00:11.000Z",
		providerState: "none",
	});

	const recovered = service.recoverExpiredLeases("2026-07-11T10:00:40.000Z");

	assert.equal(recovered[0]?.phase, "provider");
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(storage.attempts.get("attempt-other-lease")?.status, "unknown");
});

for (const missing of ["leaseToken", "leaseExpiresAt"] as const) {
	test(`malformed sending metadata without ${missing} converges to unknown`, () => {
		const { service, storage } = createService();
		service.enqueue(command());
		const dispatch = claimProvider(
			service,
			"2026-07-11T10:00:10.000Z",
			30_000,
			30_000,
		);
		assert.ok(dispatch);
		storage.deliveries.set(dispatch.delivery.id, {
			...dispatch.delivery,
			[missing]: undefined,
			recoveryIntegrityCode: "outbound_sending_lease_invalid",
		});

		const recovered = service.recoverExpiredLeases("2026-07-11T10:00:11.000Z");

		assert.equal(recovered.length, 1);
		assert.equal(recovered[0]?.phase, "provider");
		assert.equal(recovered[0]?.delivery.status, "unknown");
		assert.equal(
			recovered[0]?.delivery.lastErrorCode,
			"outbound_sending_lease_invalid",
		);
		assert.equal(
			claimProvider(service, "2026-07-11T10:00:12.000Z", 30_000),
			null,
		);
	});
}

test("a delivery waiting for an automatic retry can still be cancelled", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(claimed);

	assert.deepEqual(
		service.recoverExpiredLeases("2026-07-11T10:01:09.999Z"),
		[],
	);
	const recovered = service.recoverExpiredLeases("2026-07-11T10:01:10.000Z");

	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.delivery.status, "unknown");
	assert.equal(
		recovered[0]?.phase === "provider" ? recovered[0].attempt?.status : null,
		"unknown",
	);
	assert.equal(recovered[0]?.delivery.unknownAt, "2026-07-11T10:01:10.000Z");
	assert.equal(
		claimProvider(service, "2026-07-11T10:01:11.000Z", 30_000),
		null,
	);
});

test("a proven retryable rejection waits in retrying before a new leased attempt", () => {
	const { service } = createService();
	service.enqueue(command());
	const first = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
		claimProvider(service, "2026-07-11T10:00:40.999Z", 30_000),
		null,
	);
	const second = claimProvider(service, "2026-07-11T10:00:41.000Z", 30_000);
	assert.ok(second);
	assert.equal(second.delivery.status, "sending");
	assert.equal(second.attempt.attemptNumber, 2);
});

test("a retryable rejection becomes failed when the automatic attempt budget is exhausted", () => {
	const { service } = createService(new MemoryOutboundDeliveryStorage(), 1);
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(claimed);

	const exhausted = service.finalizeRetryableFailure(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			retryAt: "2026-07-11T10:00:41.000Z",
			code: "ses_http_429",
			httpStatus: 429,
		},
	);

	assert.equal(exhausted.delivery.status, "failed");
	assert.equal(exhausted.delivery.nextAttemptAt, undefined);
	assert.equal(exhausted.sourceDraftAction, "retain");
});

test("proven throttling rejections exhaust exactly at the fourth provider attempt", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	let now = Date.parse("2026-07-11T10:00:10.000Z");
	for (let attemptNumber = 1; attemptNumber <= 4; attemptNumber += 1) {
		const at = new Date(now).toISOString();
		const claimed = claimProvider(service, at, 30_000, 30_000);
		assert.ok(claimed);
		assert.equal(claimed.attempt.attemptNumber, attemptNumber);
		const finishedAt = new Date(now + 1_000).toISOString();
		const retryAt = new Date(now + 2_000).toISOString();
		const finalized = service.finalizeRetryableFailure(
			claimed.delivery.id,
			claimed.attempt.leaseToken,
			{
				at: finishedAt,
				retryAt,
				code: "ses_http_429",
				httpStatus: 429,
			},
		);
		assert.equal(
			finalized.delivery.status,
			attemptNumber === 4 ? "failed" : "retrying",
		);
		now += 2_000;
	}
	assert.equal(storage.attempts.size, 4);
	assert.equal(
		claimProvider(service, new Date(now).toISOString(), 30_000),
		null,
	);
});

test("only a matching lease plus SES MessageId confirms sent and consumes the source draft", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
	const { service, storage } = createService();
	const enqueued = service.enqueue(command());
	let auditedActor: StoredOutboundDelivery["actor"] | undefined;

	const cancelled = service.cancel(
		enqueued.delivery.id,
		{ kind: "user", id: "user-1" },
		"2026-07-11T10:00:05.000Z",
		(delivery) => {
			auditedActor = delivery.actor;
		},
	);

	assert.equal(cancelled.delivery.status, "cancelled");
	assert.equal(cancelled.delivery.cancelledAt, "2026-07-11T10:00:05.000Z");
	assert.equal(cancelled.delivery.nextAttemptAt, "2026-07-11T10:00:05.000Z");
	assert.equal(cancelled.delivery.cancellationRecoveryAttemptCount, 0);
	assert.deepEqual(cancelled.delivery.actor, { kind: "user", id: "user-1" });
	assert.deepEqual(storage.deliveries.get(enqueued.delivery.id)?.actor, {
		kind: "user",
		id: "user-1",
	});
	assert.deepEqual(auditedActor, { kind: "user", id: "user-1" });
	assert.equal(cancelled.sourceDraftAction, "retain");
	assert.equal(
		claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000),
		null,
	);
});

test("a definitive failure retains the draft and an explicit retry creates a new attempt", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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

	const replay = service.enqueue(
		command({ idempotencyKey: "send-after-definitive-failure" }),
	);
	assert.equal(replay.outcome, "terminal_replay");
	assert.equal(replay.delivery.status, "failed");
	assert.equal(replay.delivery.id, failed.delivery.id);
	assert.equal(storage.deliveries.size, 1);
	assert.throws(
		() =>
			service.retryFailed(
				failed.delivery.id,
				{ kind: "user", id: "user-1" },
				"2026-07-11T10:01:00.000Z",
				() => {
					throw new Error("capacity closed");
				},
			),
		/capacity closed/,
	);
	assert.equal(service.get(failed.delivery.id)?.status, "failed");

	const retried = service.retryFailed(
		failed.delivery.id,
		{ kind: "user", id: "teammate-2" },
		"2026-07-11T10:01:00.000Z",
	);
	assert.equal(retried.delivery.status, "queued");
	assert.deepEqual(retried.delivery.actor, {
		kind: "user",
		id: "teammate-2",
	});
	assert.equal(retried.sourceDraftAction, "retain");
	const second = claimProvider(service, "2026-07-11T10:01:00.000Z", 30_000);
	assert.ok(second);
	assert.equal(second.attempt.attemptNumber, 2);
});

test("an ambiguous outcome retains the draft and retry requires duplicate-risk acknowledgement", () => {
	const { service, storage } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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

	const replay = service.enqueue(
		command({ idempotencyKey: "send-after-ambiguous-outcome" }),
	);
	assert.equal(replay.outcome, "terminal_replay");
	assert.equal(replay.delivery.status, "unknown");
	assert.equal(replay.delivery.id, unknown.delivery.id);
	assert.equal(storage.deliveries.size, 1);

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
		{ kind: "user", id: "teammate-2" },
		true,
		"2026-07-11T10:01:00.000Z",
	);
	assert.equal(retried.delivery.status, "queued");
	assert.deepEqual(retried.delivery.actor, {
		kind: "user",
		id: "teammate-2",
	});
	assert.equal(retried.sourceDraftAction, "retain");
});

test("cancelling a duplicate-risk retry restores unknown truth without cancelling the accepted snapshot", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
	const retried = service.retryUnknown(
		unknown.delivery.id,
		{ kind: "user", id: "teammate-2" },
		true,
		"2026-07-11T10:01:00.000Z",
	);

	const restored = service.cancel(
		retried.delivery.id,
		{ kind: "user", id: "teammate-2" },
		"2026-07-11T10:01:05.000Z",
	);

	assert.equal(restored.delivery.status, "unknown");
	assert.equal(restored.delivery.retryOriginStatus, undefined);
	assert.equal(restored.delivery.cancelledAt, undefined);
	assert.equal(restored.delivery.unknownAt, "2026-07-11T10:00:11.000Z");
	assert.equal(
		restored.delivery.lastErrorCode,
		"outbound_retry_cancelled_restored_unknown",
	);
	assert.equal(restored.retryCancellationRestored, true);
	assert.equal(restored.sourceDraftAction, "retain");
});

test("cancelling a failed-send retry restores its failed terminal truth", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
	assert.ok(claimed);
	const failed = service.finalizeDefinitiveFailure(
		claimed.delivery.id,
		claimed.attempt.leaseToken,
		{
			at: "2026-07-11T10:00:11.000Z",
			code: "provider_rejected",
			message: "The provider rejected the message",
			httpStatus: 400,
		},
	);
	const retried = service.retryFailed(
		failed.delivery.id,
		{ kind: "user", id: "teammate-2" },
		"2026-07-11T10:01:00.000Z",
	);

	const restored = service.cancel(
		retried.delivery.id,
		{ kind: "user", id: "teammate-2" },
		"2026-07-11T10:01:05.000Z",
	);

	assert.equal(restored.delivery.status, "failed");
	assert.equal(restored.delivery.failedAt, "2026-07-11T10:00:11.000Z");
	assert.equal(
		restored.delivery.lastErrorCode,
		"outbound_retry_cancelled_restored_failed",
	);
	assert.equal(restored.retryCancellationRestored, true);
});

test("retry terminal outcomes preserve the earlier delivery truth matrix", () => {
	const makeUnknownRetry = () => {
		const created = createService(new MemoryOutboundDeliveryStorage(), 2);
		created.service.enqueue(command({ idempotencyKey: crypto.randomUUID() }));
		const first = claimProvider(
			created.service,
			"2026-07-11T10:00:10.000Z",
			30_000,
		);
		assert.ok(first);
		const unknown = created.service.finalizeUnknown(
			first.delivery.id,
			first.attempt.leaseToken,
			{
				at: "2026-07-11T10:00:11.000Z",
				code: "transport_ambiguous",
				message: "Provider response was lost",
			},
		);
		created.service.retryUnknown(
			unknown.delivery.id,
			{ kind: "user", id: "teammate-2" },
			true,
			"2026-07-11T10:01:00.000Z",
		);
		const retry = claimProvider(
			created.service,
			"2026-07-11T10:01:01.000Z",
			30_000,
		);
		assert.ok(retry);
		return { ...created, retry };
	};
	const makeFailedRetry = () => {
		const created = createService();
		created.service.enqueue(command({ idempotencyKey: crypto.randomUUID() }));
		const first = claimProvider(
			created.service,
			"2026-07-11T10:00:10.000Z",
			30_000,
		);
		assert.ok(first);
		const failed = created.service.finalizeDefinitiveFailure(
			first.delivery.id,
			first.attempt.leaseToken,
			{
				at: "2026-07-11T10:00:11.000Z",
				code: "provider_rejected",
				message: "Rejected",
				httpStatus: 400,
			},
		);
		created.service.retryFailed(
			failed.delivery.id,
			{ kind: "user", id: "teammate-2" },
			"2026-07-11T10:01:00.000Z",
		);
		const retry = claimProvider(
			created.service,
			"2026-07-11T10:01:01.000Z",
			30_000,
		);
		assert.ok(retry);
		return { ...created, retry };
	};

	const unknownAccepted = makeUnknownRetry();
	const sentAfterUnknown = unknownAccepted.service.finalizeAccepted(
		unknownAccepted.retry.delivery.id,
		unknownAccepted.retry.attempt.leaseToken,
		"ses-retry-accepted",
		"2026-07-11T10:01:02.000Z",
	).delivery;
	assert.equal(sentAfterUnknown.status, "sent");
	assert.equal(sentAfterUnknown.unknownAt, undefined);
	assert.equal(sentAfterUnknown.failedAt, undefined);

	const unknownRejected = makeUnknownRetry();
	const stillUnknown = unknownRejected.service.finalizeDefinitiveFailure(
		unknownRejected.retry.delivery.id,
		unknownRejected.retry.attempt.leaseToken,
		{
			at: "2026-07-11T10:01:02.000Z",
			code: "provider_rejected",
			message: "Rejected",
			httpStatus: 400,
		},
	).delivery;
	assert.equal(stillUnknown.status, "unknown");
	assert.equal(stillUnknown.failedAt, undefined);
	assert.equal(stillUnknown.retryOriginStatus, undefined);

	const unknownExhausted = makeUnknownRetry();
	const exhaustedUnknown = unknownExhausted.service.finalizeRetryableFailure(
		unknownExhausted.retry.delivery.id,
		unknownExhausted.retry.attempt.leaseToken,
		{
			at: "2026-07-11T10:01:02.000Z",
			retryAt: "2026-07-11T10:02:00.000Z",
			code: "throttled",
			message: "Throttled",
			httpStatus: 429,
		},
	).delivery;
	assert.equal(exhaustedUnknown.status, "unknown");
	assert.equal(exhaustedUnknown.failedAt, undefined);

	const failedAccepted = makeFailedRetry();
	const sentAfterFailed = failedAccepted.service.finalizeAccepted(
		failedAccepted.retry.delivery.id,
		failedAccepted.retry.attempt.leaseToken,
		"ses-retry-accepted",
		"2026-07-11T10:01:02.000Z",
	).delivery;
	assert.equal(sentAfterFailed.status, "sent");
	assert.equal(sentAfterFailed.failedAt, undefined);
	assert.equal(sentAfterFailed.unknownAt, undefined);

	const failedUnknown = makeFailedRetry();
	const unknownAfterFailed = failedUnknown.service.finalizeUnknown(
		failedUnknown.retry.delivery.id,
		failedUnknown.retry.attempt.leaseToken,
		{
			at: "2026-07-11T10:01:02.000Z",
			code: "transport_ambiguous",
			message: "Provider response was lost",
		},
	).delivery;
	assert.equal(unknownAfterFailed.status, "unknown");
	assert.equal(unknownAfterFailed.failedAt, undefined);
	assert.equal(unknownAfterFailed.unknownAt, "2026-07-11T10:01:02.000Z");
});

test("an authenticated provider bounce resolves an ambiguous send without retry", () => {
	const { service } = createService();
	service.enqueue(command());
	const claimed = claimProvider(service, "2026-07-11T10:00:10.000Z", 30_000);
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
