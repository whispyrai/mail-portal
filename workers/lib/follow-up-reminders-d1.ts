import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import type { Env } from "../types.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import {
	createFollowUpReminderService,
	type FollowUpReminderStore,
	type ReminderStoreOperation,
} from "./follow-up-reminders.ts";

interface ReminderRow {
	id: string;
	owner_user_id: string;
	mailbox_address: string;
	conversation_key: string;
	baseline_message_id: string;
	baseline_message_date: number;
	remind_at: number;
	state: FollowUpReminder["state"];
	resolution_reason: FollowUpReminder["resolutionReason"];
	version: number;
	created_at: number;
	updated_at: number;
	resolved_at: number | null;
}

interface OperationRow {
	payload_fingerprint: string;
	result_json: string;
}

const REMINDER_COLUMNS = `id, owner_user_id, mailbox_address, conversation_key,
	baseline_message_id, baseline_message_date, remind_at, state,
	resolution_reason, version, created_at, updated_at, resolved_at`;

function fromRow(row: ReminderRow): FollowUpReminder {
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		mailboxAddress: row.mailbox_address,
		conversationKey: row.conversation_key,
		baselineMessageId: row.baseline_message_id,
		baselineMessageDate: new Date(row.baseline_message_date).toISOString(),
		remindAt: new Date(row.remind_at).toISOString(),
		state: row.state,
		resolutionReason: row.resolution_reason,
		version: row.version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at,
	};
}

function parseSnapshot(value: string): FollowUpReminder {
	const parsed = JSON.parse(value) as FollowUpReminder;
	if (!parsed || typeof parsed.id !== "string" || typeof parsed.version !== "number") {
		throw new Error("Stored follow-up reminder operation result is invalid");
	}
	return parsed;
}

function isUniqueConstraint(error: unknown): boolean {
	return error instanceof Error && /unique constraint/i.test(error.message);
}

function nextReminder(
	current: FollowUpReminder,
	input: ReminderStoreOperation,
): FollowUpReminder {
	return {
		...current,
		version: current.version + 1,
		updatedAt: input.occurredAt,
		...(input.action === "snooze"
			? { remindAt: input.remindAt! }
			: {
					state: input.action === "dismiss" ? "dismissed" as const : "completed" as const,
					resolutionReason: input.action === "dismiss" ? "dismissed" as const : "manual" as const,
					resolvedAt: input.occurredAt,
				}),
	};
}

export function followUpReminderD1Store(
	env: Pick<Env, "DB">,
): FollowUpReminderStore {
	async function findOperation(ownerUserId: string, operationId: string) {
		return env.DB.prepare(
			`SELECT payload_fingerprint, result_json
			 FROM follow_up_reminder_operations
			 WHERE owner_user_id = ? AND operation_id = ?`,
		)
			.bind(ownerUserId, operationId)
			.first<OperationRow>();
	}

	async function getScoped(
		id: string,
		ownerUserId: string,
		mailboxAddress: string,
	) {
		const row = await env.DB.prepare(
			`SELECT ${REMINDER_COLUMNS}
			 FROM follow_up_reminders
			 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?`,
		)
			.bind(id, ownerUserId, mailboxAddress)
			.first<ReminderRow>();
		return row ? fromRow(row) : undefined;
	}

	return {
		async list(ownerUserId, mailboxAddress, limit) {
			const result = await env.DB.prepare(
				`SELECT ${REMINDER_COLUMNS}
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND mailbox_address = ? AND state = 'active'
				 ORDER BY remind_at ASC, id ASC
				 LIMIT ?`,
			)
				.bind(ownerUserId, mailboxAddress, limit)
				.all<ReminderRow>();
			return result.results.map(fromRow);
		},

		async findCreateReplay({ ownerUserId, idempotencyKey, fingerprint }) {
			const prior = await env.DB.prepare(
				`SELECT create_fingerprint, create_result_json
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
			)
				.bind(ownerUserId, idempotencyKey)
				.first<{ create_fingerprint: string; create_result_json: string }>();
			if (!prior) return null;
			return prior.create_fingerprint === fingerprint
				? { status: "replayed", reminder: parseSnapshot(prior.create_result_json) }
				: { status: "idempotency_conflict" };
		},

		async createOrReplay({ row, idempotencyKey, fingerprint }) {
			const prior = await env.DB.prepare(
				`SELECT create_fingerprint, create_result_json
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
			)
				.bind(row.ownerUserId, idempotencyKey)
				.first<{ create_fingerprint: string; create_result_json: string }>();
			if (prior) {
				return prior.create_fingerprint === fingerprint
					? { status: "replayed", reminder: parseSnapshot(prior.create_result_json) }
					: { status: "idempotency_conflict" };
			}

			try {
				await env.DB.prepare(
					`INSERT INTO follow_up_reminders
					 (id, owner_user_id, mailbox_address, conversation_key,
					  baseline_message_id, baseline_message_date, remind_at, state,
					  resolution_reason, create_idempotency_key, create_fingerprint,
					  create_result_json, version, created_at, updated_at, resolved_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, NULL)`,
				)
					.bind(
						row.id,
						row.ownerUserId,
						row.mailboxAddress,
						row.conversationKey,
						row.baselineMessageId,
						Date.parse(row.baselineMessageDate),
						Date.parse(row.remindAt),
						idempotencyKey,
						fingerprint,
						JSON.stringify(row),
						row.version,
						row.createdAt,
						row.updatedAt,
					)
					.run();
				return { status: "created", reminder: row };
			} catch (error) {
				if (!isUniqueConstraint(error)) throw error;
				const replay = await env.DB.prepare(
					`SELECT create_fingerprint, create_result_json
					 FROM follow_up_reminders
					 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
				)
					.bind(row.ownerUserId, idempotencyKey)
					.first<{ create_fingerprint: string; create_result_json: string }>();
				if (replay) {
					return replay.create_fingerprint === fingerprint
						? { status: "replayed", reminder: parseSnapshot(replay.create_result_json) }
						: { status: "idempotency_conflict" };
				}
				const active = await env.DB.prepare(
					`SELECT ${REMINDER_COLUMNS}
					 FROM follow_up_reminders
					 WHERE owner_user_id = ? AND mailbox_address = ?
					   AND conversation_key = ? AND state = 'active'`,
				)
					.bind(row.ownerUserId, row.mailboxAddress, row.conversationKey)
					.first<ReminderRow>();
				if (active) return { status: "active_conflict", reminder: fromRow(active) };
				throw error;
			}
		},

		async applyOperation(input) {
			const prior = await findOperation(input.ownerUserId, input.operationId);
			if (prior) {
				return prior.payload_fingerprint === input.fingerprint
					? { status: "replayed", reminder: parseSnapshot(prior.result_json) }
					: { status: "idempotency_conflict" };
			}

			const current = await getScoped(
				input.reminderId,
				input.ownerUserId,
				input.mailboxAddress,
			);
			if (!current) return { status: "not_found" };
			if (current.state !== "active" || current.version !== input.expectedVersion) {
				return { status: "state_conflict", reminder: current };
			}
			const next = nextReminder(current, input);
			const state = input.action === "snooze" ? "active" : input.action === "dismiss" ? "dismissed" : "completed";
			const reason = input.action === "snooze" ? null : input.action === "dismiss" ? "dismissed" : "manual";
			const resolvedAt = input.action === "snooze" ? null : input.occurredAt;
			const remindAt = input.action === "snooze"
				? Date.parse(input.remindAt!)
				: Date.parse(current.remindAt);

			try {
				const results = await env.DB.batch([
					env.DB.prepare(
						`UPDATE follow_up_reminders
						 SET remind_at = ?, state = ?, resolution_reason = ?,
						     version = version + 1, updated_at = ?, resolved_at = ?
						 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?
						   AND state = 'active' AND version = ?`,
					)
						.bind(
							remindAt,
							state,
							reason,
							input.occurredAt,
							resolvedAt,
							input.reminderId,
							input.ownerUserId,
							input.mailboxAddress,
							input.expectedVersion,
						),
					env.DB.prepare(
						`INSERT INTO follow_up_reminder_operations
						 (id, owner_user_id, mailbox_address, reminder_id, operation_id,
						  action, payload_fingerprint, result_json, created_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
						 WHERE changes() = 1`,
					)
						.bind(
							`reminder_operation_${crypto.randomUUID()}`,
							input.ownerUserId,
							input.mailboxAddress,
							input.reminderId,
							input.operationId,
							input.action,
							input.fingerprint,
							JSON.stringify(next),
							input.occurredAt,
						),
				]);
				if (results[0]?.meta.changes && results[1]?.meta.changes) {
					return { status: "applied", reminder: next };
				}
			} catch (error) {
				if (!isUniqueConstraint(error)) throw error;
			}

			const replay = await findOperation(input.ownerUserId, input.operationId);
			if (replay) {
				return replay.payload_fingerprint === input.fingerprint
					? { status: "replayed", reminder: parseSnapshot(replay.result_json) }
					: { status: "idempotency_conflict" };
			}
			const latest = await getScoped(
				input.reminderId,
				input.ownerUserId,
				input.mailboxAddress,
			);
			return latest
				? { status: "state_conflict", reminder: latest }
				: { status: "not_found" };
		},

		async completeForInboundReply(input) {
			const result = await env.DB.prepare(
				`UPDATE follow_up_reminders AS reminder
				 SET state = 'completed', resolution_reason = 'inbound_reply',
				     resolved_at = ?, updated_at = ?, version = version + 1
				 WHERE mailbox_address = ? AND conversation_key = ?
				   AND state = 'active' AND baseline_message_id <> ?
				   AND baseline_message_date < ?
				   AND EXISTS (
				     SELECT 1
				     FROM users AS owner
				     JOIN mailboxes AS mailbox ON mailbox.id = reminder.mailbox_address
				     WHERE owner.id = reminder.owner_user_id
				       AND owner.is_active = 1
				       AND mailbox.is_active = 1
				       AND (
				         (mailbox.type = 'PERSONAL' AND mailbox.owner_user_id = owner.id)
				         OR (
				           mailbox.type = 'SHARED'
				           AND EXISTS (
				             SELECT 1 FROM mailbox_memberships AS membership
				             WHERE membership.mailbox_id = mailbox.id
				               AND membership.user_id = owner.id
				           )
				         )
				       )
				   )`,
			)
				.bind(
					input.occurredAt,
					input.occurredAt,
					input.mailboxAddress,
					input.conversationKey,
					input.inboundMessageId,
					Date.parse(input.inboundMessageDate),
				)
				.run();
			return Number(result.meta.changes ?? 0);
		},
	};
}

export function followUpReminderService(env: Env) {
	return createFollowUpReminderService({
		store: followUpReminderD1Store(env),
		canAccessMailbox: (userId, mailboxAddress) =>
			mailboxAccess(env).canAccessMailbox(userId, mailboxAddress),
		resolveReminderAnchor: async (mailboxAddress, emailId) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxAddress));
			return stub.getFollowUpReminderAnchor(emailId);
		},
	});
}
