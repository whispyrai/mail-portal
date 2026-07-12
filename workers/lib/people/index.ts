import { Folders, InternalFolders } from "../../../shared/folders.ts";
import {
	MAIL_PEOPLE_LIMITS,
	decodeMailPeopleListCursor,
	decodeMailPersonTimelineCursor,
	encodeMailPeopleListCursor,
	encodeMailPersonTimelineCursor,
	type MailPeopleBuildingResponse,
	type MailPeopleListResponse,
	type MailPersonDetailResponse,
	type MailPersonDirection,
	type MailPersonNameProvenance,
	type MailPersonOrigin,
	type MailPersonRole,
	type MailPersonSummary,
	type MailPersonTimelineResponse,
	type NormalizedMailPeopleListQuery,
	type NormalizedMailPersonTimelineQuery,
} from "../../../shared/mail-people.ts";
import { RECIPIENT_MEMORY_LIMITS } from "../../../shared/recipient-suggestions.ts";
import { normalizeMailAddress } from "../mail-address.ts";

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

export type MailPeopleStore = {
	sql: {
		exec(query: string, ...bindings: SqlValue[]): Iterable<SqlRow>;
	};
	transactionSync<T>(operation: () => T): T;
};

export type MailPeopleProjector = ReturnType<typeof createMailPeopleProjector>;

const UNSAFE_UNICODE =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/u;
const UNSAFE_UNICODE_GLOBAL =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/gu;
const EXCLUDED_FOLDERS = new Set<string>([
	Folders.DRAFT,
	Folders.OUTBOX,
	InternalFolders.RETIRED_OUTBOUND,
	Folders.SPAM,
	Folders.TRASH,
]);

export function normalizeObservedSenderName(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\s+/gu, " ").normalize("NFC");
	if (
		!normalized ||
		UNSAFE_UNICODE.test(normalized) ||
		Array.from(normalized).length > MAIL_PEOPLE_LIMITS.displayNameChars
	) return null;
	return normalized;
}

function string(row: SqlRow, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`People projection row is missing ${key}`);
	return value;
}

function optionalString(row: SqlRow, key: string): string | null {
	const value = row[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new Error(`People projection row has invalid ${key}`);
	return value;
}

function number(row: SqlRow, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`People projection row has invalid ${key}`);
	}
	return value;
}

function one(sql: MailPeopleStore["sql"], query: string, ...bindings: SqlValue[]): SqlRow | null {
	return [...sql.exec(query, ...bindings)][0] ?? null;
}

function normalizeExternalAddress(value: string, mailboxAddress: string): string | null {
	const address = normalizeMailAddress(value);
	return address &&
		address !== mailboxAddress &&
		address === address.normalize("NFC") &&
		!UNSAFE_UNICODE.test(address) &&
		Array.from(address).length <= MAIL_PEOPLE_LIMITS.identifierChars
		? address
		: null;
}

function canonicalIdentifier(value: string): string | null {
	const normalized = value.trim().normalize("NFC");
	return normalized &&
		!UNSAFE_UNICODE.test(normalized) &&
		Array.from(normalized).length <= MAIL_PEOPLE_LIMITS.identifierChars
		? normalized
		: null;
}

function publicText(value: string | null, maximum: number, fallback = ""): string {
	const normalized = (value ?? "")
		.normalize("NFC")
		.replace(UNSAFE_UNICODE_GLOBAL, "")
		.trim();
	return Array.from(normalized).slice(0, maximum).join("") || fallback;
}

function canonicalDate(value: string): string | null {
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value ? value : null;
}

function addressValues(value: string | null): string[] {
	return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function projectionState(sql: MailPeopleStore["sql"]): SqlRow | null {
	return one(sql, "SELECT * FROM people_projection_state WHERE id = 1 LIMIT 1");
}

function buildingResponse(state: SqlRow): MailPeopleBuildingResponse {
	return {
		status: "building",
		schemaVersion: 1,
		processedMessages: number(state, "processed_messages"),
		retryAfterMs: MAIL_PEOPLE_LIMITS.retryAfterMs,
	};
}

function summary(row: SqlRow): MailPersonSummary {
	return {
		id: string(row, "id"),
		address: string(row, "address"),
		domain: string(row, "domain"),
		displayName: optionalString(row, "display_name"),
		nameProvenance: string(row, "name_provenance") as MailPersonNameProvenance,
		firstInteractionAt: string(row, "first_interaction_at"),
		lastInteractionAt: string(row, "last_interaction_at"),
		lastInboundAt: optionalString(row, "last_inbound_at"),
		lastOutboundAt: optionalString(row, "last_outbound_at"),
		receivedCount: number(row, "received_count"),
		sentCount: number(row, "sent_count"),
		conversationCount: number(row, "conversation_count"),
		attachmentCount: number(row, "attachment_count"),
		importedMessageCount: number(row, "imported_message_count"),
		latestDirection: string(row, "latest_direction") as MailPersonDirection,
	};
}

const SUMMARY_CTE = `WITH summaries AS (
	SELECT
		p.id, p.address, p.domain,
		MIN(mp.occurred_at) AS first_interaction_at,
		MAX(mp.occurred_at) AS last_interaction_at,
		MAX(CASE WHEN mp.direction = 'received' THEN mp.occurred_at END) AS last_inbound_at,
		MAX(CASE WHEN mp.direction = 'sent' THEN mp.occurred_at END) AS last_outbound_at,
		COUNT(DISTINCT CASE WHEN mp.direction = 'received' THEN mp.source_email_id END) AS received_count,
		COUNT(DISTINCT CASE WHEN mp.direction = 'sent' THEN mp.source_email_id END) AS sent_count,
		COUNT(DISTINCT mp.conversation_id) AS conversation_count,
		COUNT(DISTINCT a.id) AS attachment_count,
		COUNT(DISTINCT CASE WHEN mp.origin = 'admin_import' THEN mp.source_email_id END) AS imported_message_count,
		(
			SELECT named.observed_name
			FROM mail_message_participants named
			WHERE named.person_id = p.id AND named.observed_name IS NOT NULL
			ORDER BY
				CASE WHEN named.origin = 'live_inbound' THEN 0 ELSE 1 END,
				named.occurred_at DESC, named.source_email_id DESC
			LIMIT 1
		) AS display_name,
		COALESCE((
			SELECT CASE WHEN named.origin = 'live_inbound' THEN 'live' ELSE 'imported' END
			FROM mail_message_participants named
			WHERE named.person_id = p.id AND named.observed_name IS NOT NULL
			ORDER BY
				CASE WHEN named.origin = 'live_inbound' THEN 0 ELSE 1 END,
				named.occurred_at DESC, named.source_email_id DESC
			LIMIT 1
		), 'none') AS name_provenance,
		(
			SELECT latest.direction
			FROM mail_message_participants latest
			WHERE latest.person_id = p.id
			ORDER BY latest.occurred_at DESC, latest.source_email_id DESC, latest.role ASC
			LIMIT 1
		) AS latest_direction
	FROM mail_people p
	JOIN mail_message_participants mp ON mp.person_id = p.id
	LEFT JOIN attachments a ON a.email_id = mp.source_email_id
		AND COALESCE(a.disposition, 'attachment') <> 'inline'
	GROUP BY p.id, p.address, p.domain
)`;

export function createMailPeopleProjector(input: {
	store: MailPeopleStore;
	mailboxAddress: string;
	now?: () => string;
	personId?: () => string;
}) {
	const mailboxAddress = normalizeMailAddress(input.mailboxAddress);
	if (!mailboxAddress) throw new Error("Mailbox address is invalid");
	const now = input.now ?? (() => new Date().toISOString());
	const personId = input.personId ?? (() => crypto.randomUUID());
	const { sql } = input.store;

	const ensurePerson = (address: string, createdAt: string): string => {
		const existing = one(sql, "SELECT id FROM mail_people WHERE address = ?1 LIMIT 1", address);
		if (existing) return string(existing, "id");
		const id = personId();
		const domain = address.slice(address.lastIndexOf("@") + 1);
		sql.exec(
			`INSERT OR IGNORE INTO mail_people (id, address, domain, created_at)
			 VALUES (?1, ?2, ?3, ?4)`,
			id,
			address,
			domain,
			createdAt,
		);
		return string(
			one(sql, "SELECT id FROM mail_people WHERE address = ?1 LIMIT 1", address)!,
			"id",
		);
	};

	const projectMessage = (messageId: string): void => {
		sql.exec("DELETE FROM mail_message_participants WHERE source_email_id = ?1", messageId);
		const email = one(sql, `
			SELECT id, folder_id, sender, sender_name, recipient, cc, bcc, date,
				thread_id, recipient_memory_origin
			FROM emails WHERE id = ?1 LIMIT 1
		`, messageId);
		if (!email) return;
		const folderId = string(email, "folder_id");
		const origin = optionalString(email, "recipient_memory_origin");
		const occurredAtValue = optionalString(email, "date");
		const occurredAt = occurredAtValue ? canonicalDate(occurredAtValue) : null;
		if (
			EXCLUDED_FOLDERS.has(folderId) ||
			!occurredAt ||
			!origin ||
			!["live_inbound", "accepted_outbound", "admin_import"].includes(origin)
		) return;
		const sender = normalizeMailAddress(optionalString(email, "sender") ?? "");
		const outbound = origin === "accepted_outbound" ||
			(origin === "admin_import" && sender === mailboxAddress);
		const candidates: Array<{ address: string; role: MailPersonRole }> = [];
		if (outbound) {
			for (const [role, raw] of [
				["to", optionalString(email, "recipient")],
				["cc", optionalString(email, "cc")],
				["bcc", optionalString(email, "bcc")],
			] as const) {
				for (const value of addressValues(raw)) {
					const address = normalizeExternalAddress(value, mailboxAddress);
					if (address) candidates.push({ address, role });
				}
			}
		} else {
			const inboundSender = normalizeExternalAddress(
				optionalString(email, "sender") ?? "",
				mailboxAddress,
			);
			if (inboundSender) candidates.push({ address: inboundSender, role: "from" });
		}
		const uniqueAddresses = new Set(candidates.map((candidate) => candidate.address));
		if (uniqueAddresses.size > RECIPIENT_MEMORY_LIMITS.maxRecipientsPerMessage) return;
		const distinct = new Map<string, { address: string; role: MailPersonRole }>();
		for (const candidate of candidates) {
			if (!distinct.has(candidate.address)) distinct.set(candidate.address, candidate);
		}
		const conversationId = canonicalIdentifier(
			optionalString(email, "thread_id")?.trim() || messageId,
		);
		if (!conversationId) return;
		const observedName = outbound
			? null
			: normalizeObservedSenderName(optionalString(email, "sender_name"));
		for (const candidate of distinct.values()) {
			const id = ensurePerson(candidate.address, occurredAt);
			sql.exec(
				`INSERT OR REPLACE INTO mail_message_participants (
					source_email_id, person_id, role, direction, occurred_at,
					conversation_id, origin, observed_name
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
				messageId,
				id,
				candidate.role,
				outbound ? "sent" : "received",
				occurredAt,
				conversationId,
				origin,
				observedName,
			);
		}
	};

	const ensureProjectionState = (): SqlRow => {
		const existing = projectionState(sql);
		if (existing) return existing;
		const current = number(
			one(sql, "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mailbox_changes")!,
			"sequence",
		);
		const startedAt = now();
		sql.exec(
			`INSERT INTO people_projection_state (
				id, schema_version, status, baseline_change_sequence,
				applied_change_sequence, backfill_date, backfill_message_id,
				processed_messages, started_at, completed_at, last_error
			 ) VALUES (1, 1, 'building', ?1, ?1, NULL, NULL, 0, ?2, NULL, NULL)`,
			current,
			startedAt,
		);
		return projectionState(sql)!;
	};

	const backfillRows = (state: SqlRow, batchSize: number): SqlRow[] => {
		const cursorDate = optionalString(state, "backfill_date");
		const cursorId = optionalString(state, "backfill_message_id");
		return [...sql.exec(
			`SELECT id, date FROM emails
			 WHERE recipient_memory_origin IN ('live_inbound', 'accepted_outbound', 'admin_import')
			   AND date IS NOT NULL
			   AND folder_id NOT IN (?1, ?2, ?3, ?4, ?5)
			   AND (?6 IS NULL OR date < ?6 OR (date = ?6 AND id > ?7))
			 ORDER BY date DESC, id ASC
			 LIMIT ?8`,
			Folders.DRAFT,
			Folders.OUTBOX,
			InternalFolders.RETIRED_OUTBOUND,
			Folders.SPAM,
			Folders.TRASH,
			cursorDate,
			cursorId,
			batchSize + 1,
		)];
	};

	const advanceBackfill = (rawBatchSize: number): { complete: boolean; state: SqlRow } => {
		const batchSize = Math.min(Math.max(Math.trunc(rawBatchSize), 1), MAIL_PEOPLE_LIMITS.backfillBatchSize);
		return input.store.transactionSync(() => {
			const state = ensureProjectionState();
			if (string(state, "status") === "ready") return { complete: true, state };
			const rows = backfillRows(state, batchSize);
			const batch = rows.slice(0, batchSize);
			for (const row of batch) projectMessage(string(row, "id"));
			const last = batch.at(-1);
			if (last) {
				sql.exec(
					`UPDATE people_projection_state
					 SET backfill_date = ?1, backfill_message_id = ?2,
						processed_messages = processed_messages + ?3
					 WHERE id = 1`,
					string(last, "date"),
					string(last, "id"),
					batch.length,
				);
			}
			return { complete: rows.length <= batchSize, state: projectionState(sql)! };
		});
	};

	const catchUpFromChangeFeed = (rawPageSize: number): { complete: boolean; state: SqlRow } => {
		const pageSize = Math.min(Math.max(Math.trunc(rawPageSize), 1), MAIL_PEOPLE_LIMITS.replayPageSize);
		return input.store.transactionSync(() => {
			const state = ensureProjectionState();
			const applied = number(state, "applied_change_sequence");
			const changes = [...sql.exec(
				`SELECT sequence, resource, entity_id FROM mailbox_changes
				 WHERE sequence > ?1 ORDER BY sequence ASC LIMIT ?2`,
				applied,
				pageSize + 1,
			)];
			const page = changes.slice(0, pageSize);
			for (const change of page) {
				if (string(change, "resource") === "message") projectMessage(string(change, "entity_id"));
			}
			const lastSequence = page.length ? number(page.at(-1)!, "sequence") : applied;
			sql.exec(
				"UPDATE people_projection_state SET applied_change_sequence = ?1 WHERE id = 1",
				lastSequence,
			);
			const current = number(
				one(sql, "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mailbox_changes")!,
				"sequence",
			);
			const complete = changes.length <= pageSize && lastSequence >= current;
			return { complete, state: projectionState(sql)! };
		});
	};

	const prepare = (): MailPeopleBuildingResponse | null => {
		let state = ensureProjectionState();
		if (string(state, "status") === "building") {
			const backfill = advanceBackfill(MAIL_PEOPLE_LIMITS.backfillBatchSize);
			state = backfill.state;
			if (!backfill.complete) return buildingResponse(state);
			const replay = catchUpFromChangeFeed(MAIL_PEOPLE_LIMITS.replayPageSize);
			state = replay.state;
			if (!replay.complete) return buildingResponse(state);
			input.store.transactionSync(() => {
				sql.exec(
					`UPDATE people_projection_state
					 SET status = 'ready', completed_at = ?1, last_error = NULL WHERE id = 1`,
					now(),
				);
			});
			return null;
		}
		const replay = catchUpFromChangeFeed(MAIL_PEOPLE_LIMITS.replayPageSize);
		return replay.complete ? null : buildingResponse(replay.state);
	};

	const listPeople = (query: NormalizedMailPeopleListQuery): MailPeopleListResponse => {
		const pending = prepare();
		if (pending) return pending;
		const bindings: SqlValue[] = [];
		const conditions: string[] = [];
		if (query.q) {
			bindings.push(query.q);
			conditions.push(`(instr(lower(address), ?${bindings.length}) > 0 OR instr(lower(COALESCE(display_name, '')), ?${bindings.length}) > 0)`);
		}
		if (query.cursor) {
			const cursor = decodeMailPeopleListCursor(query.cursor, query);
			if (cursor.sort === "recent") {
				bindings.push(cursor.lastInteractionAt, cursor.address);
				conditions.push(`(last_interaction_at < ?${bindings.length - 1} OR (last_interaction_at = ?${bindings.length - 1} AND address COLLATE BINARY > ?${bindings.length}))`);
			} else if (cursor.sort === "frequent") {
				bindings.push(cursor.messageCount, cursor.lastInteractionAt, cursor.address);
				conditions.push(`(message_count < ?${bindings.length - 2} OR (message_count = ?${bindings.length - 2} AND (last_interaction_at < ?${bindings.length - 1} OR (last_interaction_at = ?${bindings.length - 1} AND address COLLATE BINARY > ?${bindings.length}))))`);
			} else {
				bindings.push(cursor.address);
				conditions.push(`address COLLATE BINARY > ?${bindings.length}`);
			}
		}
		const order = query.sort === "recent"
			? "last_interaction_at DESC, address COLLATE BINARY ASC"
			: query.sort === "frequent"
			? "message_count DESC, last_interaction_at DESC, address COLLATE BINARY ASC"
			: "address COLLATE BINARY ASC";
		bindings.push(query.limit + 1);
		const rows = [...sql.exec(
			`${SUMMARY_CTE}
			 SELECT *, received_count + sent_count AS message_count
			 FROM summaries
			 ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
			 ORDER BY ${order}
			 LIMIT ?${bindings.length}`,
			...bindings,
		)];
		const page = rows.slice(0, query.limit);
		const people = page.map(summary);
		const last = rows.length > query.limit ? rows[query.limit - 1] : null;
		let nextCursor: string | null = null;
		if (last) {
			const address = string(last, "address");
			if (query.sort === "recent") {
				nextCursor = encodeMailPeopleListCursor(query, {
					sort: "recent",
					lastInteractionAt: string(last, "last_interaction_at"),
					address,
				});
			} else if (query.sort === "frequent") {
				nextCursor = encodeMailPeopleListCursor(query, {
					sort: "frequent",
					messageCount: number(last, "message_count"),
					lastInteractionAt: string(last, "last_interaction_at"),
					address,
				});
			} else {
				nextCursor = encodeMailPeopleListCursor(query, { sort: "address", address });
			}
		}
		return { status: "ready", people, nextCursor };
	};

	const getPerson = (id: string): MailPersonDetailResponse => {
		const pending = prepare();
		if (pending) return pending;
		const row = one(sql, `${SUMMARY_CTE} SELECT * FROM summaries WHERE id = ?1 LIMIT 1`, id);
		if (!row) return { status: "ready", person: null };
		const conversations = [...sql.exec(`
			WITH person_messages AS (
				SELECT DISTINCT mp.source_email_id, mp.conversation_id, mp.direction,
					mp.occurred_at, e.subject, e.read, e.folder_id
				FROM mail_message_participants mp
				JOIN emails e ON e.id = mp.source_email_id
				WHERE mp.person_id = ?1
			), ranked AS (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY conversation_id
					ORDER BY occurred_at DESC, source_email_id DESC
				) AS rank
				FROM person_messages
			)
			SELECT r.conversation_id, r.source_email_id AS representative_message_id,
				r.folder_id AS representative_folder_id,
				r.subject, r.occurred_at AS latest_at, r.direction AS latest_direction,
				(SELECT COUNT(*) FROM person_messages pm WHERE pm.conversation_id = r.conversation_id) AS message_count,
				(SELECT COUNT(*) FROM person_messages pm WHERE pm.conversation_id = r.conversation_id AND pm.read = 0) AS unread_count,
				(SELECT COUNT(*) FROM attachments a JOIN person_messages pm ON pm.source_email_id = a.email_id WHERE pm.conversation_id = r.conversation_id AND COALESCE(a.disposition, 'attachment') <> 'inline') AS attachment_count
			FROM ranked r WHERE r.rank = 1
			ORDER BY r.occurred_at DESC, r.conversation_id ASC
			LIMIT ?2
		`, id, MAIL_PEOPLE_LIMITS.recentConversationLimit)].map((conversation) => ({
			conversationId: string(conversation, "conversation_id"),
			representativeMessageId: string(conversation, "representative_message_id"),
			representativeFolderId: string(conversation, "representative_folder_id"),
			subject: publicText(optionalString(conversation, "subject"), MAIL_PEOPLE_LIMITS.subjectChars),
			latestAt: string(conversation, "latest_at"),
			latestDirection: string(conversation, "latest_direction") as MailPersonDirection,
			messageCount: number(conversation, "message_count"),
			unreadCount: number(conversation, "unread_count"),
			attachmentCount: number(conversation, "attachment_count"),
		}));
		return { status: "ready", person: { ...summary(row), conversations } };
	};

	const listPersonTimeline = (
		id: string,
		query: NormalizedMailPersonTimelineQuery,
	): MailPersonTimelineResponse => {
		const pending = prepare();
		if (pending) return pending;
		const bindings: SqlValue[] = [id];
		let cursorCondition = "";
		if (query.cursor) {
			const cursor = decodeMailPersonTimelineCursor(query.cursor, id);
			bindings.push(cursor.date, cursor.messageId, cursor.role);
			cursorCondition = `AND (
				mp.occurred_at < ?2 OR
				(mp.occurred_at = ?2 AND mp.source_email_id > ?3) OR
				(mp.occurred_at = ?2 AND mp.source_email_id = ?3 AND mp.role > ?4)
			)`;
		}
		bindings.push(query.limit + 1);
		const rows = [...sql.exec(`
			SELECT mp.source_email_id, mp.conversation_id, mp.occurred_at,
				mp.direction, mp.role, mp.origin, e.subject, e.folder_id, f.name AS folder_name
			FROM mail_message_participants mp
			JOIN emails e ON e.id = mp.source_email_id
			JOIN folders f ON f.id = e.folder_id
			WHERE mp.person_id = ?1 ${cursorCondition}
			ORDER BY mp.occurred_at DESC, mp.source_email_id ASC, mp.role ASC
			LIMIT ?${bindings.length}
		`, ...bindings)];
		const page = rows.slice(0, query.limit);
		const items = page.map((row) => {
			const messageId = string(row, "source_email_id");
			const attachments = [...sql.exec(
				`SELECT id, filename, mimetype, size FROM attachments
				 WHERE email_id = ?1 AND COALESCE(disposition, 'attachment') <> 'inline'
				 ORDER BY id ASC LIMIT ?2`,
				messageId,
				MAIL_PEOPLE_LIMITS.timelineAttachmentsPerMessage,
			)].map((attachment) => ({
				id: string(attachment, "id"),
				filename: publicText(
					string(attachment, "filename"),
					MAIL_PEOPLE_LIMITS.filenameChars,
					"attachment",
				),
				mimetype: publicText(
					string(attachment, "mimetype"),
					MAIL_PEOPLE_LIMITS.mimetypeChars,
					"application/octet-stream",
				),
				size: number(attachment, "size"),
			}));
			return {
				messageId,
				conversationId: string(row, "conversation_id"),
				date: string(row, "occurred_at"),
				direction: string(row, "direction") as MailPersonDirection,
				role: string(row, "role") as MailPersonRole,
				subject: publicText(optionalString(row, "subject"), MAIL_PEOPLE_LIMITS.subjectChars),
				folder: {
					id: string(row, "folder_id"),
					name: publicText(
						string(row, "folder_name"),
						MAIL_PEOPLE_LIMITS.identifierChars,
						string(row, "folder_id"),
					),
				},
				origin: string(row, "origin") as MailPersonOrigin,
				attachments,
			};
		});
		const last = rows.length > query.limit ? rows[query.limit - 1] : null;
		const nextCursor = last
			? encodeMailPersonTimelineCursor(id, {
				date: string(last, "occurred_at"),
				messageId: string(last, "source_email_id"),
				role: string(last, "role") as MailPersonRole,
			})
			: null;
		return { status: "ready", personId: id, items, nextCursor };
	};

	return {
		projectMessage,
		advanceBackfill,
		catchUpFromChangeFeed,
		listPeople,
		getPerson,
		listPersonTimeline,
	};
}
