import {
	CONVERSATION_ACTIVITY_LABELS,
	CONVERSATION_ACTIVITY_LIMITS,
	type ConversationActivityCode,
} from "../../shared/conversation-activity.ts";
import { decodeBase64Url } from "../../shared/base64url.ts";
import { isInternalFolderId } from "../../shared/folders.ts";

type SqlValue = ArrayBuffer | string | number | null;

export interface ConversationActivitySqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

type ActivityCursor = {
	version: 1;
	occurredAt: string;
	id: string;
};

type AnchorRow = {
	id: string;
	threadId: string | null;
	folderId: string;
};

type RawEventRow = {
	id: string;
	actorKind: string;
	actorId: string | null;
	action: string;
	metadataJson: string | null;
	occurredAt: string;
};

export type ConversationActivityProjectionItem = {
	id: string;
	code: ConversationActivityCode;
	label: string;
	actorKind: "user" | "mcp" | "agent" | "rule" | "system";
	actorId: string | null;
	occurredAt: string;
};

export type ConversationActivityProjection =
	| { state: "not_found" }
	| { state: "invalid_request" }
	| { state: "invalid_cursor" }
	| {
			state: "ready";
			items: ConversationActivityProjectionItem[];
			nextCursor: string | null;
	  };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTROL_TEXT = /[\u0000-\u001F\u007F]/;
const ACTOR_KINDS = new Set(["user", "mcp", "agent", "rule", "system"]);
const RAW_ACTIONS = [
	"email_created",
	"email_updated",
	"thread_marked_read",
	"conversation_read_state_changed",
	"batch_mark_read",
	"batch_mark_unread",
	"batch_archive",
	"batch_trash",
	"conversation_archived",
	"conversation_trashed",
	"email_trashed",
	"email_restored",
	"email_moved",
	"conversation_snoozed",
	"email_snoozed",
	"conversation_unsnoozed",
	"email_unsnoozed",
	"conversation_woken_by_reply",
	"label_applied",
	"label_removed",
	"draft_created",
	"draft_updated",
	"outbound_enqueued",
	"outbound_cancelled",
	"outbound_retry_requested",
	"outbound_provider_accepted",
	"outbound_bounce_recorded",
	"outbound_complaint_recorded",
] as const;

function characterLength(value: string): number {
	return Array.from(value).length;
}

function boundedIdentifier(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") return null;
	if (
		!value ||
		value !== value.normalize("NFC") ||
		value !== value.trim() ||
		CONTROL_TEXT.test(value) ||
		/\s/u.test(value) ||
		characterLength(value) > maxChars ||
		encoder.encode(value).byteLength > maxChars * 4
	) {
		return null;
	}
	return value;
}

function canonicalIso(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 64) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const canonical = date.toISOString();
	return canonical === value ? canonical : null;
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeCursor(cursor: ActivityCursor): string {
	return encodeBase64Url(encoder.encode(JSON.stringify(cursor)));
}

function decodeCursor(value: string | null): ActivityCursor | null | undefined {
	if (value === null) return null;
	const bytes = decodeBase64Url(value);
	if (!bytes) return undefined;
	try {
		const decoded: unknown = JSON.parse(decoder.decode(bytes));
		if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
			return undefined;
		}
		const record = decoded as Record<string, unknown>;
		if (
			Object.keys(record).length !== 3 ||
			record.version !== 1 ||
			canonicalIso(record.occurredAt) === null ||
			boundedIdentifier(
				record.id,
				CONVERSATION_ACTIVITY_LIMITS.eventIdChars,
			) === null
		) {
			return undefined;
		}
		const cursor: ActivityCursor = {
			version: 1,
			occurredAt: record.occurredAt as string,
			id: record.id as string,
		};
		return encodeCursor(cursor) === value ? cursor : undefined;
	} catch {
		return undefined;
	}
}

function metadataRecord(value: string | null): Record<string, unknown> | null {
	if (typeof value !== "string" || value.length > 4_096) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function safeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function codeForEvent(
	action: string,
	metadata: Record<string, unknown>,
): ConversationActivityCode | null {
	switch (action) {
		case "email_created":
			return metadata.folderId === "inbox" ? "message_received" : null;
		case "email_updated": {
			const keys = Object.keys(metadata);
			if (keys.length !== 1) return null;
			if (typeof metadata.read === "boolean") {
				return metadata.read ? "marked_read" : "marked_unread";
			}
			if (typeof metadata.starred === "boolean") {
				return metadata.starred ? "starred" : "unstarred";
			}
			return null;
		}
		case "thread_marked_read":
		case "batch_mark_read":
			return "marked_read";
		case "batch_mark_unread":
			return "marked_unread";
		case "conversation_read_state_changed":
			return typeof metadata.read === "boolean"
				? metadata.read
					? "marked_read"
					: "marked_unread"
				: null;
		case "batch_archive":
		case "conversation_archived":
			return "archived";
		case "batch_trash":
		case "conversation_trashed":
		case "email_trashed":
			return "trashed";
		case "email_restored":
			return "restored";
		case "email_moved":
			return metadata.toFolderId === "archive"
				? "archived"
				: metadata.toFolderId === "trash"
					? "trashed"
					: null;
		case "conversation_snoozed":
		case "email_snoozed":
			return typeof metadata.wakeAt === "string" ? "snoozed" : null;
		case "conversation_unsnoozed":
		case "email_unsnoozed":
			return safeInteger(metadata.affectedCount) ? "returned" : null;
		case "conversation_woken_by_reply":
			return safeInteger(metadata.affectedCount) ? "automatically_returned" : null;
		case "label_applied":
		case "label_removed":
			if (
				boundedIdentifier(metadata.labelId, 128) === null ||
				!safeInteger(metadata.affectedCount)
			) return null;
			return action === "label_applied" ? "label_added" : "label_removed";
		case "draft_created":
			return "draft_created";
		case "draft_updated":
			return "draft_updated";
		case "outbound_enqueued":
			return boundedIdentifier(metadata.emailId, 300) ? "send_queued" : null;
		case "outbound_provider_accepted":
			return "delivery_accepted";
		case "outbound_cancelled":
			return "send_cancelled";
		case "outbound_retry_requested":
			return typeof metadata.acknowledgedDuplicateRisk === "boolean"
				? "retry_requested"
				: null;
		case "outbound_bounce_recorded":
			return "bounced";
		case "outbound_complaint_recorded":
			return "complaint";
		default:
			return null;
	}
}

type ProjectedWithCursor = ConversationActivityProjectionItem & {
	cursor: ActivityCursor;
};

function projectRawEvent(row: RawEventRow): ProjectedWithCursor | null {
	const id = boundedIdentifier(
		row.id,
		CONVERSATION_ACTIVITY_LIMITS.eventIdChars,
	);
	const occurredAt = canonicalIso(row.occurredAt);
	const metadata = metadataRecord(row.metadataJson);
	if (
		!id ||
		!occurredAt ||
		!metadata ||
		!ACTOR_KINDS.has(row.actorKind) ||
		(row.actorId !== null && boundedIdentifier(row.actorId, 200) === null)
	) return null;
	const code = codeForEvent(row.action, metadata);
	if (!code) return null;
	return {
		id,
		code,
		label: CONVERSATION_ACTIVITY_LABELS[code],
		actorKind: row.actorKind as ProjectedWithCursor["actorKind"],
		actorId: row.actorId,
		occurredAt,
		cursor: { version: 1, occurredAt, id },
	};
}

export function readConversationActivityProjection(
	sql: ConversationActivitySqlReader,
	input: { emailId: string; limit: number; cursor: string | null },
): ConversationActivityProjection {
	const emailId = boundedIdentifier(input.emailId, 300);
	if (!emailId) return { state: "not_found" };
	if (
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > CONVERSATION_ACTIVITY_LIMITS.maxPageSize
	) return { state: "invalid_request" };
	const cursor = decodeCursor(input.cursor);
	if (cursor === undefined) return { state: "invalid_cursor" };
	const anchor = [
		...sql.exec<AnchorRow>(
			`SELECT
				id AS id,
				thread_id AS threadId,
				folder_id AS folderId
			 FROM emails
			 WHERE id = ?1
			 LIMIT 1`,
			emailId,
		),
	][0];
	if (!anchor || isInternalFolderId(anchor.folderId)) return { state: "not_found" };
	const conversationKey = boundedIdentifier(anchor.threadId || anchor.id, 300);
	if (!conversationKey) return { state: "not_found" };

	const scanLimit = input.limit * 4 + 1;
	const actionPlaceholders = RAW_ACTIONS.map(
		(_, index) => `?${index + 5}`,
	).join(", ");
	const rawRows = [
		...sql.exec<RawEventRow>(
			`WITH conversation_messages AS (
				SELECT id
				FROM emails
				WHERE id = ?1 OR thread_id = ?1
			), conversation_deliveries AS (
				SELECT od.id
				FROM outbound_deliveries od
				INNER JOIN conversation_messages cm ON cm.id = od.email_id
			)
			SELECT
				a.id AS id,
				a.actor_kind AS actorKind,
				a.actor_id AS actorId,
				a.action AS action,
				a.metadata_json AS metadataJson,
				a.occurred_at AS occurredAt
			FROM activity_events a
			WHERE (
				(a.entity_type = 'email' AND a.entity_id IN (SELECT id FROM conversation_messages))
				OR (a.entity_type IN ('thread', 'conversation') AND a.entity_id = ?1)
				OR (a.entity_type = 'outbound_delivery' AND a.entity_id IN (SELECT id FROM conversation_deliveries))
			)
			AND LENGTH(a.id) <= 200
			AND LENGTH(a.actor_kind) <= 20
			AND (a.actor_id IS NULL OR LENGTH(a.actor_id) <= 200)
			AND LENGTH(a.action) <= 100
			AND a.metadata_json IS NOT NULL
			AND LENGTH(a.metadata_json) <= 4096
			AND LENGTH(a.occurred_at) <= 64
			AND (?2 IS NULL OR a.occurred_at < ?2 OR (a.occurred_at = ?2 AND a.id < ?3))
			AND a.action IN (${actionPlaceholders})
			ORDER BY a.occurred_at DESC, a.id DESC
			LIMIT ?4`,
			conversationKey,
			cursor?.occurredAt ?? null,
			cursor?.id ?? null,
			scanLimit,
			...RAW_ACTIONS,
		),
	];
	const projected = rawRows
		.map(projectRawEvent)
		.filter((item): item is ProjectedWithCursor => item !== null);
	const items = projected.slice(0, input.limit);
	let nextCursor: string | null = null;
	if (projected.length > input.limit) {
		nextCursor = encodeCursor(items[items.length - 1]!.cursor);
	} else if (rawRows.length === scanLimit && rawRows.length > 0) {
		const last = rawRows[rawRows.length - 1]!;
		const occurredAt = canonicalIso(last.occurredAt);
		const id = boundedIdentifier(last.id, CONVERSATION_ACTIVITY_LIMITS.eventIdChars);
		if (occurredAt && id) nextCursor = encodeCursor({ version: 1, occurredAt, id });
	}
	return {
		state: "ready",
		items: items.map(({ cursor: _cursor, ...item }) => item),
		nextCursor,
	};
}
