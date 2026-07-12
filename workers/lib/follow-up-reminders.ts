import { z } from "zod";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";

export type FollowUpReminderErrorCode =
	| "INVALID"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "ACTIVE_CONFLICT"
	| "STATE_CONFLICT"
	| "IDEMPOTENCY_CONFLICT";

export class FollowUpReminderError extends Error {
	readonly code: FollowUpReminderErrorCode;

	constructor(code: FollowUpReminderErrorCode, message: string) {
		super(message);
		this.name = "FollowUpReminderError";
		this.code = code;
	}
}

const boundedId = z.string().trim().min(1).max(300);
const operationId = z.string().trim().min(8).max(200);
const isoInstant = z.string().max(40).refine(
	(value) =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
		Number.isFinite(Date.parse(value)),
	"A valid timestamp with an explicit offset is required",
);

const CreateReminderSchema = z.object({
	emailId: boundedId,
	remindAt: isoInstant,
	idempotencyKey: operationId,
}).strict();

const MutationBase = z.object({
	operationId,
	expectedVersion: z.number().int().min(1),
});

const ReminderOperationSchema = z.discriminatedUnion("action", [
	MutationBase.extend({ action: z.literal("dismiss") }).strict(),
	MutationBase.extend({ action: z.literal("complete") }).strict(),
	MutationBase.extend({ action: z.literal("snooze"), remindAt: isoInstant }).strict(),
]);

export type ReminderOperation = z.infer<typeof ReminderOperationSchema>;

export interface AuthoritativeReminderAnchor {
	conversationKey: string;
	baselineMessageId: string;
	baselineMessageDate: string;
}

/** Created only from a successfully persisted inbound mailbox row. */
export interface StoredInboundReply {
	mailboxAddress: string;
	conversationKey: string;
	inboundMessageId: string;
	inboundMessageDate: string;
}

export interface ReminderStoreOperation {
	ownerUserId: string;
	mailboxAddress: string;
	reminderId: string;
	operationId: string;
	expectedVersion: number;
	action: "dismiss" | "complete" | "snooze";
	remindAt?: string;
	fingerprint: string;
	occurredAt: number;
}

export type ReminderStoreMutationResult =
	| { status: "applied" | "replayed"; reminder: FollowUpReminder }
	| { status: "forbidden" | "not_found" | "idempotency_conflict" }
	| { status: "state_conflict"; reminder: FollowUpReminder };

export type FollowUpReminderStoreCursor = {
	remindAt: number;
	id: string;
};

export type FollowUpReminderStorePage = {
	reminders: FollowUpReminder[];
	nextCursor: FollowUpReminderStoreCursor | null;
};

export interface FollowUpReminderStore {
	list(input: {
		ownerUserId: string;
		mailboxAddress: string;
		limit: number;
		cursor: FollowUpReminderStoreCursor | null;
	}): Promise<FollowUpReminderStorePage>;
	findCreateReplay(input: {
		ownerUserId: string;
		idempotencyKey: string;
		fingerprint: string;
	}): Promise<
		| { status: "replayed"; reminder: FollowUpReminder }
		| { status: "idempotency_conflict" }
		| null
	>;
	createOrReplay(input: {
		row: FollowUpReminder;
		idempotencyKey: string;
		fingerprint: string;
	}): Promise<
		| { status: "created" | "replayed"; reminder: FollowUpReminder }
		| { status: "active_conflict"; reminder: FollowUpReminder }
		| { status: "forbidden" | "idempotency_conflict" }
	>;
	applyOperation(input: ReminderStoreOperation): Promise<ReminderStoreMutationResult>;
	completeForInboundReply(input: {
		mailboxAddress: string;
		conversationKey: string;
		inboundMessageId: string;
		inboundMessageDate: string;
		occurredAt: number;
	}): Promise<number>;
}

export interface FollowUpReminderServiceDependencies {
	store: FollowUpReminderStore;
	canAccessMailbox(userId: string, mailboxAddress: string): Promise<boolean>;
	resolveReminderAnchor(
		mailboxAddress: string,
		emailId: string,
	): Promise<AuthoritativeReminderAnchor | null>;
	now?: () => number;
	id?: () => string;
}

function oneYearHorizon(now: number) {
	const horizon = new Date(now);
	horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
	return horizon.getTime();
}

function requireFutureReminder(remindAt: string, now: number) {
	const due = Date.parse(remindAt);
	if (!Number.isFinite(due) || due <= now || due > oneYearHorizon(now)) {
		throw new FollowUpReminderError(
			"INVALID",
			"Reminder time must be in the future and within one year",
		);
	}
}

function fingerprint(values: readonly unknown[]) {
	return JSON.stringify(values);
}

const ReminderListCursorSchema = z.object({
	remindAt: z.number().int().nonnegative(),
	id: boundedId,
}).strict();

function decodeListCursor(cursor: string | undefined): FollowUpReminderStoreCursor | null {
	if (cursor === undefined) return null;
	if (cursor.length < 1 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw new FollowUpReminderError("INVALID", "Reminder list cursor is invalid");
	}
	try {
		const encoded = cursor.replace(/-/g, "+").replace(/_/g, "/");
		const padding = "=".repeat((4 - encoded.length % 4) % 4);
		const bytes = Uint8Array.from(
			atob(encoded + padding),
			(character) => character.charCodeAt(0),
		);
		const parsed = ReminderListCursorSchema.safeParse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		);
		if (parsed.success) return parsed.data;
	} catch {
		// All malformed and non-canonical cursors share one stable public error.
	}
	throw new FollowUpReminderError("INVALID", "Reminder list cursor is invalid");
}

function encodeListCursor(cursor: FollowUpReminderStoreCursor | null): string | null {
	if (!cursor) return null;
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let encoded = "";
	for (const byte of bytes) encoded += String.fromCharCode(byte);
	return btoa(encoded)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function createFollowUpReminderService(
	dependencies: FollowUpReminderServiceDependencies,
) {
	const now = dependencies.now ?? Date.now;
	const createId = dependencies.id ?? (() => `reminder_${crypto.randomUUID()}`);

	async function requireAccess(userId: string, mailboxAddress: string) {
		if (!(await dependencies.canAccessMailbox(userId, mailboxAddress))) {
			throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
		}
	}

	function mapMutation(result: ReminderStoreMutationResult) {
		if (result.status === "applied" || result.status === "replayed") {
			return result.reminder;
		}
		if (result.status === "not_found") {
			throw new FollowUpReminderError("NOT_FOUND", "Reminder was not found");
		}
		if (result.status === "forbidden") {
			throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
		}
		if (result.status === "idempotency_conflict") {
			throw new FollowUpReminderError("IDEMPOTENCY_CONFLICT", "Operation ID was already used for different reminder data");
		}
		throw new FollowUpReminderError("STATE_CONFLICT", "Reminder changed; refresh before retrying");
	}

	return {
		async list(
			userId: string,
			mailboxAddress: string,
			limit = 100,
			cursor?: string,
		) {
			const mailbox = mailboxAddress.toLowerCase();
			await requireAccess(userId, mailbox);
			const boundedLimit = z.number().int().min(1).max(100).parse(limit);
			const page = await dependencies.store.list({
				ownerUserId: userId,
				mailboxAddress: mailbox,
				limit: boundedLimit,
				cursor: decodeListCursor(cursor),
			});
			return {
				reminders: page.reminders,
				nextCursor: encodeListCursor(page.nextCursor),
			};
		},

		async create(userId: string, mailboxAddress: string, input: unknown) {
			const mailbox = mailboxAddress.toLowerCase();
			await requireAccess(userId, mailbox);
			const parsed = CreateReminderSchema.safeParse(input);
			if (!parsed.success) {
				throw new FollowUpReminderError("INVALID", "Reminder definition is invalid");
			}
			const timestamp = now();
			requireFutureReminder(parsed.data.remindAt, timestamp);
			const createFingerprint = fingerprint([
				mailbox,
				parsed.data.emailId,
				parsed.data.remindAt,
			]);
			const replay = await dependencies.store.findCreateReplay({
				ownerUserId: userId,
				idempotencyKey: parsed.data.idempotencyKey,
				fingerprint: createFingerprint,
			});
			if (replay?.status === "replayed") return replay.reminder;
			if (replay?.status === "idempotency_conflict") {
				throw new FollowUpReminderError("IDEMPOTENCY_CONFLICT", "Create operation ID was already used for different reminder data");
			}
			const anchor = await dependencies.resolveReminderAnchor(
				mailbox,
				parsed.data.emailId,
			);
			if (!anchor) {
				throw new FollowUpReminderError("NOT_FOUND", "Email was not found or cannot have a reminder");
			}
			if (
				!boundedId.safeParse(anchor.conversationKey).success ||
				!boundedId.safeParse(anchor.baselineMessageId).success ||
				!isoInstant.safeParse(anchor.baselineMessageDate).success ||
				Date.parse(anchor.baselineMessageDate) > timestamp
			) {
				throw new FollowUpReminderError("INVALID", "Baseline message date cannot be in the future");
			}
			const result = await dependencies.store.createOrReplay({
				row: {
					id: createId(),
					ownerUserId: userId,
					mailboxAddress: mailbox,
					conversationKey: anchor.conversationKey,
					baselineMessageId: anchor.baselineMessageId,
					baselineMessageDate: anchor.baselineMessageDate,
					remindAt: parsed.data.remindAt,
					state: "active",
					resolutionReason: null,
					version: 1,
					createdAt: timestamp,
					updatedAt: timestamp,
					resolvedAt: null,
				},
				idempotencyKey: parsed.data.idempotencyKey,
				fingerprint: createFingerprint,
			});
			if (result.status === "created" || result.status === "replayed") {
				return result.reminder;
			}
			if (result.status === "forbidden") {
				throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
			}
			if (result.status === "active_conflict") {
				throw new FollowUpReminderError("ACTIVE_CONFLICT", "This conversation already has an active personal reminder");
			}
			throw new FollowUpReminderError("IDEMPOTENCY_CONFLICT", "Create operation ID was already used for different reminder data");
		},

		async apply(
			userId: string,
			mailboxAddress: string,
			reminderId: string,
			input: unknown,
		) {
			const mailbox = mailboxAddress.toLowerCase();
			await requireAccess(userId, mailbox);
			const id = boundedId.safeParse(reminderId);
			const parsed = ReminderOperationSchema.safeParse(input);
			if (!id.success || !parsed.success) {
				throw new FollowUpReminderError("INVALID", "Reminder operation is invalid");
			}
			const timestamp = now();
			if (parsed.data.action === "snooze") {
				requireFutureReminder(parsed.data.remindAt, timestamp);
			}
			return mapMutation(await dependencies.store.applyOperation({
				ownerUserId: userId,
				mailboxAddress: mailbox,
				reminderId: id.data,
				operationId: parsed.data.operationId,
				expectedVersion: parsed.data.expectedVersion,
				action: parsed.data.action,
				...(parsed.data.action === "snooze" ? { remindAt: parsed.data.remindAt } : {}),
				fingerprint: fingerprint([
					mailbox,
					id.data,
					parsed.data.action,
					parsed.data.expectedVersion,
					parsed.data.action === "snooze" ? parsed.data.remindAt : null,
				]),
				occurredAt: timestamp,
			}));
		},

		async completeForInboundReply(input: StoredInboundReply) {
			const parsed = z.object({
				mailboxAddress: z.string().trim().email().max(320),
				conversationKey: boundedId,
				inboundMessageId: boundedId,
				inboundMessageDate: isoInstant,
			}).strict().safeParse(input);
			if (!parsed.success) {
				throw new FollowUpReminderError("INVALID", "Inbound reply reference is invalid");
			}
			const mailbox = parsed.data.mailboxAddress.toLowerCase();
			return dependencies.store.completeForInboundReply({
				mailboxAddress: mailbox,
				conversationKey: parsed.data.conversationKey,
				inboundMessageId: parsed.data.inboundMessageId,
				inboundMessageDate: parsed.data.inboundMessageDate,
				occurredAt: now(),
			});
		},
	};
}
