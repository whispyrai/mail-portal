import {
	projectInboundDerivedContentManifest,
	type InboundDerivedContentManifest,
} from "./inbound-projection-contract.ts";
import {
	type InboundDerivedContentCleanupProofRequest,
	validateInboundDerivedContentCleanupRequest,
} from "./inbound-derived-content-cleanup.ts";
import { readRepairAttemptResolution } from "./inbound-derived-content-repair-attempt.ts";
import {
	INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE,
	MAX_CLEANUP_INTENT_DISCOVERY_LIST_CALLS,
} from "./inbound-reconciliation-budget.ts";

export const INBOUND_CLEANUP_INTENT_SCHEMA_VERSION = 1;
export const INBOUND_CLEANUP_INTENT_BATCH_SIZE =
	INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE;
export const INBOUND_CLEANUP_INTENT_GRACE_MS = 20 * 60_000;

const PENDING_PREFIX = "system/derived-content-cleanup-intents/pending/";
const CURSOR_KEY = "system/derived-content-cleanup-intents/cursor.json";
const MAX_DISCOVERED_OBJECTS = 512;
const ABANDONED_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000;

export type InboundDerivedContentCleanupIntent = {
	schemaVersion: typeof INBOUND_CLEANUP_INTENT_SCHEMA_VERSION;
	kind: "inbound_derived_content_cleanup_intent";
	status: "abandoned" | "building" | "command_ready" | "projection_resolved";
	emailId: string;
	mailboxId: string;
	projectionAttemptId: string;
	revision: number;
	fenceToken: string;
	leaseUntil: string;
	commandFingerprint: string | null;
	abandonedAt: string | null;
	emptyObservedAt: string | null;
	emptyObservations: number;
	createdAt: string;
};

const CLEANUP_INTENT_KEYS = [
	"abandonedAt",
	"commandFingerprint",
	"createdAt",
	"emailId",
	"emptyObservations",
	"emptyObservedAt",
	"fenceToken",
	"kind",
	"leaseUntil",
	"mailboxId",
	"projectionAttemptId",
	"revision",
	"schemaVersion",
	"status",
] as const;

type CleanupIntentR2Object = { etag?: string; text(): Promise<string> };

export type InboundCleanupIntentBucket = {
	get(key: string): Promise<CleanupIntentR2Object | null>;
	put(
		key: string,
		value: string,
		options?: {
			httpMetadata?: { contentType: string };
			customMetadata?: Record<string, string>;
			onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
		},
	): Promise<unknown | null>;
	delete(key: string): Promise<unknown>;
};

export type InboundCleanupIntentPreflightBucket = Pick<
	InboundCleanupIntentBucket,
	"get" | "put"
>;

type ReconciliationBucket = InboundCleanupIntentBucket & {
	list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
		objects: Array<{ key: string }>;
		truncated: boolean;
		cursor?: string;
	}>;
};

type DerivedBucket = {
	list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
		objects: Array<{ key: string; size: number }>;
		truncated: boolean;
		cursor?: string;
	}>;
};

export function inboundCleanupIntentKey(
	emailId: string,
	projectionAttemptId: string,
): string {
	return `${PENDING_PREFIX}${encodeURIComponent(emailId)}/${projectionAttemptId}.json`;
}

function namespacePrefixes(intent: InboundDerivedContentCleanupIntent) {
	return [
		`attachments/${intent.emailId}/${intent.projectionAttemptId}/`,
		`email-bodies/${intent.emailId}/${intent.projectionAttemptId}/`,
	];
}

export function createInboundCleanupIntent(input: {
	emailId: string;
	mailboxId: string;
	projectionAttemptId: string;
	createdAt?: string;
	fenceToken?: string;
}): InboundDerivedContentCleanupIntent {
	const createdAt = input.createdAt ?? new Date().toISOString();
	validateInboundDerivedContentCleanupRequest({
		emailId: input.emailId,
		projectionAttemptId: input.projectionAttemptId,
		keys: [`email-bodies/${input.emailId}/${input.projectionAttemptId}/0.body`],
	});
	if (!input.mailboxId || input.mailboxId.length > 320) {
		throw new Error("Inbound cleanup intent mailbox is invalid");
	}
	return {
		schemaVersion: INBOUND_CLEANUP_INTENT_SCHEMA_VERSION,
		kind: "inbound_derived_content_cleanup_intent",
		status: "building",
		emailId: input.emailId,
		mailboxId: input.mailboxId,
		projectionAttemptId: input.projectionAttemptId,
		revision: 0,
		fenceToken: input.fenceToken ?? crypto.randomUUID(),
		leaseUntil: new Date(
			Date.parse(createdAt) +
				INBOUND_CLEANUP_INTENT_GRACE_MS,
		).toISOString(),
		commandFingerprint: null,
		abandonedAt: null,
		emptyObservedAt: null,
		emptyObservations: 0,
		createdAt,
	};
}

export function isInboundCleanupIntent(
	value: unknown,
): value is InboundDerivedContentCleanupIntent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== CLEANUP_INTENT_KEYS.length ||
		!Object.keys(record).every((key) =>
			CLEANUP_INTENT_KEYS.some((candidate) => candidate === key),
		) ||
		record.schemaVersion !== INBOUND_CLEANUP_INTENT_SCHEMA_VERSION ||
		record.kind !== "inbound_derived_content_cleanup_intent" ||
		!(["abandoned", "building", "command_ready", "projection_resolved"] as const).includes(record.status as never) ||
		typeof record.emailId !== "string" ||
		typeof record.mailboxId !== "string" ||
		!record.mailboxId ||
		record.mailboxId.length > 320 ||
		typeof record.projectionAttemptId !== "string" ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision as number) < 0 ||
		typeof record.fenceToken !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(record.fenceToken) ||
		typeof record.leaseUntil !== "string" ||
		!Number.isFinite(Date.parse(record.leaseUntil)) ||
		!(record.commandFingerprint === null ||
			(typeof record.commandFingerprint === "string" && /^[a-f0-9]{64}$/.test(record.commandFingerprint))) ||
		!(record.abandonedAt === null ||
			(typeof record.abandonedAt === "string" && Number.isFinite(Date.parse(record.abandonedAt)))) ||
		!(record.emptyObservedAt === null ||
			(typeof record.emptyObservedAt === "string" && Number.isFinite(Date.parse(record.emptyObservedAt)))) ||
		!Number.isSafeInteger(record.emptyObservations) ||
		(record.emptyObservations as number) < 0 ||
		(record.emptyObservations as number) > 2 ||
		typeof record.createdAt !== "string" ||
		!Number.isFinite(Date.parse(record.createdAt))
	) return false;
	try {
		createInboundCleanupIntent({
			emailId: record.emailId,
			mailboxId: record.mailboxId,
			projectionAttemptId: record.projectionAttemptId,
			createdAt: record.createdAt,
			fenceToken: record.fenceToken,
		});
		const hasNoAbandonmentMetadata =
			record.abandonedAt === null &&
			record.emptyObservedAt === null &&
			record.emptyObservations === 0;
		return (
			(record.status === "building" || (record.revision as number) >= 1) &&
			(record.status !== "building" ||
				(record.commandFingerprint === null && hasNoAbandonmentMetadata)) &&
			(record.status !== "command_ready" ||
				(record.commandFingerprint !== null && hasNoAbandonmentMetadata)) &&
			(record.status !== "projection_resolved" ||
				(record.commandFingerprint === null && hasNoAbandonmentMetadata)) &&
			(record.status !== "abandoned" ||
				(record.commandFingerprint === null &&
					record.abandonedAt !== null &&
					((record.emptyObservations === 0 && record.emptyObservedAt === null) ||
						((record.emptyObservations as number) > 0 &&
							record.emptyObservedAt !== null))))
		);
	} catch {
		return false;
	}
}

function projectInboundCleanupIntent(
	intent: InboundDerivedContentCleanupIntent,
): InboundDerivedContentCleanupIntent {
	return {
		schemaVersion: intent.schemaVersion,
		kind: intent.kind,
		status: intent.status,
		emailId: intent.emailId,
		mailboxId: intent.mailboxId,
		projectionAttemptId: intent.projectionAttemptId,
		revision: intent.revision,
		fenceToken: intent.fenceToken,
		leaseUntil: intent.leaseUntil,
		commandFingerprint: intent.commandFingerprint,
		abandonedAt: intent.abandonedAt,
		emptyObservedAt: intent.emptyObservedAt,
		emptyObservations: intent.emptyObservations,
		createdAt: intent.createdAt,
	};
}

async function readJson(
	bucket: Pick<InboundCleanupIntentBucket, "get">,
	key: string,
) {
	const object = await bucket.get(key);
	if (!object) return null;
	try {
		return { object, value: JSON.parse(await object.text()) as unknown };
	} catch {
		return { object, value: null };
	}
}

export async function persistInboundCleanupIntent(
	bucket: InboundCleanupIntentPreflightBucket,
	intent: InboundDerivedContentCleanupIntent,
): Promise<boolean> {
	if (!isInboundCleanupIntent(intent)) return false;
	const projectedIntent = projectInboundCleanupIntent(intent);
	const key = inboundCleanupIntentKey(intent.emailId, intent.projectionAttemptId);
	const serialized = JSON.stringify(projectedIntent);
	try {
		await bucket.put(key, serialized, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: {
				emailId: intent.emailId,
				mailboxId: intent.mailboxId,
				projectionAttemptId: intent.projectionAttemptId,
				status: "building",
			},
			onlyIf: { etagDoesNotMatch: "*" },
		});
	} catch {
		// An ambiguous response may hide a successful immutable creation.
	}
	try {
		const stored = await readJson(bucket, key);
		return Boolean(
			stored &&
			isInboundCleanupIntent(stored.value) &&
			JSON.stringify(stored.value) === serialized,
		);
	} catch {
		return false;
	}
}

async function transitionInboundCleanupIntent(
	bucket: InboundCleanupIntentPreflightBucket,
	current: InboundDerivedContentCleanupIntent,
	transition: (current: InboundDerivedContentCleanupIntent) => InboundDerivedContentCleanupIntent,
) {
	const key = inboundCleanupIntentKey(current.emailId, current.projectionAttemptId);
	const stored = await readJson(bucket, key);
	if (
		!stored?.object.etag ||
		!isInboundCleanupIntent(stored.value) ||
		JSON.stringify(stored.value) !== JSON.stringify(current)
	) throw new Error("Inbound cleanup preflight fence was lost");
	const next = transition(current);
	if (!isInboundCleanupIntent(next) || next.revision !== current.revision + 1) {
		throw new Error("Inbound cleanup preflight transition is invalid");
	}
	const projectedNext = projectInboundCleanupIntent(next);
	const serialized = JSON.stringify(projectedNext);
	try {
		await bucket.put(key, serialized, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: {
				emailId: current.emailId,
				mailboxId: current.mailboxId,
				projectionAttemptId: current.projectionAttemptId,
				status: next.status,
			},
			onlyIf: { etagMatches: stored.object.etag },
		});
	} catch {
		// An ambiguous CAS is accepted only through the exact reread below.
	}
	const confirmed = await readJson(bucket, key);
	if (
		!confirmed ||
		!isInboundCleanupIntent(confirmed.value) ||
		JSON.stringify(confirmed.value) !== serialized
	) throw new Error("Inbound cleanup preflight transition was not committed");
	return projectedNext;
}

export function createInboundCleanupPreflightController(
	bucket: InboundCleanupIntentPreflightBucket,
	initial: InboundDerivedContentCleanupIntent,
	runtime: { now(): Date } = { now: () => new Date() },
) {
	if (!isInboundCleanupIntent(initial)) {
		throw new Error("Inbound cleanup preflight is invalid");
	}
	let state = projectInboundCleanupIntent(initial);
	let chain = Promise.resolve();
	const run = <T>(operation: () => Promise<T>) => {
		const result = chain.then(operation);
		chain = result.then(() => undefined, () => undefined);
		return result;
	};
	return {
		get attemptId() { return state.projectionAttemptId; },
		renew() {
			return run(async () => {
				if (state.status !== "building") throw new Error("Repair preflight is not writable");
				if (runtime.now().getTime() > Date.parse(state.leaseUntil)) {
					throw new Error("Repair preflight lease expired");
				}
				state = await transitionInboundCleanupIntent(bucket, state, (current) => ({
					...current,
					revision: current.revision + 1,
					leaseUntil: new Date(
						runtime.now().getTime() + INBOUND_CLEANUP_INTENT_GRACE_MS,
					).toISOString(),
				}));
			});
		},
		assertActive() {
			return run(async () => {
				const stored = await readJson(
					bucket,
					inboundCleanupIntentKey(state.emailId, state.projectionAttemptId),
				);
				if (
					!stored ||
					!isInboundCleanupIntent(stored.value) ||
					stored.value.status !== "building" ||
					stored.value.fenceToken !== state.fenceToken
				) throw new Error("Repair preflight fence was lost");
				if (runtime.now().getTime() > Date.parse(stored.value.leaseUntil)) {
					throw new Error("Repair preflight lease expired");
				}
				state = stored.value;
			});
		},
		activateCommand(commandFingerprint: string) {
			return run(async () => {
				if (state.status !== "building") throw new Error("Repair preflight is not writable");
				if (runtime.now().getTime() > Date.parse(state.leaseUntil)) {
					throw new Error("Repair preflight lease expired");
				}
				state = await transitionInboundCleanupIntent(bucket, state, (current) => ({
					...current,
					status: "command_ready",
					revision: current.revision + 1,
					commandFingerprint,
				}));
			});
		},
		resolveProjection() {
			return run(async () => {
				if (state.status !== "building") {
					throw new Error("Projection preflight is not writable");
				}
				if (runtime.now().getTime() > Date.parse(state.leaseUntil)) {
					throw new Error("Projection preflight lease expired");
				}
				state = await transitionInboundCleanupIntent(bucket, state, (current) => ({
					...current,
					status: "projection_resolved",
					revision: current.revision + 1,
				}));
			});
		},
		abandon() {
			return run(async () => {
				if (state.status === "abandoned") return true;
				if (state.status !== "building") return false;
				const abandonedAt = runtime.now().toISOString();
				state = await transitionInboundCleanupIntent(bucket, state, (current) => ({
					...current,
					status: "abandoned",
					revision: current.revision + 1,
					abandonedAt,
					leaseUntil: abandonedAt,
				}));
				return true;
			});
		},
	};
}

async function readCursor(bucket: ReconciliationBucket) {
	const stored = await readJson(bucket, CURSOR_KEY);
	const value = stored?.value;
	return {
		...(value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).cursor === "string"
			? { cursor: (value as Record<string, unknown>).cursor as string }
			: {}),
		...(stored?.object.etag ? { etag: stored.object.etag } : {}),
	};
}

function manifestProof(
	manifest: Extract<InboundDerivedContentManifest, { status: "live_inbound" }>,
) {
	return new Map([
		...manifest.attachments.map((item) => [item.r2Key, item.byteLength] as const),
		...manifest.bodyObjects.map((item) => [item.r2Key, item.byteLength] as const),
	]);
}

async function discoverAttemptObjects(
	bucket: DerivedBucket,
	intent: InboundDerivedContentCleanupIntent,
) {
	const objects: Array<{ key: string; size: number }> = [];
	const objectKeys = new Set<string>();
	let listCalls = 0;
	for (const prefix of namespacePrefixes(intent)) {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (;;) {
			if (listCalls >= MAX_CLEANUP_INTENT_DISCOVERY_LIST_CALLS) {
				throw new Error("Derived-content cleanup listing exceeded its call bound");
			}
			listCalls += 1;
			const page = await bucket.list({
				prefix,
				limit: MAX_DISCOVERED_OBJECTS + 1,
				...(cursor ? { cursor } : {}),
			});
			for (const object of page.objects) {
				if (objectKeys.has(object.key)) {
					throw new Error("Derived-content cleanup listing did not make progress");
				}
				objectKeys.add(object.key);
				objects.push(object);
				if (objects.length > MAX_DISCOVERED_OBJECTS) {
					throw new Error("Derived-content cleanup namespace exceeds its bound");
				}
			}
			if (!page.truncated) break;
			if (
				typeof page.cursor !== "string" ||
				page.cursor.length === 0 ||
				page.cursor === cursor ||
				seenCursors.has(page.cursor)
			) {
				throw new Error("Derived-content cleanup listing cursor did not advance");
			}
			seenCursors.add(page.cursor);
			cursor = page.cursor;
		}
	}
	if (objects.length > 0) {
		validateInboundDerivedContentCleanupRequest({
			emailId: intent.emailId,
			projectionAttemptId: intent.projectionAttemptId,
			keys: objects.map((object) => object.key),
		});
	}
	return objects;
}

export async function reconcileInboundCleanupIntents(env: {
	RAW_MAIL_BUCKET: ReconciliationBucket;
	BUCKET: DerivedBucket;
	MAILBOX: {
		idFromName(mailboxId: string): unknown;
		get(id: unknown): {
			getInboundDerivedContentManifest?(emailId: string): Promise<unknown>;
			enqueueUnownedInboundDerivedContentCleanup?(input: InboundDerivedContentCleanupProofRequest): Promise<unknown>;
		};
	};
}, now: Date = new Date()) {
	const cursorState = await readCursor(env.RAW_MAIL_BUCKET);
	const page = await env.RAW_MAIL_BUCKET.list({
		prefix: PENDING_PREFIX,
		limit: INBOUND_CLEANUP_INTENT_BATCH_SIZE,
		...(cursorState.cursor ? { cursor: cursorState.cursor } : {}),
	});
	let accepted = 0;
	for (const object of page.objects) {
		if (!object.key.startsWith(PENDING_PREFIX)) continue;
		try {
			const stored = await readJson(env.RAW_MAIL_BUCKET, object.key);
			if (!stored || !isInboundCleanupIntent(stored.value)) {
				console.error("[mail-reconciliation] malformed cleanup intent remains pending", {
					errorCode: "INBOUND_CLEANUP_INTENT_INVALID",
					operation: "cleanup_intent_reconcile",
					status: "pending",
				});
				continue;
			}
			const intent = stored.value;
			if (
				object.key !== inboundCleanupIntentKey(intent.emailId, intent.projectionAttemptId)
			) continue;
			if (intent.status === "projection_resolved") {
				await env.RAW_MAIL_BUCKET.delete(object.key);
				accepted += 1;
				continue;
			}
			let terminalIntent = intent;
			if (intent.status === "building") {
				if (now.getTime() <= Date.parse(intent.leaseUntil)) continue;
				const abandonedAt = now.toISOString();
				await transitionInboundCleanupIntent(
					env.RAW_MAIL_BUCKET,
					intent,
					(current) => ({
						...current,
						status: "abandoned",
						revision: current.revision + 1,
						abandonedAt,
						leaseUntil: abandonedAt,
					}),
				);
				continue;
			}
			if (intent.status === "command_ready") {
				const resolution = await readRepairAttemptResolution(
					env.RAW_MAIL_BUCKET,
					intent.emailId,
					intent.projectionAttemptId,
					intent.commandFingerprint!,
				);
				if (!resolution) continue;
			}
			const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(intent.mailboxId));
			if (
				!mailbox.getInboundDerivedContentManifest ||
				!mailbox.enqueueUnownedInboundDerivedContentCleanup
			) continue;
			const manifest = projectInboundDerivedContentManifest(
				await mailbox.getInboundDerivedContentManifest(intent.emailId),
				intent.emailId,
			);
			if (!manifest) throw new Error("Mailbox derived-content manifest is invalid");
			const objects = await discoverAttemptObjects(env.BUCKET, intent);
			const keys = objects.map((object) => object.key);
			const committed = manifest.status === "live_inbound"
				? manifestProof(manifest)
				: new Map<string, number>();
			for (const object of objects) {
				const committedLength = committed.get(object.key);
				if (committedLength !== undefined && object.size !== committedLength) {
					throw new Error("Committed derived-content proof is unavailable");
				}
			}
			for (const [key] of committed) {
				if (namespacePrefixes(intent).some((prefix) => key.startsWith(prefix)) &&
					!keys.includes(key)) {
					throw new Error("Committed derived-content namespace listing is incomplete");
				}
			}
			if (keys.length > 0) {
				await mailbox.enqueueUnownedInboundDerivedContentCleanup({
					emailId: intent.emailId,
					projectionAttemptId: intent.projectionAttemptId,
					objects: objects.map((object) => ({
						r2Key: object.key,
						byteLength: object.size,
					})),
				});
			}
			if (terminalIntent.status === "command_ready") {
				await env.RAW_MAIL_BUCKET.delete(object.key);
				accepted += 1;
				continue;
			}
			if (keys.length > 0) {
				if (terminalIntent.emptyObservations > 0) {
					await transitionInboundCleanupIntent(
						env.RAW_MAIL_BUCKET,
						terminalIntent,
						(current) => ({
							...current,
							revision: current.revision + 1,
							emptyObservedAt: null,
							emptyObservations: 0,
						}),
					);
				}
				continue;
			}
			if (
				terminalIntent.emptyObservedAt &&
				now.getTime() - Date.parse(terminalIntent.emptyObservedAt) <
					INBOUND_CLEANUP_INTENT_GRACE_MS
			) continue;
			terminalIntent = await transitionInboundCleanupIntent(
				env.RAW_MAIL_BUCKET,
				terminalIntent,
				(current) => ({
					...current,
					revision: current.revision + 1,
					emptyObservedAt: now.toISOString(),
					emptyObservations: Math.min(2, current.emptyObservations + 1),
				}),
			);
			if (
				terminalIntent.emptyObservations >= 2 &&
				terminalIntent.abandonedAt &&
				now.getTime() - Date.parse(terminalIntent.abandonedAt) >=
					ABANDONED_TOMBSTONE_RETENTION_MS
			) {
				await env.RAW_MAIL_BUCKET.delete(object.key);
				accepted += 1;
			}
		} catch {
			console.error("[mail-reconciliation] cleanup intent remains pending", {
				errorCode: "INBOUND_CLEANUP_INTENT_RECONCILIATION_FAILED",
				operation: "cleanup_intent_reconcile",
				status: "pending",
			});
		}
	}
	if (page.truncated && !page.cursor) {
		throw new Error("R2 returned a truncated cleanup-intent page without a cursor");
	}
	await env.RAW_MAIL_BUCKET.put(
		CURSOR_KEY,
		JSON.stringify({
			cursor: page.truncated ? page.cursor : null,
			updatedAt: now.toISOString(),
		}),
		{
			onlyIf: cursorState.etag
				? { etagMatches: cursorState.etag }
				: { etagDoesNotMatch: "*" },
		},
	);
	return { scanned: page.objects.length, accepted };
}
