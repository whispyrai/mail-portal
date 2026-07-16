import assert from "node:assert/strict";
import test from "node:test";
import {
	createInboundCleanupIntent,
	createInboundCleanupPreflightController,
	inboundCleanupIntentKey,
	isInboundCleanupIntent,
	persistInboundCleanupIntent,
	reconcileInboundCleanupIntents,
	type InboundDerivedContentCleanupIntent,
} from "./inbound-derived-content-cleanup-intent.ts";
import {
	INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
	resolvedRepairAttemptKey,
	type InboundDerivedContentRepairResolution,
} from "./inbound-derived-content-repair-attempt.ts";

const attemptId = "123e4567-e89b-42d3-a456-426614174000";
const fingerprint = "a".repeat(64);
const objectKey = `attachments/mail-123/${attemptId}/mail-123-0/report.pdf`;
const createdAt = "2026-07-15T00:00:00.000Z";

function intent(): InboundDerivedContentCleanupIntent {
	return createInboundCleanupIntent({
		emailId: "mail-123",
		mailboxId: "hello@wiserchat.ai",
		projectionAttemptId: attemptId,
		createdAt,
		fenceToken: "123e4567-e89b-42d3-a456-426614174001",
	});
}

function commandReadyIntent(
	commandFingerprint = fingerprint,
): InboundDerivedContentCleanupIntent {
	return {
		...intent(),
		status: "command_ready",
		revision: 1,
		commandFingerprint,
	};
}

function abandonedIntent(input?: {
	emptyObservedAt?: string | null;
	emptyObservations?: number;
}): InboundDerivedContentCleanupIntent {
	return {
		...intent(),
		status: "abandoned",
		revision: 1,
		leaseUntil: "2026-07-15T00:20:01.000Z",
		abandonedAt: "2026-07-15T00:20:01.000Z",
		emptyObservedAt: input?.emptyObservedAt ?? null,
		emptyObservations: input?.emptyObservations ?? 0,
	};
}

function repairResolution(
	commandFingerprint = fingerprint,
): InboundDerivedContentRepairResolution {
	return {
		schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
		kind: "inbound_derived_content_repair_resolution",
		status: "resolved",
		resolution: "owned",
		attempt: {
			schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
			kind: "inbound_derived_content_repair_attempt",
			status: "pending",
			attemptId,
			ingressId: "mail-123",
			mailboxId: "hello@wiserchat.ai",
			expectedGeneration: 2,
			markerId: "marker_12345678",
			commandFingerprint,
			createdAt,
			proof: { attachments: [], bodyObjects: [] },
		},
	};
}

function harness(input?: {
	manifest?: unknown;
	enqueueFailure?: boolean;
	truncatedDerived?: boolean;
	derivedList?: (options: {
		prefix: string;
		limit: number;
		cursor?: string;
	}) => {
		objects: Array<{ key: string; size: number }>;
		truncated: boolean;
		cursor?: string;
	};
}) {
	const rawObjects = new Map<string, { value: string; etag: string }>();
	const derivedObjects = new Map<string, number>();
	const deletedIntents: string[] = [];
	const enqueued: Array<{
		emailId: string;
		projectionAttemptId: string;
		objects: Array<{ r2Key: string; byteLength: number }>;
	}> = [];
	let derivedListCalls = 0;
	let mailboxGetCalls = 0;
	let revision = 0;
	const raw = {
		async list(options: { prefix: string; limit: number; cursor?: string }) {
			const keys = [...rawObjects.keys()].filter((key) => key.startsWith(options.prefix));
			const offset = Number(options.cursor ?? 0);
			const page = keys.slice(offset, offset + options.limit);
			const next = offset + page.length;
			return {
				objects: page.map((key) => ({ key })),
				truncated: next < keys.length,
				...(next < keys.length ? { cursor: String(next) } : {}),
			};
		},
		async get(key: string) {
			const stored = rawObjects.get(key);
			return stored
				? { etag: stored.etag, async text() { return stored.value; } }
				: null;
		},
		async put(
			key: string,
			value: string,
			options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
		) {
			const current = rawObjects.get(key);
			if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
			if (options?.onlyIf?.etagMatches &&
				current?.etag !== options.onlyIf.etagMatches) return null;
			revision += 1;
			rawObjects.set(key, { value, etag: `etag-${revision}` });
			return {};
		},
		async delete(key: string) {
			deletedIntents.push(key);
			rawObjects.delete(key);
		},
	};
	const env = {
		RAW_MAIL_BUCKET: raw,
		BUCKET: {
			async list(options: { prefix: string; limit: number; cursor?: string }) {
				derivedListCalls += 1;
				if (input?.derivedList) return input.derivedList(options);
				const objects = [...derivedObjects]
					.filter(([key]) => key.startsWith(options.prefix))
					.slice(0, options.limit)
					.map(([key, size]) => ({ key, size }));
				return {
					objects,
					truncated: input?.truncatedDerived ?? false,
				};
			},
		},
		MAILBOX: {
			idFromName(mailboxId: string) { return mailboxId; },
			get() {
				mailboxGetCalls += 1;
				return {
					async getInboundDerivedContentManifest() {
						return input?.manifest ?? { status: "missing" };
					},
					async enqueueUnownedInboundDerivedContentCleanup(value: {
						emailId: string;
						projectionAttemptId: string;
						objects: Array<{ r2Key: string; byteLength: number }>;
					}) {
						if (input?.enqueueFailure) throw new Error("outbox unavailable");
						enqueued.push(value);
						return { queued: value.objects.length };
					},
				};
			},
		},
	} satisfies Parameters<typeof reconcileInboundCleanupIntents>[0];
	return {
		raw,
		rawObjects,
		derivedObjects,
		deletedIntents,
		enqueued,
		env,
		get derivedListCalls() { return derivedListCalls; },
		get mailboxGetCalls() { return mailboxGetCalls; },
		seedIntent(value: InboundDerivedContentCleanupIntent) {
			rawObjects.set(
				inboundCleanupIntentKey(value.emailId, value.projectionAttemptId),
				{ value: JSON.stringify(value), etag: "seed-intent" },
			);
		},
		seedResolution(value: InboundDerivedContentRepairResolution) {
			rawObjects.set(
				resolvedRepairAttemptKey(value.attempt.ingressId, value.attempt.attemptId),
				{ value: JSON.stringify(value), etag: "seed-resolution" },
			);
		},
	};
}

test("ambiguous immutable preflight write is accepted only after an exact reread", async () => {
	const state = harness();
	const value = intent();
	const accepted = await persistInboundCleanupIntent({
		async put(key, serialized, options) {
			await state.raw.put(key, serialized, options);
			throw new Error("ambiguous transport failure");
		},
		get: state.raw.get,
	}, value);
	assert.equal(accepted, true);
});

test("cleanup-intent persistence rejects poisoned records before writing", async () => {
	let writes = 0;
	const poisoned = { ...intent(), privatePayload: "poison" };
	const accepted = await persistInboundCleanupIntent(
		{
			async get() {
				return null;
			},
			async put() {
				writes += 1;
				return {};
			},
		},
		poisoned,
	);
	assert.equal(accepted, false);
	assert.equal(writes, 0);
});

test("preflight renewal uses CAS and refuses to start an upload from an expired lease", async () => {
	const state = harness();
	const value = intent();
	state.seedIntent(value);
	const controller = createInboundCleanupPreflightController(
		state.raw,
		value,
		{ now: () => new Date("2026-07-15T00:10:00.000Z") },
	);
	await controller.renew();
	const stored = state.rawObjects.get(
		inboundCleanupIntentKey(value.emailId, value.projectionAttemptId),
	);
	assert.equal(JSON.parse(stored!.value).revision, 1);

	const expired = createInboundCleanupPreflightController(
		state.raw,
		JSON.parse(stored!.value),
		{ now: () => new Date("2026-07-15T00:31:00.000Z") },
	);
	await assert.rejects(expired.renew(), /lease expired/);
});

test("post-upload assertion and command activation accept the lease boundary but reject one millisecond after", async () => {
	for (const operation of ["assert", "activate"] as const) {
		const boundaryState = harness();
		const boundaryIntent = intent();
		boundaryState.seedIntent(boundaryIntent);
		const atBoundary = createInboundCleanupPreflightController(
			boundaryState.raw,
			boundaryIntent,
			{ now: () => new Date("2026-07-15T00:20:00.000Z") },
		);
		if (operation === "assert") await atBoundary.assertActive();
		else await atBoundary.activateCommand(fingerprint);

		const expiredState = harness();
		const expiredIntent = intent();
		expiredState.seedIntent(expiredIntent);
		const afterBoundary = createInboundCleanupPreflightController(
			expiredState.raw,
			expiredIntent,
			{ now: () => new Date("2026-07-15T00:20:00.001Z") },
		);
		if (operation === "assert") {
			await assert.rejects(afterBoundary.assertActive(), /lease expired/);
		} else {
			await assert.rejects(
				afterBoundary.activateCommand(fingerprint),
				/lease expired/,
			);
		}
	}
});

test("an expired building preflight is CAS-claimed as abandoned without cleanup in the same sweep", async () => {
	const state = harness();
	state.seedIntent(intent());
	state.derivedObjects.set(objectKey, 10);
	await reconcileInboundCleanupIntents(
		state.env,
		new Date("2026-07-15T00:20:01.000Z"),
	);
	const stored = state.rawObjects.get(inboundCleanupIntentKey("mail-123", attemptId));
	assert.equal(JSON.parse(stored!.value).status, "abandoned");
	assert.deepEqual(state.enqueued, []);
});

test("resolved projection intent is deleted without Mailbox or namespace discovery", async () => {
	const state = harness();
	state.seedIntent({
		...intent(),
		status: "projection_resolved",
		revision: 1,
	});
	await reconcileInboundCleanupIntents(
		state.env,
		new Date("2026-07-15T00:10:00.000Z"),
	);
	assert.equal(state.mailboxGetCalls, 0);
	assert.equal(state.derivedListCalls, 0);
	assert.deepEqual(state.deletedIntents, [
		inboundCleanupIntentKey("mail-123", attemptId),
	]);
});

test("cleanup intents reject metadata from other lifecycle states", () => {
	const building = intent();
	assert.equal(isInboundCleanupIntent(building), true);
	assert.equal(
		isInboundCleanupIntent({ ...building, privatePayload: "poison" }),
		false,
	);
	assert.equal(isInboundCleanupIntent({ ...building, revision: 1 }), true);
	const invalidBuilding = [
		{ ...building, abandonedAt: "2026-07-15T00:10:00.000Z" },
		{ ...building, emptyObservedAt: "2026-07-15T00:10:00.000Z" },
		{ ...building, emptyObservations: 1 },
	];
	for (const value of invalidBuilding) {
		assert.equal(isInboundCleanupIntent(value), false);
	}
	const commandReady = commandReadyIntent();
	const invalidCommandReady = [
		{ ...commandReady, abandonedAt: "2026-07-15T00:10:00.000Z" },
		{ ...commandReady, emptyObservedAt: "2026-07-15T00:10:00.000Z" },
		{ ...commandReady, emptyObservations: 1 },
	];
	for (const value of invalidCommandReady) {
		assert.equal(isInboundCleanupIntent(value), false);
	}
	assert.equal(
		isInboundCleanupIntent({ ...commandReady, revision: 0 }),
		false,
	);
	const resolved: InboundDerivedContentCleanupIntent = {
		...intent(),
		status: "projection_resolved",
		revision: 1,
	};
	const invalidResolved = [
		{ ...resolved, commandFingerprint: fingerprint },
		{ ...resolved, abandonedAt: "2026-07-15T00:10:00.000Z" },
		{ ...resolved, emptyObservedAt: "2026-07-15T00:10:00.000Z" },
		{ ...resolved, emptyObservations: 1 },
	];
	for (const value of invalidResolved) {
		assert.equal(isInboundCleanupIntent(value), false);
	}
	assert.equal(isInboundCleanupIntent({ ...resolved, revision: 0 }), false);
	assert.equal(
		isInboundCleanupIntent({ ...abandonedIntent(), commandFingerprint: fingerprint }),
		false,
	);
	assert.equal(
		isInboundCleanupIntent({ ...abandonedIntent(), revision: 0 }),
		false,
	);
	assert.equal(
		isInboundCleanupIntent({
			...abandonedIntent(),
			emptyObservedAt: "2026-07-15T00:30:00.000Z",
		}),
		false,
	);
	assert.equal(
		isInboundCleanupIntent(abandonedIntent({ emptyObservations: 1 })),
		false,
	);
	assert.equal(isInboundCleanupIntent(abandonedIntent()), true);
	assert.equal(
		isInboundCleanupIntent(abandonedIntent({
			emptyObservedAt: "2026-07-15T00:30:00.000Z",
			emptyObservations: 1,
		})),
		true,
	);
	assert.equal(
		isInboundCleanupIntent(abandonedIntent({
			emptyObservedAt: "2026-07-15T00:50:00.000Z",
			emptyObservations: 2,
		})),
		true,
	);
});

test("reconciliation cannot delete a forged resolved intent without discovery", async () => {
	const state = harness();
	const forged: InboundDerivedContentCleanupIntent = {
		...intent(),
		status: "projection_resolved",
		revision: 1,
		emptyObservedAt: "2026-07-15T00:10:00.000Z",
		emptyObservations: 1,
	};
	state.seedIntent(forged);
	await reconcileInboundCleanupIntents(
		state.env,
		new Date("2026-07-15T00:11:00.000Z"),
	);
	assert.equal(
		state.rawObjects.has(inboundCleanupIntentKey("mail-123", attemptId)),
		true,
	);
	assert.deepEqual(state.deletedIntents, []);
});

test("command-ready cleanup requires an exact command fingerprint resolution", async () => {
	const state = harness();
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution("b".repeat(64)));
	state.derivedObjects.set(objectKey, 10);
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T01:00:00.000Z"));
	assert.deepEqual(state.enqueued, []);
	assert.deepEqual(state.deletedIntents, []);
});

test("matching command resolution uses bounded list metadata and hands exact candidates to guarded cleanup", async () => {
	const state = harness({
		manifest: {
			status: "live_inbound",
			generation: 2,
			lastRepairMarkerId: "marker_12345678",
			attachments: [{ id: "attachment-1", r2Key: objectKey, byteLength: 10 }],
			bodyObjects: [],
		},
	});
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution());
	state.derivedObjects.set(objectKey, 10);
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T01:00:00.000Z"));
	assert.deepEqual(state.enqueued, [{
		emailId: "mail-123",
		projectionAttemptId: attemptId,
		objects: [{ r2Key: objectKey, byteLength: 10 }],
	}]);
	assert.deepEqual(state.deletedIntents, [inboundCleanupIntentKey("mail-123", attemptId)]);
});

test("cleanup fails closed before discovery when Mailbox manifest fields are poisoned", async () => {
	const poison = "duplicate-object-id";
	const state = harness({
		manifest: {
			status: "live_inbound",
			generation: 2,
			lastRepairMarkerId: "marker_12345678",
			attachments: [{ id: poison, r2Key: objectKey, byteLength: 10 }],
			bodyObjects: [
				{
					id: poison,
					r2Key: `email-bodies/mail-123/${attemptId}/0.body`,
					byteLength: 10,
				},
			],
		},
	});
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution());
	state.derivedObjects.set(objectKey, 10);
	const logs: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => logs.push(args);
	try {
		const result = await reconcileInboundCleanupIntents(
			state.env,
			new Date("2026-07-15T01:00:00.000Z"),
		);
		assert.deepEqual(result, { scanned: 1, accepted: 0 });
	} finally {
		console.error = originalError;
	}
	assert.equal(state.derivedListCalls, 0);
	assert.deepEqual(state.enqueued, []);
	assert.deepEqual(state.deletedIntents, []);
	assert.equal(JSON.stringify(logs).includes(poison), false);
});

test("cleanup exhausts 512 one-object pages across both exact namespaces", async () => {
	const attachmentPrefix = `attachments/mail-123/${attemptId}/`;
	const objects = Array.from({ length: 512 }, (_, index) => ({
		key: `${attachmentPrefix}mail-123-${index}/object-${index}.bin`,
		size: index + 1,
	}));
	let listCalls = 0;
	const state = harness({
		derivedList(options) {
			listCalls += 1;
			if (!options.prefix.startsWith("attachments/")) {
				return { objects: [], truncated: false };
			}
			const offset = Number(options.cursor ?? 0);
			if (offset >= objects.length) return { objects: [], truncated: false };
			return {
				objects: [objects[offset]],
				truncated: true,
				cursor: String(offset + 1),
			};
		},
	});
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution());
	await reconcileInboundCleanupIntents(
		state.env,
		new Date("2026-07-15T01:00:00.000Z"),
	);
	assert.equal(listCalls, 514);
	assert.equal(state.enqueued[0]?.objects.length, 512);
	assert.deepEqual(state.deletedIntents, [
		inboundCleanupIntentKey("mail-123", attemptId),
	]);
});

test("cleanup exhausts short pages when objects are split across both exact namespaces", async () => {
	const prefixes = [
		`attachments/mail-123/${attemptId}/`,
		`email-bodies/mail-123/${attemptId}/`,
	];
	let listCalls = 0;
	const state = harness({
		derivedList(options) {
			listCalls += 1;
			const offset = Number(options.cursor ?? 0);
			if (offset >= 256) return { objects: [], truncated: false };
			return {
				objects: [{
					key: options.prefix.startsWith("attachments/")
						? `${options.prefix}mail-123-${offset}/object-${offset}.bin`
						: `${options.prefix}${offset}.body`,
					size: 1,
				}],
				truncated: true,
				cursor: String(offset + 1),
			};
		},
	});
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution());
	await reconcileInboundCleanupIntents(
		state.env,
		new Date("2026-07-15T01:00:00.000Z"),
	);
	assert.equal(listCalls, 514);
	assert.equal(state.enqueued[0]?.objects.length, 512);
	assert.equal(
		state.enqueued[0]?.objects.every((object) =>
			prefixes.some((prefix) => object.r2Key.startsWith(prefix))),
		true,
	);
});

test("cleanup retains intents when pagination cannot prove an exhaustive bounded namespace", async () => {
	for (const testCase of [
		{
			name: "513 objects",
			derivedList(options: { prefix: string; cursor?: string }) {
				if (!options.prefix.startsWith("attachments/")) {
					return { objects: [], truncated: false };
				}
				const offset = Number(options.cursor ?? 0);
				return {
					objects: [{ key: `${options.prefix}object-${offset}.bin`, size: 1 }],
					truncated: offset < 512,
					...(offset < 512 ? { cursor: String(offset + 1) } : {}),
				};
			},
		},
		{
			name: "missing cursor",
			derivedList(options: { prefix: string }) {
				return {
					objects: [{ key: `${options.prefix}object.bin`, size: 1 }],
					truncated: true,
				};
			},
		},
		{
			name: "repeated cursor",
			derivedList(options: { prefix: string }) {
				return {
					objects: [{ key: `${options.prefix}object.bin`, size: 1 }],
					truncated: true,
					cursor: "same-cursor",
				};
			},
		},
		{
			name: "list-call cap",
			derivedList(options: { cursor?: string }) {
				const cursor = Number(options.cursor ?? 0) + 1;
				return { objects: [], truncated: true, cursor: String(cursor) };
			},
		},
	] as const) {
		const state = harness({ derivedList: testCase.derivedList });
		state.seedIntent(commandReadyIntent());
		state.seedResolution(repairResolution());
		await reconcileInboundCleanupIntents(
			state.env,
			new Date("2026-07-15T01:00:00.000Z"),
		);
		assert.equal(
			state.rawObjects.has(inboundCleanupIntentKey("mail-123", attemptId)),
			true,
			testCase.name,
		);
		assert.deepEqual(state.enqueued, [], testCase.name);
		assert.deepEqual(state.deletedIntents, [], testCase.name);
	}
});

test("truncated derived namespace and guarded cleanup failure both retain the intent", async () => {
	for (const input of [
		{ truncatedDerived: true },
		{ enqueueFailure: true },
	]) {
		const state = harness(input);
		state.seedIntent(commandReadyIntent());
		state.seedResolution(repairResolution());
		state.derivedObjects.set(objectKey, 10);
		await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T01:00:00.000Z"));
		assert.equal(
			state.rawObjects.has(inboundCleanupIntentKey("mail-123", attemptId)),
			true,
		);
	}
});

test("abandoned tombstone needs two separated empty observations and 24 hours", async () => {
	const state = harness();
	state.seedIntent(abandonedIntent());
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T00:30:00.000Z"));
	assert.deepEqual(state.deletedIntents, []);
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T00:50:00.000Z"));
	assert.deepEqual(state.deletedIntents, []);
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-16T00:50:00.000Z"));
	assert.deepEqual(state.deletedIntents, [inboundCleanupIntentKey("mail-123", attemptId)]);
});

test("a late object resets abandoned empty observations and remains guarded", async () => {
	const state = harness();
	state.seedIntent(abandonedIntent({
		emptyObservedAt: "2026-07-15T00:30:00.000Z",
		emptyObservations: 1,
	}));
	state.derivedObjects.set(objectKey, 10);
	await reconcileInboundCleanupIntents(state.env, new Date("2026-07-16T00:50:00.000Z"));
	assert.equal(state.enqueued.length, 1);
	const stored = state.rawObjects.get(inboundCleanupIntentKey("mail-123", attemptId));
	assert.equal(JSON.parse(stored!.value).emptyObservations, 0);
	assert.deepEqual(state.deletedIntents, []);
});

test("poison and failed intents never log object keys and do not block cursor progress", async () => {
	const state = harness({ enqueueFailure: true });
	state.seedIntent(commandReadyIntent());
	state.seedResolution(repairResolution());
	state.derivedObjects.set(objectKey, 10);
	const poisonKey = `${inboundCleanupIntentKey("mail-123", attemptId)}.poison`;
	state.rawObjects.set(poisonKey, { value: "not-json", etag: "poison" });
	const errors: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		await reconcileInboundCleanupIntents(state.env, new Date("2026-07-15T01:00:00.000Z"));
	} finally {
		console.error = originalError;
	}
	assert.equal(JSON.stringify(errors).includes(objectKey), false);
	assert.equal(
		state.rawObjects.has("system/derived-content-cleanup-intents/cursor.json"),
		true,
	);
});
