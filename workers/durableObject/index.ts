// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { sendEmail } from "../email-sender";
import {
	generateMessageId,
	buildThreadToken,
	buildThreadingHeaders,
	escapeHtml,
} from "../lib/email-helpers";
import { arrayBufferToBase64, uploadKey } from "../lib/attachments";
import { validateAttachmentSet } from "../../shared/attachments";
import { vapidConfig } from "../lib/push/transport";
import { sendWebPush } from "../lib/push/send";
import { fanOutPush } from "../lib/push/fanout";
import type { PushPayload } from "../lib/push/types";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, (typeof schema.emails)[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Bulk send (mail merge, F-06) ───────────────────────────────────

const BULK_MAX_RECIPIENTS = 200; // hard cap per job (locked-decisions F-06)
const BULK_MIN_DELAY_MS = 1500; // throttle floor between sends
const BULK_MAX_JITTER_MS = 1000; // added random jitter, so ~1.5–2.5s apart
const BULK_QUEUE_KEY = "bulk:queue";

type BulkRecipient = Record<string, string>; // must include `email`

/** One shared attachment for a bulk job: its base64 lives at `key` in R2. */
interface BulkAttachment {
	key: string; // R2 key holding the base64-encoded content
	filename: string;
	type: string;
	size: number;
}

interface BulkJob {
	id: string;
	status: "queued" | "running" | "done";
	fromEmail: string;
	fromName: string;
	subject: string;
	html?: string;
	text?: string;
	total: number;
	sent: number;
	failed: number;
	cursor: number;
	errors: { email: string; error: string }[];
	createdAt: number;
	updatedAt: number;
	/** Shared attachments delivered to every recipient (manifest only; bytes in R2). */
	attachments?: BulkAttachment[];
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(rawSortColumn as SortColumn)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push("folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)");
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(`SELECT COUNT(*) as total FROM emails ${where}`, ...params),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const { folder, page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder,
				limit,
				offset,
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder,
			limit,
			offset,
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(id: string, { read, starred }: { read?: boolean; starred?: boolean }) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db.update(schema.emails).set(data).where(eq(schema.emails.id, id)).run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO email_deletion_tombstones (id, deleted_at)
				 VALUES (?1, datetime('now'))`,
				id,
			);
			this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
		});

		return emailAttachments;
	}

	async isEmailDeleted(id: string): Promise<boolean> {
		return (
			[
				...this.ctx.storage.sql.exec(
					`SELECT 1 AS found FROM email_deletion_tombstones WHERE id = ?1 LIMIT 1`,
					id,
				),
			].length > 0
		);
	}

	async claimInboundPush(id: string): Promise<boolean> {
		return this.ctx.storage.transactionSync(() => {
			const alreadyClaimed = [
				...this.ctx.storage.sql.exec(
					`SELECT 1 AS found FROM inbound_push_claims WHERE id = ?1 LIMIT 1`,
					id,
				),
			].length > 0;

			if (alreadyClaimed) return false;

			this.ctx.storage.sql.exec(`INSERT INTO inbound_push_claims (id) VALUES (?1)`, id);
			return true;
		});
	}

	async recordInboundTerminalFailure(input: {
		id: string;
		queueMessageId: string;
		attempts: number;
		errorCode: string;
	}): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO inbound_terminal_failures
			 (id, queue_message_id, attempts, error_code)
			 VALUES (?1, ?2, ?3, ?4)`,
			input.id,
			input.queueMessageId,
			input.attempts,
			input.errorCode,
		);
	}

	async getInboundTerminalFailure(id: string): Promise<{
		queueMessageId: string;
		attempts: number;
		errorCode: string;
		recordedAt: string;
	} | null> {
		const row = [
			...this.ctx.storage.sql.exec<{
				queue_message_id: string;
				attempts: number;
				error_code: string;
				recorded_at: string;
			}>(
				`SELECT queue_message_id, attempts, error_code, recorded_at
				 FROM inbound_terminal_failures WHERE id = ?1 LIMIT 1`,
				id,
			),
		][0];
		if (!row) return null;
		return {
			queueMessageId: row.queue_message_id,
			attempts: row.attempts,
			errorCode: row.error_code,
			recordedAt: row.recorded_at,
		};
	}

	async getAttachment(id: string) {
		return (
			this.db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount:
					sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(
						Number,
					),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db.delete(schema.folders).where(eq(schema.folders.id, id)).run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const {
			query,
			folder,
			from,
			to,
			subject,
			date_start,
			date_end,
			is_read,
			is_starred,
			has_attachment,
		} = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(
				`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`,
			);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(
				`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`,
			);
		}
		if (from) {
			const p = addParam(`%${from}%`);
			conditions.push(`${prefix}sender LIKE ${p}`);
		}
		if (to) {
			const p = addParam(`%${to}%`);
			conditions.push(
				`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`,
			);
		}
		if (subject) {
			const p = addParam(`%${subject}%`);
			conditions.push(`${prefix}subject LIKE ${p}`);
		}
		if (date_start) {
			const p = addParam(date_start);
			conditions.push(`${prefix}date >= ${p}`);
		}
		if (date_end) {
			const p = addParam(date_end);
			conditions.push(`${prefix}date <= ${p}`);
		}
		if (is_read !== undefined) {
			const p = addParam(is_read ? 1 : 0);
			conditions.push(`${prefix}read = ${p}`);
		}
		if (is_starred !== undefined) {
			const p = addParam(is_starred ? 1 : 0);
			conditions.push(`${prefix}starred = ${p}`);
		}
		if (has_attachment) {
			conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`);
		}

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
				Folders.SENT,
			),
		][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
				Folders.SENT,
			),
		][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(folder: string, email: EmailData, attachments: AttachmentData[]) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.ctx.storage.transactionSync(() => {
			this.db
				.insert(schema.emails)
				.values({
					id: email.id,
					folder_id: folderId,
					subject: email.subject,
					sender: email.sender,
					recipient: email.recipient,
					cc: email.cc ?? null,
					bcc: email.bcc ?? null,
					date: email.date,
					read: isSent ? 1 : email.read ? 1 : 0,
					starred: email.starred ? 1 : 0,
					body: email.body,
					in_reply_to: email.in_reply_to ?? null,
					email_references: email.email_references ?? null,
					thread_id: email.thread_id ?? null,
					message_id: email.message_id ?? null,
					raw_headers: email.raw_headers ?? null,
				})
				.run();

			if (attachments.length > 0) {
				this.db.insert(schema.attachments).values(attachments).run();
			}
		});
	}

	// ── Bulk send (mail merge) — alarm-scheduled, throttled (F-06) ──

	/** Extract {{placeholder}} variable names from a template string. */
	#extractVars(tpl: string): string[] {
		const out = new Set<string>();
		for (const m of tpl.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) out.add(m[1]);
		return [...out];
	}

	/** Substitute {{key}} from the row; HTML-escape values when `escape` is set. */
	#renderTemplate(tpl: string, row: BulkRecipient, escape: boolean): string {
		return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_full, key: string) => {
			const v = row[key] ?? "";
			return escape ? escapeHtml(v) : v;
		});
	}

	/**
	 * Enqueue a bulk-send job: validate the template against the CSV columns,
	 * persist recipients + template, and kick the alarm. The alarm sends one
	 * message per tick with a randomized throttle, so even a 200-recipient job
	 * stays well within per-invocation Worker limits and survives restarts.
	 */
	async enqueueBulkJob(input: {
		fromEmail: string;
		fromName: string;
		subject: string;
		html?: string;
		text?: string;
		recipients: BulkRecipient[];
		attachmentUploadIds?: string[];
	}): Promise<{ jobId: string; total: number }> {
		const recipients = input.recipients ?? [];
		if (recipients.length === 0) throw new Error("No recipients provided.");
		if (recipients.length > BULK_MAX_RECIPIENTS) {
			throw new Error(`Too many recipients: max ${BULK_MAX_RECIPIENTS} per job.`);
		}
		if (!input.subject.trim()) throw new Error("Subject is required.");
		if (!input.html && !input.text) throw new Error("Email body is required.");

		for (const r of recipients) {
			if (!r.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) {
				throw new Error("Every recipient row needs a valid 'email' column.");
			}
		}

		// Every {{var}} in the template must exist as a column in the CSV.
		const vars = new Set<string>([
			...this.#extractVars(input.subject),
			...this.#extractVars(input.html ?? ""),
			...this.#extractVars(input.text ?? ""),
		]);
		const columns = new Set(Object.keys(recipients[0]));
		const missing = [...vars].filter((v) => !columns.has(v));
		if (missing.length > 0) {
			throw new Error(`Template uses columns not in the CSV: ${missing.join(", ")}`);
		}

		const jobId = `job_${crypto.randomUUID()}`;

		// Resolve the shared attachments once: read each staged upload, enforce the
		// limits, and stash the base64 SES needs under the job so the alarm streams
		// it to every recipient with no per-send re-encoding.
		const attachments: BulkAttachment[] = [];
		const uploadIds = input.attachmentUploadIds ?? [];
		if (uploadIds.length > 0) {
			const staged: {
				bytes: ArrayBuffer;
				filename: string;
				type: string;
				srcKey: string;
			}[] = [];
			for (const uploadId of uploadIds) {
				const srcKey = uploadKey(input.fromEmail, uploadId);
				const obj = await this.env.BUCKET.get(srcKey);
				if (!obj) {
					throw new Error(
						"An attachment upload was not found or has expired. Re-attach and try again.",
					);
				}
				const meta = obj.customMetadata ?? {};
				staged.push({
					bytes: await obj.arrayBuffer(),
					filename: (meta.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_"),
					type: meta.type || obj.httpMetadata?.contentType || "application/octet-stream",
					srcKey,
				});
			}
			const setError = validateAttachmentSet(
				staged.map((s) => ({ filename: s.filename, size: s.bytes.byteLength })),
			);
			if (setError) throw new Error(setError);
			for (let i = 0; i < staged.length; i++) {
				const s = staged[i];
				const key = `bulk-attachments/${jobId}/${i}`;
				await this.env.BUCKET.put(key, arrayBufferToBase64(s.bytes), {
					customMetadata: { filename: s.filename, type: s.type },
				});
				attachments.push({
					key,
					filename: s.filename,
					type: s.type,
					size: s.bytes.byteLength,
				});
			}
			// Staging copies are no longer needed now the encoded job copies exist.
			await Promise.all(staged.map((s) => this.env.BUCKET.delete(s.srcKey).catch(() => {})));
		}

		const now = Date.now();
		const job: BulkJob = {
			id: jobId,
			status: "queued",
			fromEmail: input.fromEmail.toLowerCase(),
			fromName: input.fromName,
			subject: input.subject,
			html: input.html,
			text: input.text,
			total: recipients.length,
			sent: 0,
			failed: 0,
			cursor: 0,
			errors: [],
			createdAt: now,
			updatedAt: now,
			attachments: attachments.length > 0 ? attachments : undefined,
		};
		await this.ctx.storage.put(`bulk:job:${jobId}`, job);
		await this.ctx.storage.put(`bulk:rows:${jobId}`, recipients);
		const queue = (await this.ctx.storage.get<string[]>(BULK_QUEUE_KEY)) ?? [];
		queue.push(jobId);
		await this.ctx.storage.put(BULK_QUEUE_KEY, queue);

		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + 100);
		}
		return { jobId, total: recipients.length };
	}

	async getBulkJob(jobId: string): Promise<BulkJob | null> {
		return (await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`)) ?? null;
	}

	/** Delete a finished job's stashed attachment objects from R2. */
	async #deleteBulkAttachments(job: BulkJob | undefined): Promise<void> {
		if (!job?.attachments?.length) return;
		await this.env.BUCKET.delete(job.attachments.map((a) => a.key)).catch(() => {});
	}

	/** Send the next recipient of the head job, persist progress, reschedule. */
	async alarm(): Promise<void> {
		const queue = (await this.ctx.storage.get<string[]>(BULK_QUEUE_KEY)) ?? [];
		if (queue.length === 0) return;

		const jobId = queue[0];
		const job = await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`);
		const rows = (await this.ctx.storage.get<BulkRecipient[]>(`bulk:rows:${jobId}`)) ?? [];

		// Drop a finished/missing job and move on.
		if (!job || job.status === "done" || job.cursor >= rows.length) {
			if (job && job.cursor >= rows.length) {
				job.status = "done";
				job.updatedAt = Date.now();
				await this.ctx.storage.put(`bulk:job:${jobId}`, job);
			}
			await this.#deleteBulkAttachments(job ?? undefined);
			await this.ctx.storage.delete(`bulk:rows:${jobId}`);
			queue.shift();
			await this.ctx.storage.put(BULK_QUEUE_KEY, queue);
			if (queue.length > 0) await this.ctx.storage.setAlarm(Date.now() + 100);
			return;
		}

		if (job.status === "queued") job.status = "running";

		const row = rows[job.cursor];
		const to = row.email;
		const subject = this.#renderTemplate(job.subject, row, false)
			.replace(/[\r\n]+/g, " ")
			.trim();
		const html = job.html ? this.#renderTemplate(job.html, row, true) : undefined;
		const text = job.text ? this.#renderTemplate(job.text, row, false) : undefined;

		const fromDomain = job.fromEmail.split("@")[1] || "";
		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
		const threadToken = buildThreadToken(messageId, fromDomain);

		try {
			// Re-read the stashed base64 per recipient (one tick = one recipient);
			// the encoded copy was produced once at enqueue time.
			const sesAttachments = job.attachments?.length
				? await Promise.all(
						job.attachments.map(async (a) => {
							const o = await this.env.BUCKET.get(a.key);
							if (!o) throw new Error(`Attachment "${a.filename}" is no longer available.`);
							return {
								content: await o.text(),
								filename: a.filename,
								type: a.type,
								disposition: "attachment" as const,
							};
						}),
					)
				: undefined;
			await sendEmail(this.env, {
				to,
				from: { email: job.fromEmail, name: job.fromName },
				subject,
				html,
				text,
				attachments: sesAttachments,
				headers: buildThreadingHeaders(null, [], threadToken),
			});
			await this.createEmail(
				Folders.SENT,
				{
					id: messageId,
					subject,
					sender: job.fromEmail,
					recipient: to.toLowerCase(),
					date: new Date().toISOString(),
					body: html || text || "",
					thread_id: messageId,
					message_id: outgoingMessageId,
				},
				[],
			);
			job.sent += 1;
		} catch (e) {
			job.failed += 1;
			job.errors.push({ email: to, error: (e as Error).message });
		}

		job.cursor += 1;
		job.updatedAt = Date.now();
		if (job.cursor >= rows.length) {
			job.status = "done";
			await this.#deleteBulkAttachments(job);
			await this.ctx.storage.delete(`bulk:rows:${jobId}`);
			queue.shift();
		}
		await this.ctx.storage.put(`bulk:job:${jobId}`, job);
		await this.ctx.storage.put(BULK_QUEUE_KEY, queue);

		if (queue.length > 0) {
			const delay = BULK_MIN_DELAY_MS + Math.floor(Math.random() * BULK_MAX_JITTER_MS);
			await this.ctx.storage.setAlarm(Date.now() + delay);
		}
	}

	// ── Push subscriptions (WISER-240) ─────────────────────────────
	// Per-device rows for this mailbox. `firePush` fans a payload out to every
	// enabled device best-effort and prunes the ones the push service reports
	// gone. Storage + send + prune are co-located here because the subscriptions
	// are local to the DO (the CRM keys by user; the portal keys by mailbox).

	async upsertPushSubscription(input: {
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		deviceLabel: string;
	}): Promise<{ id: string; deviceLabel: string }> {
		// Re-subscribing the same device yields the same endpoint → refresh its
		// keys + last_seen without minting a new row. device_label / user_agent
		// stay create-only (the first registration's values stick).
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, device_label)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET
			   p256dh = excluded.p256dh,
			   auth = excluded.auth,
			   last_seen_at = datetime('now')`,
			id,
			input.endpoint,
			input.p256dh,
			input.auth,
			input.userAgent,
			input.deviceLabel,
		);
		const [row] = this.ctx.storage.sql.exec<{
			id: string;
			device_label: string;
		}>(`SELECT id, device_label FROM push_subscriptions WHERE endpoint = ?`, input.endpoint);
		if (!row) throw new Error("Push subscription was not stored");
		return { id: row.id, deviceLabel: row.device_label };
	}

	async listPushSubscriptionDevices(): Promise<
		Array<{
			id: string;
			deviceLabel: string | null;
			userAgent: string | null;
			createdAt: string;
			lastSeenAt: string;
		}>
	> {
		// Never returns endpoint / keys — the device list is UX metadata only.
		return [
			...this.ctx.storage.sql.exec<{
				id: string;
				device_label: string | null;
				user_agent: string | null;
				created_at: string;
				last_seen_at: string;
			}>(
				`SELECT id, device_label, user_agent, created_at, last_seen_at
				 FROM push_subscriptions ORDER BY last_seen_at DESC`,
			),
		].map((row) => {
			return {
				id: row.id,
				deviceLabel: row.device_label,
				userAgent: row.user_agent,
				createdAt: row.created_at,
				lastSeenAt: row.last_seen_at,
			};
		});
	}

	async deletePushSubscription(id: string): Promise<boolean> {
		const existing = [
			...this.ctx.storage.sql.exec(`SELECT id FROM push_subscriptions WHERE id = ?`, id),
		];
		if (existing.length === 0) return false;
		this.ctx.storage.sql.exec(`DELETE FROM push_subscriptions WHERE id = ?`, id);
		return true;
	}

	/**
	 * Fan a push out to every device on this mailbox, prune dead endpoints, and
	 * touch the delivered ones. Best-effort and never throws — a push failure or
	 * missing VAPID config must never break mail receipt (the caller fires this
	 * from `receiveEmail` after the mail is already stored).
	 */
	async firePush(payload: PushPayload): Promise<void> {
		try {
			const vapid = vapidConfig(this.env);
			if (!vapid) return; // push not configured for this env — no-op

			const rows = [
				...this.ctx.storage.sql.exec<{
					endpoint: string;
					p256dh: string;
					auth: string;
				}>(`SELECT endpoint, p256dh, auth FROM push_subscriptions`),
			];
			if (rows.length === 0) return;

			const result = await fanOutPush(rows, JSON.stringify(payload), (sub, body) =>
				sendWebPush(sub, body, vapid),
			);
			if (result.delivered < result.attempted) {
				console.warn("[push] delivery incomplete", {
					mailboxId: payload.data.mailboxId,
					attempted: result.attempted,
					delivered: result.delivered,
					pruned: result.deadEndpoints.length,
					failureCounts: result.failureCounts,
				});
			}

			for (const endpoint of result.deadEndpoints) {
				const attemptedSubscription = rows.find((row) => row.endpoint === endpoint);
				if (!attemptedSubscription) continue;
				this.ctx.storage.sql.exec(
					`DELETE FROM push_subscriptions
					 WHERE endpoint = ? AND p256dh = ? AND auth = ?`,
					attemptedSubscription.endpoint,
					attemptedSubscription.p256dh,
					attemptedSubscription.auth,
				);
			}
			for (const endpoint of result.deliveredEndpoints) {
				this.ctx.storage.sql.exec(
					`UPDATE push_subscriptions SET last_seen_at = datetime('now') WHERE endpoint = ?`,
					endpoint,
				);
			}
		} catch (error) {
			console.error("[push] dispatch failed", {
				mailboxId: payload.data.mailboxId,
				error,
			});
		}
	}
}
