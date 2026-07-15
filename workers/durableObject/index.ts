// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
	eq,
	and,
	or,
	asc,
	desc,
	inArray,
	isNotNull,
	lte,
	sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import {
	Folders,
	InternalFolders,
	isInternalFolderId,
} from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { sendEmailWithOutcome } from "../email-sender";
import {
	generateMessageId,
	buildThreadToken,
	buildThreadingHeaders,
} from "../lib/email-helpers";
import {
	arrayBufferToBase64,
	attachmentKey,
	attachmentKeyPrefix,
	uploadKey,
} from "../lib/attachments";
import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";
import { isCanonicalAttachmentUploadId } from "../lib/attachment-upload-id.ts";
import {
	ATTACHMENT_LIMITS,
	validateAttachmentSet,
} from "../../shared/attachments";
import { vapidConfig } from "../lib/push/transport";
import { sendWebPush } from "../lib/push/send";
import type { PushPayload } from "../lib/push/types";
import {
	enqueuePushNotification,
	processPushOutbox,
	readPushHealth,
} from "../lib/push/outbox.ts";
import type { ActivityActor } from "../lib/activity";
import {
	buildMailSearchPlan,
	type MailSearchOptions,
} from "../lib/mail-search";
import {
	outboundDeliveryBlocksGenericLifecycle,
	planMove,
	planTrash,
	resolveRestoreFolder,
} from "../lib/email-lifecycle";
import { mailboxAccess } from "../lib/mailbox-access";
import {
	prepareRecoveredDraftAttachments,
	recoveredDraftId,
	sourceDraftMatchesSnapshot,
} from "../lib/cancelled-outbound-recovery";
import {
	nextBulkEnqueueAt,
	cancellationRecoveryPending,
	planCancelledOutboundRecovery,
	planDispatchQuota,
} from "../lib/outbound-dispatch-policy";
import {
	classifySesOutcome,
	type EnqueueOutboundCommand,
	type OutboundDeliveryActor,
	type OutboundDeliveryStatus,
} from "../lib/outbound-delivery-contract";
import { CONVERSATION_ID_SQL } from "../lib/conversation-identity";
import {
	OutboundRetryCapacityError,
	TruthfulOutboxService,
	type EnqueuedDelivery,
	type StoredOutboundDelivery,
} from "../lib/outbound-delivery-service";
import {
	DurableObjectOutboundDeliveryStorage,
	deserializeOutboundSnapshot,
	type PendingOutboundAttachment,
} from "./outbound-storage";
import {
	executeBatchTriage,
	type BatchTriageRepository,
} from "./batch-triage.ts";
import {
	isBatchTriageActionAllowed,
	type BatchTriageCommand,
} from "../../shared/batch-triage.ts";
import { planBulkEnqueueReconciliation } from "../lib/outbound-enqueue-recovery.ts";
import {
	bulkCleanupBacklogCount,
	bulkCleanupNextAt,
	completeBulkCleanupClaim,
	planBulkCleanupClaim,
	retryBulkCleanupClaim,
	type BulkCleanupIntent,
} from "../lib/bulk-cleanup-intent.ts";
import {
	bulkAdmissionFingerprint,
	bulkAttachmentPreparationKey,
	bulkPersonalizedHtmlValidationError,
	BulkRecipientAttachmentUnavailableError,
	bulkNextUtcDayAt,
	BULK_JOB_ID_PATTERN,
	BULK_OPERATION_ID_PATTERN,
	BULK_LIMITS,
	BULK_PREPARATION_MAX_AGE_MS,
	BULK_STALE_WRITER_VERIFY_MS,
	completeBulkAdmission,
	ensureBulkQueueMembership,
	failBulkAdmission,
	planBulkDailyAdmission,
	planBulkDailyReservation,
	planBulkAdmissionReservation,
	planBulkAdmissionClaim,
	planBulkRecipientEnqueueDisposition,
	renderBulkTemplate,
	removeBulkQueueMembership,
	type BulkAdmissionRecord,
	type BulkAdmissionReservation,
	type BulkDailyAdmissionRecord,
	type BulkDailyReservationRecord,
	type BulkEnqueueResult,
	type BulkReservationResult,
} from "../lib/bulk-job-admission.ts";
import { mailboxSendCutoffs } from "../lib/send-rate-limit.ts";
import { finalizeCommittedOutboundMutation } from "../lib/outbound-liveness.ts";
import {
	validateLabelDefinition,
	validateLabelMutationTargets,
	type LabelMutationTarget,
} from "../lib/labels.ts";
import { resourceCreateReplayCutoff } from "../lib/resource-create-idempotency.ts";
import {
	earliestMailboxAlarm,
	normalizeSnoozeRequest,
	normalizeSnoozeScope,
	planDueSnoozeWake,
	snoozeBlocksGenericMove,
} from "../lib/snooze.ts";
import {
	executeSnooze,
	executeUnsnooze,
	type SnoozeRepository,
} from "./snooze-state.ts";
import { finalizeCommittedSnooze } from "../lib/snooze-liveness.ts";
import { resolveUnambiguousThreadReference } from "../lib/thread-reference.ts";
import { readConversationIntelligenceEvidenceProjection } from "../lib/conversation-intelligence-evidence.ts";
import { projectInboxTriageCandidates } from "../lib/inbox-triage-candidates.ts";
import { readConversationActivityProjection } from "../lib/conversation-activity.ts";
import { readAiSearchInterpreterCatalog } from "../lib/ai-search-interpreter-catalog.ts";
import {
	validateNormalizedInboxTriageSuggestionRequest,
	type NormalizedInboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";
import { readStoredReminderAnchor } from "../lib/follow-up-reminder-anchor.ts";
import { readFollowUpReminderPreviews } from "../lib/follow-up-reminder-previews.ts";
import { followUpReminderD1Store } from "../lib/follow-up-reminders-d1.ts";
import {
	InlineImageMappingError,
	validateResolvedInlineImages,
} from "../lib/inline-image-authority.ts";
import {
	processOneFollowUpReplyCompletion,
	type FollowUpReplyQueueRepository,
} from "../lib/follow-up-reminder-queue.ts";
import {
	readRecipientSuggestions,
	recipientMemoryFolderEligible,
	recordRecipientInteractions,
	seedRecipientInteractions,
	storedEmailInteraction,
} from "../lib/recipient-memory.ts";
import {
	RecipientMemoryOrigins,
	type RecipientMemoryOrigin,
} from "../../shared/recipient-suggestions.ts";
import { classifyDraftCreateReplay } from "../lib/draft-create-replay.ts";
import {
	readGlobalTodayBriefEvidence,
	readGlobalTodayBriefMetadata,
	readTodayBriefCandidates,
	type GlobalTodayBriefEvidenceRequest,
} from "../lib/today-brief-candidates.ts";
import { readGlobalTodayMailboxSnapshot } from "../lib/global-today-mailbox-snapshot.ts";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
	validateNormalizedMailboxAttachmentListOptions,
	type NormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";
import {
	claimImportedEmail as claimImportedEmailRecord,
	releaseImportedEmailClaim as releaseImportedEmailClaimRecord,
	renewImportedEmailClaim as renewImportedEmailClaimRecord,
} from "../lib/import-email-claims.ts";
import {
	readMailboxAttachmentDetail,
	readMailboxAttachmentForEmail,
	readMailboxAttachmentPage,
} from "../lib/mailbox-attachments.ts";
import {
	readMailboxChanges,
	readMailboxCurrentSequence,
} from "../lib/mailbox-change-feed.ts";
import {
	validateNormalizedMailboxChangeQuery,
	type NormalizedMailboxChangeQuery,
} from "../../shared/mailbox-change-feed.ts";
import { createMailPeopleProjector } from "../lib/people/index.ts";
import type {
	NormalizedMailPeopleListQuery,
	NormalizedMailPersonTimelineQuery,
} from "../../shared/mail-people.ts";
import {
	validateMailPersonId,
	validateNormalizedMailPeopleListQuery,
	validateNormalizedMailPersonTimelineQuery,
} from "../../shared/mail-people.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";
import { readRelationshipBriefEvidence } from "../lib/relationship-brief-evidence.ts";
import { AUTOMATION_RUN_STATES } from "../../shared/automation-rules.ts";
import {
	AutomationRuleError,
	createAutomationRulesModule,
	type AutomationRuleVersionRecord,
	type AutomationRuleRecord,
	type AutomationDryRunRecord,
	type AutomationRunRecord,
} from "../lib/automation-rules/index.ts";
import {
	applyAutomationActionPlan,
	readAutomationDryRunContexts,
	readAutomationPlanningContext,
} from "../lib/automation-rules/mailbox-runtime.ts";
import {
	createSemanticIndex,
	type SemanticIndexReadiness,
} from "../lib/semantic-index.ts";
import { advanceSemanticMailboxIndex } from "../lib/semantic-index-runtime.ts";
import { createSemanticIndexProvider } from "../lib/semantic-provider.ts";
import { createWorkersAiSemanticRichDocumentConverter } from "../lib/semantic-attachment-converter.ts";
import { semanticMailboxNamespace } from "../lib/semantic-search.ts";
import { isSemanticSearchEnabled } from "../lib/features.ts";
import { resolveBrand } from "../routes/brand.ts";

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

const SEMANTIC_SCHEDULER_MAILBOX_KEY = "semantic:index:mailbox";
const SEMANTIC_SCHEDULER_FAILURES_KEY = "semantic:index:failures";
const SEMANTIC_SCHEDULER_MAX_FAILURES = 5;

function semanticSchedulerErrorCode(error: unknown): string {
	const name = error instanceof Error ? error.name : "unknown";
	return `scheduler_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(
		0,
		64,
	);
}

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
} satisfies Record<
	SortColumn,
	(typeof schema.emails)[keyof typeof schema.emails]
>;

interface GetEmailsOptions {
	folder?: string;
	label_id?: string;
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
	sender_name?: string | null;
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
	recipient_memory_origin?: RecipientMemoryOrigin | null;
	snooze_wake_thread_id?: string | null;
	follow_up_reply_mailbox_address?: string | null;
	automation_trigger?: "live_inbound";
	push_notification?: PushPayload;
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

const ATTACHMENT_CLEANUP_QUEUE_KEY = "attachment-cleanup:queue";
const DRAFT_SAVE_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DRAFT_SAVE_PRUNE_BATCH = 100;
const DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS = 5 * 60_000;
const DRAFT_SAVE_CLEANUP_MAX_DELAY_MS = 24 * 60 * 60_000;

type AttachmentCleanupJob = {
	id: string;
	emailId: string;
	keys: string[];
	promotionOwner?: string;
	attempts: number;
	createdAt: number;
};
const BULK_QUEUE_KEY = "bulk:queue";
const BULK_ACTIVE_KEY = "bulk:active";
const BULK_TERMINAL_HISTORY_KEY = "bulk:terminal-history";
const BULK_DAILY_ADMISSION_KEY = "bulk:daily-admission";
const BULK_DAILY_RESERVATION_KEY = "bulk:daily-reservation";
const BULK_DAILY_RESERVATION_ACTOR_PREFIX = "bulk:daily-reservation:actor:";
const BULK_RESERVATION_PREFIX = "bulk:reservation:";
const BULK_ATTACHMENT_CLEANUP_PREFIX = "bulk:attachment-cleanup:";
const BULK_RECIPIENT_PREPARATION_PREFIX = "bulk:recipient-preparation:";
const SAFE_BULK_ERRORS = new Set([
	"An attachment upload was not found or has expired. Re-attach and try again.",
	"Bulk attachments could not be prepared. Re-attach them and try again.",
	"Bulk job preparation expired. Start a new submission.",
	"Job cancelled because the initiating user's mailbox access ended.",
	"Recipient could not be queued.",
]);

type BulkRecipient = Record<string, string>; // must include `email`

/** One shared attachment for a bulk job: its immutable raw bytes live in R2. */
interface BulkAttachment {
	key: string; // R2 key holding immutable raw bytes
	filename: string;
	type: string;
	size: number;
}

interface BulkJob {
	id: string;
	operationId: string;
	status: "preparing" | "queued" | "running" | "done" | "failed" | "cancelled";
	actorUserId: string;
	fromEmail: string;
	fromName: string;
	subject: string;
	html?: string;
	text?: string;
	total: number;
	/** Recipient rows durably accepted into the truthful outbox. */
	enqueued: number;
	/** Legacy pre-Outbox counter, read only while an in-flight job upgrades. */
	sent?: number;
	failed: number;
	cursor: number;
	errors: { email: string; error: string }[];
	createdAt: number;
	updatedAt: number;
	/** Earliest time another recipient may be accepted into the outbox. */
	nextEnqueueAt?: number;
	/** Shared attachments delivered to every recipient (manifest only; bytes in R2). */
	attachments?: BulkAttachment[];
	/** Original upload objects retained until the fenced admission commit. */
	preparationAttachmentKeys?: string[];
	/** Cleanup authority for the alarm-owned generation copy. */
	preparationCleanupIntentId?: string;
	preparationGeneration?: number;
}

type BulkActiveEntry = {
	jobId: string;
	admissionKey: string;
	total: number;
	createdAt: number;
};

type BulkTerminalEntry = {
	jobId: string;
	admissionKey: string;
	completedAt: number;
};

type BulkRecipientPreparation = {
	jobId: string;
	cursor: number;
	idempotencyKey: string;
	messageId: string;
	attachments: PendingOutboundAttachment[];
	keys: string[];
	cleanupIntentId: string;
	createdAt: number;
};

type BulkJobProgress = Pick<
	BulkJob,
	| "id"
	| "status"
	| "total"
	| "enqueued"
	| "failed"
	| "cursor"
	| "createdAt"
	| "updatedAt"
> & {
	errors: Array<{ email: string; error: string }>;
	errorCount: number;
	errorsTruncated: boolean;
};

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;
	#semanticPreparation: Promise<SemanticIndexReadiness> | null = null;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	#automationRules() {
		return createAutomationRulesModule({
			storage: {
				sql: this.ctx.storage.sql,
				transactionSync: (run) => this.ctx.storage.transactionSync(run),
			},
		});
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────
	#labelsForEmailIds(emailIds: string[]) {
		const result = new Map<
			string,
			Array<{
				id: string;
				name: string;
				color: string;
			}>
		>();
		if (emailIds.length === 0) return result;
		const rows = this.db
			.select({
				emailId: schema.emailLabels.email_id,
				id: schema.labels.id,
				name: schema.labels.name,
				color: schema.labels.color,
			})
			.from(schema.emailLabels)
			.innerJoin(
				schema.labels,
				eq(schema.labels.id, schema.emailLabels.label_id),
			)
			.where(inArray(schema.emailLabels.email_id, emailIds))
			.orderBy(asc(schema.labels.name))
			.all();
		for (const row of rows) {
			const labels = result.get(row.emailId) ?? [];
			labels.push({ id: row.id, name: row.name, color: row.color });
			result.set(row.emailId, labels);
		}
		return result;
	}

	async getEmails(options: GetEmailsOptions = {}) {
		await this.#selfHealSnoozes();
		const {
			folder,
			label_id,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [
			sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
		];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}
		if (label_id) {
			conditions.push(sql`EXISTS (
				SELECT 1 FROM ${schema.emailLabels}
				WHERE ${schema.emailLabels.email_id} = ${schema.emails.id}
					AND ${schema.emailLabels.label_id} = ${label_id}
			)`);
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
				snooze_source_folder_id: schema.emails.snooze_source_folder_id,
				snoozed_until: schema.emails.snoozed_until,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		const labelsByEmail = this.#labelsForEmailIds(
			result.map((email) => email.id),
		);
		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			labels: labelsByEmail.get(email.id) ?? [],
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(
		options: { folder?: string; thread_id?: string; label_id?: string } = {},
	) {
		await this.#selfHealSnoozes();
		const { folder, thread_id, label_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}
		if (label_id) {
			conditions.push(
				`EXISTS (SELECT 1 FROM email_labels el WHERE el.email_id = emails.id AND el.label_id = ?${params.length + 1})`,
			);
			params.push(label_id);
		}

		conditions.unshift(`folder_id <> '${InternalFolders.RETIRED_OUTBOUND}'`);
		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──
	#visibleFolderId(folderReference: string): string | null {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(
				or(
					eq(schema.folders.id, folderReference),
					eq(schema.folders.name, folderReference),
				),
			)
			.limit(1)
			.get();
		return folder && !isInternalFolderId(folder.id) ? folder.id : null;
	}

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		await this.#selfHealSnoozes();
		const { folder, label_id, page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}
		const visibleFolderId = this.#visibleFolderId(folder);
		if (!visibleFolderId) return [];

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
		const isDraftFolder = visibleFolderId === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
						AND (?4 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?4
						))
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
					lp.draft_group_key as conversation_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				visibleFolderId,
				limit,
				offset,
				label_id ?? null,
			);

			const rows = [...result];
			const labelsByEmail = this.#labelsForEmailIds(
				rows.map((row: any) => String(row.id)),
			);
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
				labels: labelsByEmail.get(String(row.id)) ?? [],
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
					AND (?4 IS NULL OR EXISTS (
						SELECT 1 FROM email_labels el
						WHERE el.email_id = emails.id AND el.label_id = ?4
					))
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					${CONVERSATION_ID_SQL} as conversation_id
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
				WHERE e.folder_id <> '${InternalFolders.RETIRED_OUTBOUND}'
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
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC, id DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC, fe.id DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.snooze_source_folder_id, lif.snoozed_until,
				lif.conversation_id,
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
			ORDER BY lif.date DESC, lif.conversation_id ASC, lif.id ASC
			LIMIT ?2 OFFSET ?3`,
			visibleFolderId,
			limit,
			offset,
			label_id ?? null,
		);

		const rows = [...result];
		const labelsByEmail = this.#labelsForEmailIds(
			rows.map((row: any) => String(row.id)),
		);
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
			labels: labelsByEmail.get(String(row.id)) ?? [],
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string, labelId?: string) {
		await this.#selfHealSnoozes();
		const visibleFolderId = this.#visibleFolderId(folder);
		if (!visibleFolderId) return 0;
		const isDraftFolder = visibleFolderId === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
						AND (?2 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?2
						))`,
					visibleFolderId,
					labelId ?? null,
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
						AND (?2 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?2
						))
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						${CONVERSATION_ID_SQL} as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				visibleFolderId,
				labelId ?? null,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		await this.#selfHealSnoozes();
		const email = this.db
			.select()
			.from(schema.emails)
			.where(
				and(
					eq(schema.emails.id, id),
					sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
				),
			)
			.get();

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
			labels: this.#labelsForEmailIds([id]).get(id) ?? [],
		};
	}

	async getEmailLocation(id: string) {
		if (!id || id.length > 300) return null;
		const row = this.db
			.select({
				emailId: schema.emails.id,
				folderId: schema.emails.folder_id,
			})
			.from(schema.emails)
			.where(
				and(
				eq(schema.emails.id, id),
				sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
				),
			)
			.get();
		return row ?? null;
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		await this.#selfHealSnoozes();
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails
				 WHERE thread_id = ?1 AND folder_id <> ?2
				 ORDER BY date ASC`,
				threadId,
				InternalFolders.RETIRED_OUTBOUND,
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

		const labelsByEmail = this.#labelsForEmailIds(emailIds);
		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
			labels: labelsByEmail.get(email.id) ?? [],
		}));
	}

	async getConversationIntelligenceEvidence(emailId: string) {
		await this.#selfHealSnoozes();
		return readConversationIntelligenceEvidenceProjection(
			this.ctx.storage.sql,
			emailId,
		);
	}

	/** Read a bounded, redacted history projection without recording another event. */
	async getConversationActivity(
		emailId: string,
		limit: number,
		cursor: string | null,
	) {
		return readConversationActivityProjection(this.ctx.storage.sql, {
			emailId,
			limit,
			cursor,
		});
	}

	/** Read folder and label identity only, without healing or changing mail. */
	async getAiSearchInterpreterCatalog() {
		return readAiSearchInterpreterCatalog(this.ctx.storage.sql);
	}

	/** Project the exact visible Inbox page and bounded evidence for manual AI review. */
	async getInboxTriageCandidates(
		request: NormalizedInboxTriageSuggestionRequest,
		mailboxAddress: string,
	) {
		const normalized = validateNormalizedInboxTriageSuggestionRequest(request);
		const rows = await this.getThreadedEmails({
			folder: Folders.INBOX,
			page: normalized.page,
			limit: 25,
			label_id: normalized.labelId ?? undefined,
		});
		return projectInboxTriageCandidates(
			this.ctx.storage.sql,
			rows,
			normalized,
			mailboxAddress,
		);
	}

	/** Resolve reminder identity from stored mail, never from client thread claims. */
	async getFollowUpReminderAnchor(emailId: string) {
		await this.#selfHealSnoozes();
		return readStoredReminderAnchor(this.ctx.storage.sql, emailId);
	}

	/** Project one bounded page of display-only reminder context. */
	async getFollowUpReminderPreviews(
		baselineMessageIds: string[],
		mailboxAddress: string,
	) {
		await this.#selfHealSnoozes();
		return readFollowUpReminderPreviews(
			this.ctx.storage.sql,
			mailboxAddress,
			baselineMessageIds,
		);
	}

	/**
	 * Read the global Today pulse without self-healing, queue work, alarms, or
	 * activity. Merely viewing the cross-Mailbox hub must never mutate mail.
	 */
	async getGlobalTodaySnapshot(
		mailboxAddress: string,
		baselineMessageIds: string[],
	) {
		return readGlobalTodayMailboxSnapshot(
			this.ctx.storage.sql,
			mailboxAddress,
			baselineMessageIds,
		);
	}

	/** Project bounded authoritative mail evidence for one actor's Today brief. */
	async getTodayBriefCandidates(
		mailboxAddress: string,
		reminders: FollowUpReminder[],
		boundaries: { now: string; tomorrowStart: string },
	) {
		await this.#selfHealSnoozes();
		return readTodayBriefCandidates(
			this.ctx.storage.sql,
			mailboxAddress,
			reminders,
			boundaries,
		);
	}

	/** Mutation-free aggregate Today AI metadata. No mail body crosses this RPC. */
	async getGlobalTodayBriefMetadata(
		mailboxAddress: string,
		reminders: FollowUpReminder[],
		boundaries: { now: string; tomorrowStart: string },
	) {
		return readGlobalTodayBriefMetadata(
			this.ctx.storage.sql,
			mailboxAddress,
			reminders,
			boundaries,
		);
	}

	/** Mutation-free evidence for only globally selected compound Conversations. */
	async getGlobalTodayBriefEvidence(
		requests: GlobalTodayBriefEvidenceRequest[],
	) {
		return readGlobalTodayBriefEvidence(this.ctx.storage.sql, requests);
	}

	/** Mutation-free sequence check for aggregate Today AI freshness gates. */
	async getGlobalTodayBriefSequence() {
		return readMailboxCurrentSequence(this.ctx.storage.sql);
	}

	/** Advance the bounded local semantic projection and return truthful readiness. */
	async prepareSemanticIndex() {
		if (!this.#semanticPreparation) {
			this.#semanticPreparation = createSemanticIndex({
				store: this.ctx.storage,
			})
				.prepare()
				.finally(() => {
					this.#semanticPreparation = null;
				});
		}
		return this.#semanticPreparation;
	}

	async readSemanticIndexReadiness() {
		return createSemanticIndex({ store: this.ctx.storage }).readiness();
	}

	/** Persist one autonomous semantic continuation lane for this Mailbox. */
	async scheduleSemanticIndexAdvance(mailboxId: string) {
		const normalized = normalizeMailAddress(mailboxId);
		if (!normalized || normalized !== mailboxId) {
			throw new Error(
				"Semantic scheduler received an invalid Mailbox identity",
			);
		}
		const existing = await this.ctx.storage.get<string>(
			SEMANTIC_SCHEDULER_MAILBOX_KEY,
		);
		if (existing && existing !== normalized) {
			throw new Error("Semantic scheduler Mailbox identity changed");
		}
		if (!existing)
			await this.ctx.storage.put(SEMANTIC_SCHEDULER_MAILBOX_KEY, normalized);
		await this.#scheduleAlarmAt(Date.now() + 100);
	}

	/** Operator repair primitive. The next alarm rebuilds solely from current mail truth. */
	async rebuildSemanticIndex(mailboxId: string) {
		const normalized = normalizeMailAddress(mailboxId);
		if (!normalized || normalized !== mailboxId) {
			throw new Error("Semantic rebuild received an invalid Mailbox identity");
		}
		const existing = await this.ctx.storage.get<string>(
			SEMANTIC_SCHEDULER_MAILBOX_KEY,
		);
		if (existing && existing !== normalized) {
			throw new Error("Semantic rebuild Mailbox identity changed");
		}
		createSemanticIndex({ store: this.ctx.storage }).rebuild();
		await this.ctx.storage.put(SEMANTIC_SCHEDULER_MAILBOX_KEY, normalized);
		await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
		await this.#scheduleAlarmAt(Date.now() + 100);
	}

	/** Lease bounded opaque vector mutations. Content never persists outside this RPC. */
	async leaseSemanticIndexJobs(
		leaseToken: string,
		nowMs: number,
		leaseMs: number,
		limit: number,
	) {
		return createSemanticIndex({ store: this.ctx.storage }).leaseJobs(
			leaseToken,
			nowMs,
			leaseMs,
			limit,
		);
	}

	async submitSemanticIndexJobs(
		jobs: Array<{ vectorId: string; leaseToken: string }>,
		mutationId: string,
		submittedAt: number,
	) {
		return createSemanticIndex({ store: this.ctx.storage }).submitJobs(
			jobs,
			mutationId,
			submittedAt,
		);
	}

	async retrySemanticIndexJobs(
		jobs: Array<{
			vectorId: string;
			leaseToken: string;
			nextAttemptAt: number;
			errorCode: string;
			failedAt: number;
		}>,
	) {
		return createSemanticIndex({ store: this.ctx.storage }).retryJobs(jobs);
	}

	async deferSemanticIndexJobs(
		jobs: Array<{
			vectorId: string;
			leaseToken: string;
			nextAttemptAt: number;
			reasonCode: string;
			deferredAt: number;
		}>,
	) {
		return createSemanticIndex({ store: this.ctx.storage }).deferJobs(jobs);
	}

	async listSubmittedSemanticIndexJobs(limit: number, observedAt: number) {
		return createSemanticIndex({ store: this.ctx.storage }).dueSubmittedJobs(
			observedAt,
			limit,
		);
	}

	async confirmSemanticIndexVisibility(
		observations: Array<{ vectorId: string; visible: boolean }>,
		observedAt: number,
	) {
		createSemanticIndex({ store: this.ctx.storage }).confirmVisibility(
			observations,
			observedAt,
		);
	}

	async leaseSemanticAttachmentExtraction(
		leaseToken: string,
		nowMs: number,
		leaseMs: number,
	) {
		return createSemanticIndex({
			store: this.ctx.storage,
		}).leaseAttachmentExtraction(leaseToken, nowMs, leaseMs);
	}

	async completeSemanticAttachmentExtraction(
		completion: Parameters<
			ReturnType<typeof createSemanticIndex>["completeAttachmentExtraction"]
		>[0],
	) {
		return createSemanticIndex({
			store: this.ctx.storage,
		}).completeAttachmentExtraction(completion);
	}

	async rejectSemanticAttachmentExtraction(
		input: Parameters<
			ReturnType<typeof createSemanticIndex>["rejectAttachmentExtraction"]
		>[0],
	) {
		return createSemanticIndex({
			store: this.ctx.storage,
		}).rejectAttachmentExtraction(input);
	}

	async retrySemanticAttachmentExtraction(
		input: Parameters<
			ReturnType<typeof createSemanticIndex>["retryAttachmentExtraction"]
		>[0],
	) {
		return createSemanticIndex({
			store: this.ctx.storage,
		}).retryAttachmentExtraction(input);
	}

	async resolveSemanticCandidates(
		candidates: ReadonlyArray<{ vectorId: string; score: number }>,
	) {
		const semanticIndex = createSemanticIndex({ store: this.ctx.storage });
		const initiallyResolved = semanticIndex.resolveCandidates(candidates);
		const attachmentAuthority = new Map<string, boolean>();
		await Promise.all(
			initiallyResolved.map(async (candidate) => {
			if (
				candidate.source !== "attachment" ||
				!candidate.attachmentId ||
				!candidate.attachmentStorageFilename
				)
					return;
			const object = await this.env.BUCKET.head(attachmentKey(
				candidate.messageId,
				candidate.attachmentId,
				candidate.attachmentStorageFilename,
			));
			const authoritative = Boolean(
					object &&
					object.version === candidate.r2Version &&
					object.etag === candidate.r2Etag &&
					object.size === candidate.actualSize,
			);
			if (!authoritative) {
				semanticIndex.invalidateAttachmentAuthority({
					vectorId: candidate.vectorId,
					attachmentId: candidate.attachmentId,
					sourceFingerprint: candidate.sourceFingerprint,
					r2Version: candidate.r2Version,
					r2Etag: candidate.r2Etag,
					actualSize: candidate.actualSize,
					errorCode: object ? "r2_authority_changed" : "r2_object_missing",
				});
			}
			attachmentAuthority.set(candidate.vectorId, authoritative);
			}),
		);
		const current = semanticIndex
			.resolveCandidates(candidates)
			.filter(
				(candidate) =>
					candidate.source === "message" ||
					attachmentAuthority.get(candidate.vectorId) === true,
		);
		return {
			candidates: current,
			readiness: semanticIndex.readiness(),
		};
	}

	/** Coordinate paid Today inference across every Worker isolate for this mailbox. */
	async claimTodayBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
		expiresAt: number,
	) {
		const now = Date.now();
		if (
			cacheKey.length < 20 ||
			cacheKey.length > 300 ||
			ownerUserId.length < 1 ||
			ownerUserId.length > 200 ||
			claimToken.length < 16 ||
			claimToken.length > 200 ||
			!Number.isSafeInteger(expiresAt) ||
			expiresAt <= now ||
			expiresAt > now + 5 * 60 * 1_000
		) {
			throw new Error("Today brief generation claim is invalid");
		}
		const current = [
			...this.ctx.storage.sql.exec<{
				owner_user_id: string;
				claim_token: string;
				expires_at: number;
			}>(
				`SELECT owner_user_id, claim_token, expires_at
				 FROM today_brief_generation_claims
				 WHERE cache_key = ?1 LIMIT 1`,
				cacheKey,
			),
		][0];
		if (current && current.expires_at > now) {
			const sameOwner =
				current.owner_user_id === ownerUserId &&
				current.claim_token === claimToken;
			if (sameOwner && expiresAt > current.expires_at) {
				this.ctx.storage.sql.exec(
					`UPDATE today_brief_generation_claims SET expires_at = ?2
					 WHERE cache_key = ?1 AND owner_user_id = ?3 AND claim_token = ?4`,
					cacheKey,
					expiresAt,
					ownerUserId,
					claimToken,
				);
			}
			return sameOwner;
		}
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO today_brief_generation_claims
			 (cache_key, owner_user_id, claim_token, expires_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)`,
			cacheKey,
			ownerUserId,
			claimToken,
			expiresAt,
			now,
		);
		return true;
	}

	async releaseTodayBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
	) {
		if (
			cacheKey.length < 20 ||
			cacheKey.length > 300 ||
			ownerUserId.length < 1 ||
			ownerUserId.length > 200 ||
			claimToken.length < 16 ||
			claimToken.length > 200
		) {
			return false;
		}
		const before =
			[
			...this.ctx.storage.sql.exec<{ total: number }>(
				`SELECT COUNT(*) AS total FROM today_brief_generation_claims
				 WHERE cache_key = ?1 AND owner_user_id = ?2 AND claim_token = ?3`,
				cacheKey,
				ownerUserId,
				claimToken,
			),
		][0]?.total ?? 0;
		if (before === 0) return false;
		this.ctx.storage.sql.exec(
			`DELETE FROM today_brief_generation_claims
			 WHERE cache_key = ?1 AND owner_user_id = ?2 AND claim_token = ?3`,
			cacheKey,
			ownerUserId,
			claimToken,
		);
		return true;
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
		actor: ActivityActor = { kind: "system" },
	) {
		if (read === undefined && starred === undefined) {
			return this.getEmail(id);
		}

		const occurredAt = new Date().toISOString();
		let visible = false;
		this.ctx.storage.transactionSync(() => {
			const current = this.db
				.select({
					id: schema.emails.id,
					read: schema.emails.read,
					starred: schema.emails.starred,
				})
				.from(schema.emails)
				.where(
					and(
						eq(schema.emails.id, id),
						sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
					),
				)
				.get();
			if (!current) return;
			visible = true;
			const data: { read?: number; starred?: number } = {};
			if (read !== undefined && (current.read ?? 0) !== (read ? 1 : 0)) {
				data.read = read ? 1 : 0;
			}
			if (starred !== undefined && (current.starred ?? 0) !== (starred ? 1 : 0)) {
				data.starred = starred ? 1 : 0;
			}
			if (Object.keys(data).length === 0) return;
			this.db
				.update(schema.emails)
				.set(data)
				.where(
					and(
						eq(schema.emails.id, id),
						sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
					),
				)
				.run();
			if (data.read !== undefined) {
				this.#recordActivity(
					actor,
					"email_updated",
					"email",
					id,
					{ read },
					occurredAt,
				);
			}
			if (data.starred !== undefined) {
				this.#recordActivity(
					actor,
					"email_updated",
					"email",
					id,
					{ starred },
					occurredAt,
				);
			}
		});

		return visible ? this.getEmail(id) : null;
	}

	async markThreadRead(
		threadId: string,
		actor: ActivityActor = { kind: "system" },
	) {
		const occurredAt = new Date().toISOString();
		let markedRead = false;
		this.ctx.storage.transactionSync(() => {
			const visibleUnread = [
				...this.ctx.storage.sql.exec(
					`SELECT 1 FROM emails
				 WHERE thread_id = ? AND read = 0 AND folder_id <> ?
				 LIMIT 1`,
					threadId,
					InternalFolders.RETIRED_OUTBOUND,
				),
			];
			if (visibleUnread.length === 0) return;
			this.ctx.storage.sql.exec(
				`UPDATE emails SET read = 1
				 WHERE thread_id = ? AND read = 0 AND folder_id <> ?`,
				threadId,
				InternalFolders.RETIRED_OUTBOUND,
			);
			markedRead = true;
			this.#recordActivity(
				actor,
				"thread_marked_read",
				"thread",
				threadId,
				{},
				occurredAt,
			);
		});
		return { threadId, markedRead };
	}

	#conversationScope(conversationId: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(
				or(eq(schema.folders.id, folderId), eq(schema.folders.name, folderId)),
			)
			.limit(1)
			.get();
		if (!folder || isInternalFolderId(folder.id)) return null;
		const rows = [
			...this.ctx.storage.sql.exec(
				`WITH
			folder_emails AS (
				SELECT id, thread_id,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = ?1
			),
			thread_to_conversation AS (
				SELECT raw_thread_id,
					${CONVERSATION_ID_SQL} as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			)
			SELECT fe.id
			FROM folder_emails fe
			LEFT JOIN thread_to_conversation tc ON fe.raw_thread_id = tc.raw_thread_id
			WHERE COALESCE(tc.conversation_id, fe.raw_thread_id) = ?2`,
				folder.id,
				conversationId,
			),
		] as Array<{ id: string }>;
		return { folderId: folder.id, emailIds: rows.map((row) => row.id) };
	}

	async setConversationRead(
		conversationId: string,
		folderId: string,
		read: boolean,
		actor: ActivityActor = { kind: "system" },
	) {
		const scope = this.#conversationScope(conversationId, folderId);
		if (!scope || scope.emailIds.length === 0) {
			return { status: "not_found" as const, affectedCount: 0 };
		}
		const occurredAt = new Date().toISOString();
		let affectedCount = 0;
		this.ctx.storage.transactionSync(() => {
			const changedIds = this.db
				.select({ id: schema.emails.id })
				.from(schema.emails)
				.where(
					and(
						inArray(schema.emails.id, scope.emailIds),
						sql`COALESCE(${schema.emails.read}, 0) <> ${read ? 1 : 0}`,
					),
				)
				.all()
				.map((row) => row.id);
			affectedCount = changedIds.length;
			if (affectedCount === 0) return;
			this.db
				.update(schema.emails)
				.set({ read: read ? 1 : 0 })
				.where(inArray(schema.emails.id, changedIds))
				.run();
			this.#recordActivity(
				actor,
				"conversation_read_state_changed",
				"conversation",
				conversationId,
				{
					folderId: scope.folderId,
					read,
					affectedCount,
				},
				occurredAt,
			);
		});
		return { status: "updated" as const, affectedCount };
	}

	async archiveConversation(
		conversationId: string,
		folderId: string,
		representativeEmailId: string,
		actor: ActivityActor = { kind: "system" },
	) {
		return this.#moveConversationInFolder(
			conversationId,
			folderId,
			Folders.ARCHIVE,
			representativeEmailId,
			actor,
		);
	}

	async trashConversation(
		conversationId: string,
		folderId: string,
		representativeEmailId: string,
		actor: ActivityActor = { kind: "system" },
	) {
		return this.#moveConversationInFolder(
			conversationId,
			folderId,
			Folders.TRASH,
			representativeEmailId,
			actor,
		);
	}

	async batchTriage(command: BatchTriageCommand, actor: ActivityActor) {
		const repository: BatchTriageRepository = {
			transaction: (run) => this.ctx.storage.transactionSync(run),
			resolveFolder: (folderId) => this.#visibleFolderId(folderId),
			resolveTarget: (target) => {
				const folderId = this.#visibleFolderId(target.folderId);
				if (!folderId) return null;
				if (!target.conversationId) {
					const email = this.db
						.select({ id: schema.emails.id })
						.from(schema.emails)
						.where(
							and(
								eq(schema.emails.id, target.emailId),
								eq(schema.emails.folder_id, folderId),
							),
						)
						.get();
					return email ? { emailIds: [email.id], folderId } : null;
				}

				const scope = this.#conversationScope(target.conversationId, folderId);
				if (!scope || !scope.emailIds.includes(target.emailId)) return null;
				return { emailIds: scope.emailIds, folderId: scope.folderId };
			},
			isTargetStateSatisfied: (target, targetFolderId) => {
				const folderId = this.#visibleFolderId(targetFolderId);
				if (!folderId) return false;
				if (!target.conversationId) {
					return Boolean(
						this.db
							.select({ id: schema.emails.id })
							.from(schema.emails)
							.where(
								and(
									eq(schema.emails.id, target.emailId),
									eq(schema.emails.folder_id, folderId),
								),
							)
							.get(),
					);
				}
				const scope = this.#conversationScope(target.conversationId, folderId);
				return Boolean(scope?.emailIds.includes(target.emailId));
			},
			hasActiveOutbound: (emailIds) =>
				Boolean(
					this.db
						.select({ id: schema.outboundDeliveries.id })
						.from(schema.outboundDeliveries)
						.where(
							and(
								inArray(schema.outboundDeliveries.email_id, emailIds),
								inArray(schema.outboundDeliveries.status, [
									"queued",
									"sending",
									"retrying",
								]),
							),
						)
						.limit(1)
						.get(),
				),
			setRead: (emailIds, read) => {
				const changedIds = this.db
					.select({ id: schema.emails.id })
					.from(schema.emails)
					.where(
						and(
							inArray(schema.emails.id, emailIds),
							sql`COALESCE(${schema.emails.read}, 0) <> ${read ? 1 : 0}`,
						),
					)
					.all()
					.map((row) => row.id);
				if (changedIds.length === 0) return 0;
				this.db
					.update(schema.emails)
					.set({ read: read ? 1 : 0 })
					.where(inArray(schema.emails.id, changedIds))
					.run();
				return changedIds.length;
			},
			move: (emailIds, fromFolderId, toFolderId) => {
				const occurredAt = new Date().toISOString();
				this.db
					.update(schema.emails)
					.set({
						folder_id: toFolderId,
						...(toFolderId === Folders.TRASH
							? { previous_folder_id: fromFolderId, trashed_at: occurredAt }
							: { previous_folder_id: null, trashed_at: null }),
					})
					.where(inArray(schema.emails.id, emailIds))
					.run();
			},
			recordActivity: ({
				actor: activityActor,
				action,
				target,
				affectedCount,
			}) => {
				this.#recordActivity(
					activityActor,
					action,
					target.conversationId ? "conversation" : "email",
					target.conversationId ?? target.emailId,
					{
						representativeEmailId: target.emailId,
						folderId: target.folderId,
						affectedCount,
					},
				);
			},
		};
		return executeBatchTriage(repository, command, actor);
	}

	#snoozeRepository(): SnoozeRepository {
		return {
			transaction: (run) => this.ctx.storage.transactionSync(run),
			resolveScope: (scope, mode) => {
				const folderReference =
					mode === "unsnooze"
					? Folders.SNOOZED
					: scope.kind === "conversation"
						? scope.folderId
						: null;
				let emailIds: string[];
				if (scope.kind === "message") {
					emailIds = [scope.emailId];
				} else {
					const conversation = this.#conversationScope(
						scope.conversationId,
						folderReference!,
					);
					if (!conversation || !conversation.emailIds.includes(scope.emailId)) {
						return null;
					}
					if (conversation.emailIds.length > 100) return { tooLarge: true };
					emailIds = conversation.emailIds;
				}
				const rows = this.db
					.select({
						id: schema.emails.id,
						folderId: schema.emails.folder_id,
						sourceFolderId: schema.emails.snooze_source_folder_id,
					})
					.from(schema.emails)
					.where(inArray(schema.emails.id, emailIds))
					.all();
				if (rows.length !== emailIds.length) return null;
				return rows;
			},
			hasActiveOutbound: (emailIds) =>
				Boolean(
				this.db
					.select({ id: schema.outboundDeliveries.id })
					.from(schema.outboundDeliveries)
						.where(
							and(
						inArray(schema.outboundDeliveries.email_id, emailIds),
								inArray(schema.outboundDeliveries.status, [
									"queued",
									"sending",
									"retrying",
								]),
							),
						)
					.limit(1)
					.get(),
			),
			folderExists: (folderId) =>
				Boolean(
				this.db
					.select({ id: schema.folders.id })
					.from(schema.folders)
					.where(eq(schema.folders.id, folderId))
					.get(),
			),
			applySnooze: ({ emailIds, sourceFolderId, wakeAt }) => {
				this.db
					.update(schema.emails)
					.set({
						folder_id: Folders.SNOOZED,
						snooze_source_folder_id: sourceFolderId,
						snoozed_until: wakeAt,
						previous_folder_id: null,
						trashed_at: null,
					})
					.where(inArray(schema.emails.id, emailIds))
					.run();
			},
			clearSnooze: ({ targets }) => {
				for (const target of targets) {
					this.db
						.update(schema.emails)
						.set({
							folder_id: target.folderId,
							snooze_source_folder_id: null,
							snoozed_until: null,
						})
						.where(eq(schema.emails.id, target.id))
						.run();
				}
			},
			recordActivity: ({ actor, action, entityType, entityId, metadata }) =>
				this.#recordActivity(actor, action, entityType, entityId, metadata),
		};
	}

	async snooze(input: unknown, actor: ActivityActor = { kind: "system" }) {
		const request = normalizeSnoozeRequest(input);
		const result = executeSnooze(this.#snoozeRepository(), request, actor);
		if (result.status === "snoozed") {
			await finalizeCommittedSnooze({
				ensureAlarm: () => this.#scheduleAlarmAt(Date.parse(request.wakeAt)),
				logFailure: (error) =>
					console.error("failed to schedule Snooze wake alarm", {
					wakeAt: request.wakeAt,
					error: error instanceof Error ? error.message : String(error),
				}),
			});
		}
		return result;
	}

	async unsnooze(input: unknown, actor: ActivityActor = { kind: "system" }) {
		return executeUnsnooze(
			this.#snoozeRepository(),
			normalizeSnoozeScope(input),
			actor,
		);
	}

	#moveConversationInFolder(
		conversationId: string,
		folderId: string,
		targetFolderId: string,
		representativeEmailId: string,
		actor: ActivityActor,
	) {
		const sourceFolderId = this.#visibleFolderId(folderId);
		const policyFolderId = sourceFolderId ?? folderId;
		const action = targetFolderId === Folders.ARCHIVE ? "archive" : "trash";
		if (!isBatchTriageActionAllowed(action, policyFolderId)) {
			return { status: "invalid_action" as const, affectedCount: 0 };
		}
		const target = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, targetFolderId))
			.get();
		if (!target || isInternalFolderId(target.id)) {
			return { status: "not_found" as const, affectedCount: 0 };
		}
		const targetScope = this.#conversationScope(conversationId, target.id);
		if (targetScope?.emailIds.includes(representativeEmailId)) {
			return {
				status: target.id === Folders.TRASH
					? ("trashed" as const)
					: ("archived" as const),
				affectedCount: 0,
			};
		}
		if (!sourceFolderId) {
			return { status: "not_found" as const, affectedCount: 0 };
		}

		const scope = this.#conversationScope(conversationId, sourceFolderId);
		if (
			!scope ||
			scope.emailIds.length === 0 ||
			!scope.emailIds.includes(representativeEmailId)
		) {
			return { status: "not_found" as const, affectedCount: 0 };
		}
		if (scope.folderId === Folders.SNOOZED) {
			return {
				status: "snoozed_state_requires_unsnooze" as const,
				affectedCount: 0,
			};
		}
		const snoozedMember = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(
				and(
				inArray(schema.emails.id, scope.emailIds),
				or(
					eq(schema.emails.folder_id, Folders.SNOOZED),
					isNotNull(schema.emails.snoozed_until),
					isNotNull(schema.emails.snooze_source_folder_id),
				),
				),
			)
			.limit(1)
			.get();
		if (snoozedMember) {
			return {
				status: "snoozed_state_requires_unsnooze" as const,
				affectedCount: 0,
			};
		}
		const active = this.db
			.select({ id: schema.outboundDeliveries.id })
			.from(schema.outboundDeliveries)
			.where(
				and(
					inArray(schema.outboundDeliveries.email_id, scope.emailIds),
					inArray(schema.outboundDeliveries.status, [
						"queued",
						"sending",
						"retrying",
					]),
				),
			)
			.limit(1)
			.get();
		if (active) {
			return { status: "outbound_delivery_active" as const, affectedCount: 0 };
		}
		const occurredAt = new Date().toISOString();
		const isTrash = target.id === Folders.TRASH;
		this.ctx.storage.transactionSync(() => {
			this.db
				.update(schema.emails)
				.set({
					folder_id: target.id,
					...(isTrash
						? { previous_folder_id: scope.folderId, trashed_at: occurredAt }
						: { previous_folder_id: null, trashed_at: null }),
				})
				.where(inArray(schema.emails.id, scope.emailIds))
				.run();
			this.#recordActivity(
				actor,
				isTrash ? "conversation_trashed" : "conversation_archived",
				"conversation",
				conversationId,
				{
					fromFolderId: scope.folderId,
					toFolderId: target.id,
					affectedCount: scope.emailIds.length,
				},
				occurredAt,
			);
		});
		return {
			status: isTrash ? ("trashed" as const) : ("archived" as const),
			affectedCount: scope.emailIds.length,
		};
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				snooze_source_folder_id: schema.emails.snooze_source_folder_id,
				snoozed_until: schema.emails.snoozed_until,
				draft_version: schema.emails.draft_version,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (
			!email ||
			isInternalFolderId(email.folder_id) ||
			snoozeBlocksGenericMove({
				folderId: email.folder_id,
				wakeAt: email.snoozed_until,
				sourceFolderId: email.snooze_source_folder_id,
			})
		)
			return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		const occurredAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			this.#markDraftCreateOperation(
				id,
				"deleted",
				email.draft_version,
				occurredAt,
			);
			this.#refreshTerminalDraftSaveRetention(id, occurredAt);
			this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
		});

		return emailAttachments;
	}

	/** Permanently remove only a draft the user explicitly chose to discard. */
	async discardDraft(
		id: string,
		expectedVersion: number,
		actor: ActivityActor = { kind: "system" },
	) {
		const email = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				draft_version: schema.emails.draft_version,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;
		if (email.folder_id !== Folders.DRAFT) {
			return { status: "not_draft" as const };
		}
		if (email.draft_version !== expectedVersion) {
			return {
				status: "version_conflict" as const,
				currentVersion: email.draft_version,
			};
		}

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();
		const occurredAt = new Date().toISOString();

		this.ctx.storage.transactionSync(() => {
			this.#markDraftCreateOperation(
				id,
				"discarded",
				expectedVersion,
				occurredAt,
			);
			this.#refreshTerminalDraftSaveRetention(id, occurredAt);
			this.db
				.delete(schema.emails)
				.where(
					and(
						eq(schema.emails.id, id),
						eq(schema.emails.draft_version, expectedVersion),
					),
				)
				.run();
			this.#recordActivity(
				actor,
				"draft_discarded",
				"email",
				id,
				{ attachmentCount: emailAttachments.length },
				occurredAt,
			);
		});

		return { status: "discarded" as const, attachments: emailAttachments };
	}

	#applyDraftUpdate(input: {
		draftId: string;
		expectedVersion: number;
		changes: { recipient: string; subject: string; body: string };
		actor: ActivityActor;
	}) {
		const draft = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				draft_version: schema.emails.draft_version,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, input.draftId))
			.get();
		if (!draft) return null;
		if (draft.folder_id !== Folders.DRAFT) {
			return { status: "not_draft" as const };
		}
		if (draft.draft_version !== input.expectedVersion) {
			return {
				status: "version_conflict" as const,
				currentVersion: draft.draft_version,
			};
		}

		const occurredAt = new Date().toISOString();
		const resultVersion = input.expectedVersion + 1;
		this.db
			.update(schema.emails)
			.set({
				recipient: input.changes.recipient.toLowerCase(),
				subject: input.changes.subject,
				body: input.changes.body,
				date: occurredAt,
				draft_version: resultVersion,
			})
			.where(
				and(
					eq(schema.emails.id, input.draftId),
					eq(schema.emails.draft_version, input.expectedVersion),
				),
			)
			.run();
		this.#markDraftCreateOperation(
			input.draftId,
			"active",
			resultVersion,
			occurredAt,
		);
		this.#recordActivity(
			input.actor,
			"draft_updated",
			"email",
			input.draftId,
			{},
			occurredAt,
		);
		return {
			status: "updated" as const,
			draftId: input.draftId,
			draftVersion: resultVersion,
			occurredAt,
		};
	}

	async updateDraft(
		id: string,
		expectedVersion: number,
		changes: { recipient: string; subject: string; body: string },
		actor: ActivityActor = { kind: "system" },
	) {
		const result = this.ctx.storage.transactionSync(() =>
			this.#applyDraftUpdate({
				draftId: id,
				expectedVersion,
				changes,
				actor,
			}),
		);
		if (!result || result.status !== "updated") return result;
		return {
			status: result.status,
			draftId: result.draftId,
			draftVersion: result.draftVersion,
		};
	}

	async getDraftUpdateOutcome(updateKey: string, fingerprint: string) {
		const operation = this.db
			.select()
			.from(schema.draftUpdateOperations)
			.where(eq(schema.draftUpdateOperations.update_key, updateKey))
			.get();
		if (!operation) return { status: "missing" as const };
		if (operation.fingerprint !== fingerprint) {
			return { status: "conflict" as const };
		}
		return {
			status: "replay" as const,
			draftId: operation.draft_id,
			resultVersion: operation.result_version,
		};
	}

	async updateDraftIdempotently(input: {
		updateKey: string;
		fingerprint: string;
		draftId: string;
		expectedVersion: number;
		changes: { recipient: string; subject: string; body: string };
		actor?: ActivityActor;
	}) {
		return this.ctx.storage.transactionSync(() => {
			const prior = this.db
				.select()
				.from(schema.draftUpdateOperations)
				.where(eq(schema.draftUpdateOperations.update_key, input.updateKey))
				.get();
			if (prior) {
				return prior.fingerprint === input.fingerprint
					? {
							status: "replay" as const,
							draftId: prior.draft_id,
							draftVersion: prior.result_version,
						}
					: { status: "idempotency_conflict" as const };
			}

			const result = this.#applyDraftUpdate({
				draftId: input.draftId,
				expectedVersion: input.expectedVersion,
				changes: input.changes,
				actor: input.actor ?? { kind: "system" },
			});
			if (!result) return { status: "not_found" as const };
			if (result.status !== "updated") return result;
			this.db
				.insert(schema.draftUpdateOperations)
				.values({
					update_key: input.updateKey,
					fingerprint: input.fingerprint,
					draft_id: input.draftId,
					previous_version: input.expectedVersion,
					result_version: result.draftVersion,
					committed_at: result.occurredAt,
				})
				.run();
			return {
				status: "updated" as const,
				draftId: input.draftId,
				draftVersion: result.draftVersion,
			};
		});
	}

	#getDraftCreateRecord(createKey: string): {
		id: string;
		fingerprint: string;
		draftVersion: number;
		state: "active" | "discarded" | "consumed" | "deleted" | "unavailable";
	} | null {
		const row = this.db
			.select({
				id: schema.draftCreateOperations.draft_id,
				fingerprint: schema.draftCreateOperations.fingerprint,
				draft_version: schema.draftCreateOperations.draft_version,
				state: schema.draftCreateOperations.state,
			})
			.from(schema.draftCreateOperations)
			.where(eq(schema.draftCreateOperations.create_key, createKey))
			.limit(1)
			.get();
		return row
			? {
					id: row.id,
					fingerprint: row.fingerprint,
					draftVersion: row.draft_version,
					state: row.state,
				}
			: null;
	}

	#markDraftCreateOperation(
		draftId: string,
		state: "active" | "discarded" | "consumed" | "deleted" | "unavailable",
		draftVersion: number,
		updatedAt: string,
	) {
		this.db
			.update(schema.draftCreateOperations)
			.set({
				state,
				draft_version: draftVersion,
				updated_at: updatedAt,
			})
			.where(eq(schema.draftCreateOperations.draft_id, draftId))
			.run();
	}

	#refreshTerminalDraftSaveRetention(draftId: string, updatedAt: string) {
		this.db
			.update(schema.draftSaveOperations)
			.set({ updated_at: updatedAt })
			.where(
				and(
					eq(schema.draftSaveOperations.draft_id, draftId),
					inArray(schema.draftSaveOperations.state, ["committed", "aborted"]),
				),
			)
			.run();
	}

	#getDraftCreateReplay(createKey: string, fingerprint: string) {
		const record = this.#getDraftCreateRecord(createKey);
		if (
			record &&
			record.fingerprint === fingerprint &&
			record.state !== "active"
		) {
			return {
				status: "unavailable" as const,
				draftId: record.id,
				currentVersion: record.draftVersion,
				reason: record.state,
			};
		}
		const replay = classifyDraftCreateReplay(record, fingerprint);
		if (replay.status !== "replay") return replay;
		if (!record) return { status: "missing" as const };
		const draft = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, replay.draftId))
			.get();
		if (!draft || draft.folder_id !== Folders.DRAFT) {
			return {
				status: "unavailable" as const,
				draftId: replay.draftId,
				currentVersion: draft?.draft_version ?? record.draftVersion,
				reason: "unavailable" as const,
			};
		}
		if (draft.draft_version !== 1) {
			return {
				status: "superseded" as const,
				draftId: replay.draftId,
				currentVersion: draft.draft_version,
			};
		}
		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, replay.draftId))
			.all();
		return {
			status: "replay" as const,
			draftId: replay.draftId,
			draft: {
				...draft,
				read: !!draft.read,
				starred: !!draft.starred,
				attachments: emailAttachments,
				labels: this.#labelsForEmailIds([replay.draftId]).get(replay.draftId) ?? [],
			},
		};
	}

	async getDraftCreateReplay(createKey: string, fingerprint: string) {
		return this.#getDraftCreateReplay(createKey, fingerprint);
	}

	async claimDraftSave(input: {
		saveKey: string;
		fingerprint: string;
		draftId: string;
		expectedVersion: number;
		claimToken: string;
		claimExpiresAt: number;
	}) {
		const claim = this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const retentionCutoff = new Date(
				now - DRAFT_SAVE_REPLAY_RETENTION_MS,
			).toISOString();
			this.ctx.storage.sql.exec(
				`DELETE FROM draft_save_operations
				 WHERE save_key IN (
					SELECT save_key
					FROM draft_save_operations
					WHERE state IN ('committed', 'aborted')
					  AND updated_at <= ?
					ORDER BY updated_at, save_key
					LIMIT ?
				 )`,
				retentionCutoff,
				DRAFT_SAVE_PRUNE_BATCH,
			);
			const existingOperation = this.db
				.select()
				.from(schema.draftSaveOperations)
				.where(eq(schema.draftSaveOperations.save_key, input.saveKey))
				.get();
			if (
				existingOperation &&
				(existingOperation.fingerprint !== input.fingerprint ||
					existingOperation.draft_id !== input.draftId ||
					existingOperation.expected_version !== input.expectedVersion)
			) {
				return { status: "key_conflict" as const };
			}
			if (existingOperation?.state === "committed") {
				return {
					status: "committed" as const,
					draftId: existingOperation.draft_id,
					committedVersion: existingOperation.committed_version,
					claimToken: existingOperation.claim_token,
				};
			}
			if (
				existingOperation?.state === "claimed" &&
				existingOperation.claim_expires_at > now
			) {
				return { status: "in_progress" as const };
			}

			const expiredOperations = this.db
				.select({
					saveKey: schema.draftSaveOperations.save_key,
					destinationKeys: schema.draftSaveOperations.destination_keys,
					claimToken: schema.draftSaveOperations.claim_token,
				})
				.from(schema.draftSaveOperations)
				.where(
					and(
						eq(schema.draftSaveOperations.draft_id, input.draftId),
						eq(
							schema.draftSaveOperations.expected_version,
							input.expectedVersion,
						),
						eq(schema.draftSaveOperations.state, "claimed"),
						lte(schema.draftSaveOperations.claim_expires_at, now),
					),
				)
				.all();
			const stalePromotions = expiredOperations.flatMap((operation) => {
				const parsed: unknown = JSON.parse(operation.destinationKeys);
				const destinationKeys = Array.isArray(parsed)
					? parsed.filter((key): key is string => typeof key === "string")
					: [];
				return destinationKeys.length > 0
					? [{
							destinationKeys,
							promotionOwner: operation.claimToken ?? operation.saveKey,
						}]
					: [];
			});
			const occurredAt = new Date(now).toISOString();
			for (const stalePromotion of stalePromotions) {
				this.db
					.insert(schema.draftSaveCleanupIntents)
					.values({
						claim_token: stalePromotion.promotionOwner,
						draft_id: input.draftId,
						destination_keys: JSON.stringify(stalePromotion.destinationKeys),
						next_attempt_at: now + DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS,
						verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
						attempts: 0,
						updated_at: occurredAt,
					})
					.onConflictDoUpdate({
						target: schema.draftSaveCleanupIntents.claim_token,
						set: {
							destination_keys: JSON.stringify(stalePromotion.destinationKeys),
							next_attempt_at: now + DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS,
							verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
							updated_at: occurredAt,
						},
					})
					.run();
			}
			this.db
				.update(schema.draftSaveOperations)
				.set({ state: "aborted", updated_at: new Date(now).toISOString() })
				.where(
					and(
						eq(schema.draftSaveOperations.draft_id, input.draftId),
						eq(
							schema.draftSaveOperations.expected_version,
							input.expectedVersion,
						),
						eq(schema.draftSaveOperations.state, "claimed"),
						lte(schema.draftSaveOperations.claim_expires_at, now),
					),
				)
				.run();
			const competingOperation = this.db
				.select({ saveKey: schema.draftSaveOperations.save_key })
				.from(schema.draftSaveOperations)
				.where(
					and(
						eq(schema.draftSaveOperations.draft_id, input.draftId),
						eq(
							schema.draftSaveOperations.expected_version,
							input.expectedVersion,
						),
						eq(schema.draftSaveOperations.state, "claimed"),
					),
				)
				.get();
			if (competingOperation) {
				return { status: "revision_in_progress" as const };
			}

			const draft = this.db
				.select({
					folderId: schema.emails.folder_id,
					draftVersion: schema.emails.draft_version,
				})
				.from(schema.emails)
				.where(eq(schema.emails.id, input.draftId))
				.get();
			if (input.expectedVersion === 0) {
				if (draft) {
					return {
						status: "version_conflict" as const,
						currentVersion: draft.draftVersion,
					};
				}
			} else if (!draft) {
				return { status: "not_found" as const };
			} else if (draft.folderId !== Folders.DRAFT) {
				return { status: "not_draft" as const };
			} else if (draft.draftVersion !== input.expectedVersion) {
				return {
					status: "version_conflict" as const,
					currentVersion: draft.draftVersion,
				};
			}

			this.db
				.insert(schema.draftSaveOperations)
				.values({
					save_key: input.saveKey,
					fingerprint: input.fingerprint,
					draft_id: input.draftId,
					expected_version: input.expectedVersion,
					state: "claimed",
					destination_keys: "[]",
					committed_version: null,
					claim_expires_at: input.claimExpiresAt,
					claim_token: input.claimToken,
					updated_at: occurredAt,
				})
				.onConflictDoUpdate({
					target: schema.draftSaveOperations.save_key,
					set: {
						state: "claimed",
						destination_keys: "[]",
						committed_version: null,
						claim_expires_at: input.claimExpiresAt,
						claim_token: input.claimToken,
						updated_at: occurredAt,
					},
				})
				.run();
			return { status: "claimed" as const, stalePromotions };
		});
		if (claim.status === "claimed" && claim.stalePromotions.length > 0) {
			await this.#scheduleAlarmAt(
				Date.now() + DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS,
			);
		}
		return claim;
	}

	async recordDraftSavePromotion(
		saveKey: string,
		fingerprint: string,
		claimToken: string,
		destinationKeys: string[],
	) {
		return this.ctx.storage.transactionSync(() => {
			const serializedDestinationKeys = JSON.stringify(destinationKeys);
			this.db
				.update(schema.draftSaveOperations)
				.set({
					destination_keys: serializedDestinationKeys,
					updated_at: new Date().toISOString(),
				})
				.where(
					and(
						eq(schema.draftSaveOperations.save_key, saveKey),
						eq(schema.draftSaveOperations.fingerprint, fingerprint),
						eq(schema.draftSaveOperations.claim_token, claimToken),
						eq(schema.draftSaveOperations.state, "claimed"),
					),
				)
				.run();
			const recorded = this.db
				.select({ destinationKeys: schema.draftSaveOperations.destination_keys })
				.from(schema.draftSaveOperations)
				.where(
					and(
						eq(schema.draftSaveOperations.save_key, saveKey),
						eq(schema.draftSaveOperations.fingerprint, fingerprint),
						eq(schema.draftSaveOperations.claim_token, claimToken),
						eq(schema.draftSaveOperations.state, "claimed"),
					),
				)
				.get();
			return recorded?.destinationKeys === serializedDestinationKeys;
		});
	}

	async abortDraftSave(saveKey: string, fingerprint: string, claimToken: string) {
		return this.ctx.storage.transactionSync(() => {
			const operation = this.db
				.select({ destinationKeys: schema.draftSaveOperations.destination_keys })
				.from(schema.draftSaveOperations)
				.where(
					and(
						eq(schema.draftSaveOperations.save_key, saveKey),
						eq(schema.draftSaveOperations.fingerprint, fingerprint),
						eq(schema.draftSaveOperations.claim_token, claimToken),
						eq(schema.draftSaveOperations.state, "claimed"),
					),
				)
				.get();
			if (!operation) return { status: "not_claimed" as const, destinationKeys: [] };
			this.db
				.update(schema.draftSaveOperations)
				.set({ state: "aborted", updated_at: new Date().toISOString() })
				.where(
					and(
						eq(schema.draftSaveOperations.save_key, saveKey),
						eq(schema.draftSaveOperations.fingerprint, fingerprint),
						eq(schema.draftSaveOperations.claim_token, claimToken),
						eq(schema.draftSaveOperations.state, "claimed"),
					),
				)
				.run();
			const parsed: unknown = JSON.parse(operation.destinationKeys);
			return {
				status: "aborted" as const,
				promotionOwner: claimToken,
				destinationKeys: Array.isArray(parsed)
					? parsed.filter((key): key is string => typeof key === "string")
					: [],
			};
		});
	}

	async getDraftSaveOutcome(saveKey: string, fingerprint: string) {
		const operation = this.db
			.select()
			.from(schema.draftSaveOperations)
			.where(eq(schema.draftSaveOperations.save_key, saveKey))
			.get();
		if (!operation) return { status: "missing" as const };
		if (operation.fingerprint !== fingerprint) {
			return { status: "key_conflict" as const };
		}
		return {
			status: operation.state,
			draftId: operation.draft_id,
			committedVersion: operation.committed_version,
			claimToken: operation.claim_token,
		};
	}

	async getCommittedDraftAttachmentScope(
		draftId: string,
		committedVersion: number,
	) {
		const operation = this.db
			.select({
				saveKey: schema.draftSaveOperations.save_key,
				claimToken: schema.draftSaveOperations.claim_token,
			})
			.from(schema.draftSaveOperations)
			.where(
				and(
					eq(schema.draftSaveOperations.draft_id, draftId),
					eq(schema.draftSaveOperations.state, "committed"),
					eq(
						schema.draftSaveOperations.committed_version,
						committedVersion,
					),
				),
			)
			.orderBy(desc(schema.draftSaveOperations.updated_at))
			.limit(1)
			.get();
		return operation ? operation.claimToken ?? operation.saveKey : null;
	}

	/**
	 * Create or replace a draft in one SQL transaction. Existing drafts require
	 * an exact expected version so two browser sessions cannot silently replace
	 * each other's content or attachment rows.
	 */
	async upsertDraft(
		input: {
			id: string;
			expectedVersion?: number;
			createKey?: string;
			createFingerprint?: string;
			subject: string;
			sender: string;
			recipient: string;
			cc: string | null;
			bcc: string | null;
			body: string;
			in_reply_to: string | null;
			thread_id: string;
			saveKey?: string;
			saveFingerprint?: string;
			saveClaimToken?: string;
		},
		attachments: AttachmentData[],
		actor: ActivityActor = { kind: "system" },
	) {
		return this.ctx.storage.transactionSync(() => {
			const hasSaveClaim = Boolean(
				input.saveKey || input.saveFingerprint || input.saveClaimToken,
			);
			if (
				hasSaveClaim &&
				(!input.saveKey || !input.saveFingerprint || !input.saveClaimToken)
			) {
				return { status: "save_claim_lost" as const };
			}
			if (input.saveKey && input.saveFingerprint && input.saveClaimToken) {
				const claim = this.db
					.select()
					.from(schema.draftSaveOperations)
					.where(eq(schema.draftSaveOperations.save_key, input.saveKey))
					.get();
				if (
					!claim ||
					claim.fingerprint !== input.saveFingerprint ||
					claim.claim_token !== input.saveClaimToken ||
					claim.draft_id !== input.id ||
					claim.expected_version !== (input.expectedVersion ?? 0) ||
					claim.state !== "claimed"
				) {
					return { status: "save_claim_lost" as const };
				}
			}
			if (input.createKey && input.createFingerprint) {
				const replay = this.#getDraftCreateReplay(
					input.createKey,
					input.createFingerprint,
				);
				if (replay.status === "replay") {
					return {
						status: "creation_replay" as const,
						draftId: replay.draftId,
						draft: replay.draft,
					};
				}
				if (replay.status === "conflict") {
					return { ...replay, status: "creation_conflict" as const };
				}
				if (replay.status === "superseded") {
					return { ...replay, status: "creation_superseded" as const };
				}
				if (replay.status === "unavailable") {
					return { ...replay, status: "creation_unavailable" as const };
				}
			}
			const existing = this.db
				.select({
					id: schema.emails.id,
					folder_id: schema.emails.folder_id,
					draft_version: schema.emails.draft_version,
				})
				.from(schema.emails)
				.where(eq(schema.emails.id, input.id))
				.get();
			if (existing && existing.folder_id !== Folders.DRAFT) {
				return { status: "not_draft" as const };
			}
			if (!existing && input.expectedVersion !== undefined) {
				return { status: "not_found" as const };
			}
			if (
				existing &&
				(input.expectedVersion === undefined ||
					existing.draft_version !== input.expectedVersion)
			) {
				return {
					status: "version_conflict" as const,
					currentVersion: existing.draft_version,
				};
			}

			const replacedAttachments = existing
				? this.db
						.select({
							id: schema.attachments.id,
							filename: schema.attachments.filename,
						})
						.from(schema.attachments)
						.where(eq(schema.attachments.email_id, input.id))
						.all()
				: [];
			const draftVersion = existing ? existing.draft_version + 1 : 1;
			const occurredAt = new Date().toISOString();

			if (existing) {
				this.db
					.update(schema.emails)
					.set({
						subject: input.subject,
						sender: input.sender,
						recipient: input.recipient,
						cc: input.cc,
						bcc: input.bcc,
						date: occurredAt,
						body: input.body,
						in_reply_to: input.in_reply_to,
						thread_id: input.thread_id,
						draft_version: draftVersion,
					})
					.where(
						and(
							eq(schema.emails.id, input.id),
							eq(schema.emails.draft_version, input.expectedVersion!),
						),
					)
					.run();
				this.db
					.delete(schema.attachments)
					.where(eq(schema.attachments.email_id, input.id))
					.run();
				this.#markDraftCreateOperation(
					input.id,
					"active",
					draftVersion,
					occurredAt,
				);
			} else {
				this.db
					.insert(schema.emails)
					.values({
						id: input.id,
						folder_id: Folders.DRAFT,
						subject: input.subject,
						sender: input.sender,
						recipient: input.recipient,
						cc: input.cc,
						bcc: input.bcc,
						date: occurredAt,
						read: 0,
						starred: 0,
						body: input.body,
						in_reply_to: input.in_reply_to,
						thread_id: input.thread_id,
						draft_create_key: input.createKey ?? null,
						draft_create_fingerprint: input.createFingerprint ?? null,
						draft_version: draftVersion,
					})
					.run();
				if (input.createKey && input.createFingerprint) {
					this.db
						.insert(schema.draftCreateOperations)
						.values({
							create_key: input.createKey,
							fingerprint: input.createFingerprint,
							draft_id: input.id,
							draft_version: 1,
							state: "active",
							updated_at: occurredAt,
						})
						.run();
				}
			}
			if (attachments.length > 0) {
				this.db.insert(schema.attachments).values(attachments).run();
			}
			if (input.saveKey && input.saveFingerprint && input.saveClaimToken) {
				this.db
					.update(schema.draftSaveOperations)
					.set({
						state: "committed",
						committed_version: draftVersion,
						updated_at: occurredAt,
					})
					.where(
						and(
							eq(schema.draftSaveOperations.save_key, input.saveKey),
							eq(
								schema.draftSaveOperations.fingerprint,
								input.saveFingerprint,
							),
							eq(
								schema.draftSaveOperations.claim_token,
								input.saveClaimToken,
							),
							eq(schema.draftSaveOperations.state, "claimed"),
						),
					)
					.run();
			}
			this.#recordActivity(
				actor,
				existing ? "draft_updated" : "draft_created",
				"email",
				input.id,
				{ draftVersion },
				occurredAt,
			);
			return {
				status: "saved" as const,
				draftId: input.id,
				draftVersion,
				replacedAttachments,
			};
		});
	}

	/** Consume only the exact draft revision captured by the outbound snapshot. */
	async consumeDraftVersion(
		id: string,
		expectedVersion: number,
		actor: ActivityActor = { kind: "system" },
	) {
		return this.ctx.storage.transactionSync(() => {
			const draft = this.db
				.select({
					id: schema.emails.id,
					folder_id: schema.emails.folder_id,
					draft_version: schema.emails.draft_version,
				})
				.from(schema.emails)
				.where(eq(schema.emails.id, id))
				.get();
			if (!draft) return { status: "missing" as const };
			if (draft.folder_id !== Folders.DRAFT) {
				return { status: "not_draft" as const };
			}
			if (draft.draft_version !== expectedVersion) {
				return {
					status: "version_changed" as const,
					currentVersion: draft.draft_version,
				};
			}
			const draftAttachments = this.db
				.select({
					id: schema.attachments.id,
					filename: schema.attachments.filename,
				})
				.from(schema.attachments)
				.where(eq(schema.attachments.email_id, id))
				.all();
			const occurredAt = new Date().toISOString();
			this.#markDraftCreateOperation(
				id,
				"consumed",
				expectedVersion,
				occurredAt,
			);
			this.#refreshTerminalDraftSaveRetention(id, occurredAt);
			this.db
				.delete(schema.emails)
				.where(
					and(
						eq(schema.emails.id, id),
						eq(schema.emails.draft_version, expectedVersion),
					),
				)
				.run();
			this.#recordActivity(
				actor,
				"draft_consumed_after_delivery",
				"email",
				id,
				{ draftVersion: expectedVersion },
				occurredAt,
			);
			return {
				status: "consumed" as const,
				attachments: draftAttachments,
			};
		});
	}

	#nextDraftSaveCleanupAt() {
		return this.db
			.select({ nextAttemptAt: schema.draftSaveCleanupIntents.next_attempt_at })
			.from(schema.draftSaveCleanupIntents)
			.orderBy(
				asc(schema.draftSaveCleanupIntents.next_attempt_at),
				asc(schema.draftSaveCleanupIntents.claim_token),
			)
			.limit(1)
			.get()?.nextAttemptAt ?? null;
	}

	async #processDraftSaveCleanup(now: number): Promise<number | null> {
		const intent = this.db
			.select()
			.from(schema.draftSaveCleanupIntents)
			.where(lte(schema.draftSaveCleanupIntents.next_attempt_at, now))
			.orderBy(
				asc(schema.draftSaveCleanupIntents.next_attempt_at),
				asc(schema.draftSaveCleanupIntents.claim_token),
			)
			.limit(1)
			.get();
		if (!intent) return this.#nextDraftSaveCleanupAt();

		let succeeded = false;
		try {
			const parsed: unknown = JSON.parse(intent.destination_keys);
			const keys = Array.isArray(parsed)
				? parsed.filter((key): key is string => typeof key === "string")
				: [];
			const ownedKeys: string[] = [];
			for (const key of keys) {
				const object = await this.env.BUCKET.get(key);
				if (object?.customMetadata?.promotionOwner === intent.claim_token) {
					ownedKeys.push(key);
				}
			}
			if (ownedKeys.length > 0) await this.env.BUCKET.delete(ownedKeys);
			succeeded = true;
		} catch (error) {
			console.error("[draft-save-cleanup] verification failed", {
				draftId: intent.draft_id,
				attempts: intent.attempts + 1,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const completedAt = Date.now();
		this.ctx.storage.transactionSync(() => {
			const current = this.db
				.select()
				.from(schema.draftSaveCleanupIntents)
				.where(
					eq(
						schema.draftSaveCleanupIntents.claim_token,
						intent.claim_token,
					),
				)
				.get();
			if (!current) return;
			if (succeeded && completedAt >= current.verify_until) {
				this.db
					.delete(schema.draftSaveCleanupIntents)
					.where(
						eq(
							schema.draftSaveCleanupIntents.claim_token,
							intent.claim_token,
						),
					)
					.run();
				return;
			}
			const attempts = current.attempts + 1;
			const delay = Math.min(
				DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS * 2 ** Math.min(attempts, 8),
				DRAFT_SAVE_CLEANUP_MAX_DELAY_MS,
			);
			this.db
				.update(schema.draftSaveCleanupIntents)
				.set({
					attempts,
					next_attempt_at: completedAt + delay,
					updated_at: new Date(completedAt).toISOString(),
				})
				.where(
					eq(
						schema.draftSaveCleanupIntents.claim_token,
						intent.claim_token,
					),
				)
				.run();
		});
		return this.#nextDraftSaveCleanupAt();
	}

	async queueAttachmentCleanup(
		emailId: string,
		keys: string[],
		actor: ActivityActor = { kind: "system" },
		promotionOwner?: string,
	) {
		if (keys.length === 0) return;
		const queue =
			(await this.ctx.storage.get<AttachmentCleanupJob[]>(
				ATTACHMENT_CLEANUP_QUEUE_KEY,
			)) ?? [];
		queue.push({
			id: crypto.randomUUID(),
			emailId,
			keys,
			...(promotionOwner ? { promotionOwner } : {}),
			attempts: 0,
			createdAt: Date.now(),
		});
		await this.ctx.storage.put(ATTACHMENT_CLEANUP_QUEUE_KEY, queue);
		this.#recordActivity(actor, "attachment_cleanup_queued", "email", emailId, {
			objectCount: keys.length,
		});
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm > Date.now() + 100) {
			await this.ctx.storage.setAlarm(Date.now() + 100);
		}
	}

	async #processAttachmentCleanup(): Promise<boolean> {
		const queue =
			(await this.ctx.storage.get<AttachmentCleanupJob[]>(
				ATTACHMENT_CLEANUP_QUEUE_KEY,
			)) ?? [];
		const job = queue[0];
		if (!job) return false;
		let succeeded = false;
		try {
			if (job.promotionOwner) {
				const ownedKeys: string[] = [];
				for (const key of job.keys) {
					const object = await this.env.BUCKET.get(key);
					if (object?.customMetadata?.promotionOwner === job.promotionOwner) {
						ownedKeys.push(key);
					}
				}
				if (ownedKeys.length > 0) await this.env.BUCKET.delete(ownedKeys);
			} else {
				await this.env.BUCKET.delete(job.keys);
			}
			succeeded = true;
			this.#recordActivity(
				{ kind: "system" },
				"attachment_cleanup_completed",
				"email",
				job.emailId,
				{ objectCount: job.keys.length, attempts: job.attempts + 1 },
			);
		} catch (error) {
			console.error("[attachment-cleanup] retry failed", {
				emailId: job.emailId,
				attempts: job.attempts + 1,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// R2 I/O yields the input gate. Re-read before finalization so a cleanup
		// queued during that yield cannot be overwritten by this job's old snapshot.
		const latestQueue =
			(await this.ctx.storage.get<AttachmentCleanupJob[]>(
				ATTACHMENT_CLEANUP_QUEUE_KEY,
			)) ?? [];
		const latestJob = latestQueue.find((candidate) => candidate.id === job.id);
		if (succeeded) {
			const remaining = latestQueue.filter((candidate) => candidate.id !== job.id);
			await this.ctx.storage.put(ATTACHMENT_CLEANUP_QUEUE_KEY, remaining);
			return remaining.length > 0;
		}
		if (latestJob) latestJob.attempts += 1;
		await this.ctx.storage.put(ATTACHMENT_CLEANUP_QUEUE_KEY, latestQueue);
		return latestQueue.length > 0;
	}

	#activeOutboundDeliveryForEmail(emailId: string) {
		const delivery = this.db
			.select({
				id: schema.outboundDeliveries.id,
				status: schema.outboundDeliveries.status,
			})
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.email_id, emailId))
			.limit(1)
			.get();
		return delivery &&
			outboundDeliveryBlocksGenericLifecycle(
				delivery.status as OutboundDeliveryStatus,
			)
			? delivery
			: undefined;
	}

	/** Move user-visible mail to Trash without ever permanently deleting it. */
	async trashEmail(id: string, actor: ActivityActor = { kind: "system" }) {
		const email = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				snooze_source_folder_id: schema.emails.snooze_source_folder_id,
				snoozed_until: schema.emails.snoozed_until,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;
		if (isInternalFolderId(email.folder_id)) {
			return { status: "protected_internal_state" as const };
		}
		if (
			snoozeBlocksGenericMove({
			folderId: email.folder_id,
			wakeAt: email.snoozed_until,
			sourceFolderId: email.snooze_source_folder_id,
			})
		) {
			return { status: "snoozed_state_requires_unsnooze" as const };
		}
		const activeDelivery = this.#activeOutboundDeliveryForEmail(id);
		if (activeDelivery) {
			return {
				status: "outbound_delivery_active" as const,
				deliveryId: activeDelivery.id,
			};
		}

		const plan = planTrash(email.folder_id);
		if (plan.status === "already_trashed") return plan;

		const occurredAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			this.db
				.update(schema.emails)
				.set({
					folder_id: Folders.TRASH,
					previous_folder_id: plan.previousFolderId,
					trashed_at: occurredAt,
				})
				.where(eq(schema.emails.id, id))
				.run();
			this.#recordActivity(
				actor,
				"email_trashed",
				"email",
				id,
				{ fromFolderId: email.folder_id },
				occurredAt,
			);
		});

		return { status: "trashed" as const };
	}

	/** Restore an email from Trash to its previous folder, or Inbox as fallback. */
	async restoreEmail(id: string, actor: ActivityActor = { kind: "system" }) {
		const email = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				previous_folder_id: schema.emails.previous_folder_id,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;
		if (email.folder_id !== Folders.TRASH) {
			return { status: "not_trashed" as const };
		}

		const previousFolder = email.previous_folder_id
			? this.db
					.select({ id: schema.folders.id })
					.from(schema.folders)
					.where(eq(schema.folders.id, email.previous_folder_id))
					.get()
			: null;
		const folderId = resolveRestoreFolder(
			email.previous_folder_id,
			Boolean(previousFolder),
		);
		const occurredAt = new Date().toISOString();

		this.ctx.storage.transactionSync(() => {
			this.db
				.update(schema.emails)
				.set({
					folder_id: folderId,
					previous_folder_id: null,
					trashed_at: null,
				})
				.where(eq(schema.emails.id, id))
				.run();
			this.#recordActivity(
				actor,
				"email_restored",
				"email",
				id,
				{ toFolderId: folderId },
				occurredAt,
			);
		});

		return { status: "restored" as const, folderId };
	}

	#recordActivity(
		actor: ActivityActor,
		action: string,
		entityType: string,
		entityId: string,
		metadata: Record<string, unknown>,
		occurredAt = new Date().toISOString(),
	) {
		this.db
			.insert(schema.activityEvents)
			.values({
				id: crypto.randomUUID(),
				actor_kind: actor.kind,
				actor_id: actor.id ?? null,
				action,
				entity_type: entityType,
				entity_id: entityId,
				metadata_json: JSON.stringify(metadata),
				occurred_at: occurredAt,
			})
			.run();
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select({ attachment: schema.attachments })
				.from(schema.attachments)
				.innerJoin(
					schema.emails,
					eq(schema.emails.id, schema.attachments.email_id),
				)
				.where(
					and(
						eq(schema.attachments.id, id),
						sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
					),
				)
				.get()?.attachment ?? null
		);
	}

	async listMailboxAttachments(
		options: NormalizedMailboxAttachmentListOptions,
	) {
		return readMailboxAttachmentPage(
			this.ctx.storage.sql,
			validateNormalizedMailboxAttachmentListOptions(options),
		);
	}

	async getMailboxAttachment(attachmentId: string) {
		if (!attachmentId || attachmentId.length > 300) return null;
		return readMailboxAttachmentDetail(this.ctx.storage.sql, attachmentId);
	}

	/** Exact byte authority: path email and attachment identities must match one visible row. */
	async getAttachmentForEmail(emailId: string, attachmentId: string) {
		return readMailboxAttachmentForEmail(
			this.ctx.storage.sql,
			emailId,
			attachmentId,
		);
	}

	async listMailboxChanges(options: NormalizedMailboxChangeQuery) {
		return readMailboxChanges(
			this.ctx.storage.sql,
			validateNormalizedMailboxChangeQuery(options),
		);
	}

	async claimImportedEmail(emailId: string, legacyId: string, token: string) {
		if (
			!emailId ||
			emailId.length > 300 ||
			!legacyId ||
			legacyId.length > 300 ||
			token.length < 16 ||
			token.length > 100
		)
			throw new Error("Import claim identity is invalid");
		const now = Date.now();
		return this.ctx.storage.transactionSync(() =>
			claimImportedEmailRecord(
				this.ctx.storage.sql,
				emailId,
				legacyId,
				token,
				now,
				now + 15 * 60_000,
			),
		);
	}

	async releaseImportedEmailClaim(emailId: string, token: string) {
		if (
			!emailId ||
			emailId.length > 300 ||
			token.length < 16 ||
			token.length > 100
		)
			return;
		this.ctx.storage.transactionSync(() =>
			releaseImportedEmailClaimRecord(this.ctx.storage.sql, emailId, token),
		);
	}

	async renewImportedEmailClaim(emailId: string, token: string) {
		if (
			!emailId ||
			emailId.length > 300 ||
			token.length < 16 ||
			token.length > 100
		)
			return false;
		const now = Date.now();
		return this.ctx.storage.transactionSync(() =>
			renewImportedEmailClaimRecord(
				this.ctx.storage.sql,
				emailId,
				token,
				now,
				now + 15 * 60_000,
			),
		);
	}

	async hasEmailOrThreadIdentity(identity: string) {
		if (!identity || identity.length > 300) return false;
		const row = [
			...this.ctx.storage.sql.exec<{ found: number }>(
			`SELECT 1 AS found FROM emails
			 WHERE id = ?1 OR thread_id = ?1 LIMIT 1`,
			identity,
			),
		][0];
		return row?.found === 1;
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		await this.#selfHealSnoozes();
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
			.where(sql`${schema.folders.id} <> ${InternalFolders.RETIRED_OUTBOUND}`)
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async listLabels() {
		return this.db
			.select({
				id: schema.labels.id,
				name: schema.labels.name,
				color: schema.labels.color,
				createdAt: schema.labels.created_at,
				updatedAt: schema.labels.updated_at,
			})
			.from(schema.labels)
			.orderBy(asc(schema.labels.name))
			.all();
	}

	async createLabel(
		name: string,
		color: string,
		actor: ActivityActor = { kind: "system" },
	) {
		const definition = validateLabelDefinition(name, color);
		const now = new Date().toISOString();
		const label = {
			id: `label_${crypto.randomUUID()}`,
			name: definition.name,
			normalized_name: definition.normalizedName,
			color: definition.color,
			created_at: now,
			updated_at: now,
		};
		this.ctx.storage.transactionSync(() => {
			this.db.insert(schema.labels).values(label).run();
			this.#recordActivity(
				actor,
				"label_created",
				"label",
				label.id,
				{ name: label.name, color: label.color },
				now,
			);
		});
		return {
			id: label.id,
			name: label.name,
			color: label.color,
			createdAt: label.created_at,
			updatedAt: label.updated_at,
		};
	}

  async createMailboxResourceIdempotently(input: {
    kind: "folder" | "label";
    operationKey: string;
    fingerprint: string;
    resourceId: string;
    name: string;
    color?: string;
    actor: ActivityActor;
  }) {
    const now = new Date().toISOString();
    const cutoff = resourceCreateReplayCutoff(Date.now());
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM resource_create_operations
				 WHERE operation_key IN (
					 SELECT operation_key FROM resource_create_operations
					 WHERE state IN ('superseded', 'unavailable') AND updated_at < ?1
					 ORDER BY CASE WHEN operation_key = ?2 THEN 0 ELSE 1 END,
					          updated_at, operation_key
					 LIMIT 100
				 )`,
        cutoff,
        input.operationKey,
      );
      const operation = this.db
        .select()
        .from(schema.resourceCreateOperations)
        .where(
          eq(schema.resourceCreateOperations.operation_key, input.operationKey),
        )
        .get();
      if (operation) {
        if (operation.fingerprint !== input.fingerprint) {
          return { status: "idempotency_conflict" as const };
        }
        if (operation.state !== "active") {
          return {
            status:
              operation.state === "superseded"
                ? ("creation_superseded" as const)
                : ("creation_unavailable" as const),
            resourceId: operation.resource_id,
            currentRevision: operation.updated_at,
          };
        }
        const resource =
          input.kind === "folder"
            ? this.db
                .select({
                  id: schema.folders.id,
                  name: schema.folders.name,
                  unreadCount:
                    sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(
                      Number,
                    ),
                })
                .from(schema.folders)
                .leftJoin(
                  schema.emails,
                  eq(schema.emails.folder_id, schema.folders.id),
                )
                .where(eq(schema.folders.id, operation.resource_id))
                .groupBy(schema.folders.id, schema.folders.name)
                .get()
            : this.db
                .select({
                  id: schema.labels.id,
                  name: schema.labels.name,
                  color: schema.labels.color,
                  createdAt: schema.labels.created_at,
                  updatedAt: schema.labels.updated_at,
                })
                .from(schema.labels)
                .where(eq(schema.labels.id, operation.resource_id))
                .get();
        if (!resource) {
          this.db
            .update(schema.resourceCreateOperations)
            .set({ state: "unavailable", updated_at: now })
            .where(
              eq(
                schema.resourceCreateOperations.operation_key,
                input.operationKey,
              ),
            )
            .run();
          return {
            status: "creation_unavailable" as const,
            resourceId: operation.resource_id,
            currentRevision: now,
          };
        }
        return {
          status: "replayed" as const,
          resource,
        };
      }

      try {
        let resource;
        if (input.kind === "folder") {
          resource = this.db
            .insert(schema.folders)
            .values({ id: input.resourceId, name: input.name, is_deletable: 1 })
            .returning({ id: schema.folders.id, name: schema.folders.name })
            .get();
          this.#recordActivity(
            input.actor,
            "folder_created",
            "folder",
            resource.id,
            { name: resource.name },
            now,
          );
          resource = { ...resource, unreadCount: 0 };
        } else {
          const definition = validateLabelDefinition(
            input.name,
            input.color ?? "",
          );
          const row = {
            id: input.resourceId,
            name: definition.name,
            normalized_name: definition.normalizedName,
            color: definition.color,
            created_at: now,
            updated_at: now,
          };
          this.db.insert(schema.labels).values(row).run();
          this.#recordActivity(
            input.actor,
            "label_created",
            "label",
            row.id,
            { name: row.name, color: row.color },
            now,
          );
          resource = {
            id: row.id,
            name: row.name,
            color: row.color,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }
        this.db
          .insert(schema.resourceCreateOperations)
          .values({
            operation_key: input.operationKey,
            resource_kind: input.kind,
            fingerprint: input.fingerprint,
            resource_id: input.resourceId,
            state: "active",
            updated_at: now,
          })
          .run();
        return { status: "created" as const, resource };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
        ) {
          return { status: "name_conflict" as const };
        }
        throw error;
      }
    });
  }

	async updateLabel(
		id: string,
		name: string,
		color: string,
		actor: ActivityActor = { kind: "system" },
	) {
		const definition = validateLabelDefinition(name, color);
		const now = new Date().toISOString();
    const current = this.db
      .select({
        id: schema.labels.id,
        name: schema.labels.name,
        color: schema.labels.color,
        createdAt: schema.labels.created_at,
        updatedAt: schema.labels.updated_at,
      })
      .from(schema.labels)
      .where(eq(schema.labels.id, id))
      .get();
    if (!current) return null;
    if (
      current.name === definition.name &&
      current.color === definition.color
    ) {
      return current;
    }
		let updated: { id: string } | undefined;
		this.ctx.storage.transactionSync(() => {
			updated = this.db
				.update(schema.labels)
				.set({
					name: definition.name,
					normalized_name: definition.normalizedName,
					color: definition.color,
					updated_at: now,
				})
				.where(eq(schema.labels.id, id))
				.returning({ id: schema.labels.id })
				.get();
			if (updated) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "superseded", updated_at: now })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "label"),
              eq(schema.resourceCreateOperations.resource_id, id),
              eq(schema.resourceCreateOperations.state, "active"),
            ),
          )
          .run();
				this.#recordActivity(
					actor,
					"label_updated",
					"label",
					id,
					{ name: definition.name, color: definition.color },
					now,
				);
			}
		});
		return updated
			? { id, name: definition.name, color: definition.color, updatedAt: now }
			: null;
	}

	async deleteLabel(id: string, actor: ActivityActor = { kind: "system" }) {
		this.#assertAutomationTargetUnused({ labelId: id });
		const now = new Date().toISOString();
		let deleted: { id: string } | undefined;
		this.ctx.storage.transactionSync(() => {
			deleted = this.db
				.delete(schema.labels)
				.where(eq(schema.labels.id, id))
				.returning({ id: schema.labels.id })
				.get();
			if (deleted) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "unavailable", updated_at: now })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "label"),
              eq(schema.resourceCreateOperations.resource_id, id),
              inArray(schema.resourceCreateOperations.state, [
                "active",
                "superseded",
              ]),
            ),
          )
          .run();
				this.#recordActivity(actor, "label_deleted", "label", id, {}, now);
			}
		});
		return Boolean(deleted);
	}

	async mutateLabels(
		input: {
			labelId: string;
			action: "apply" | "remove";
			targets: LabelMutationTarget[];
		},
		actor: ActivityActor = { kind: "system" },
	) {
		const targets = validateLabelMutationTargets(input.targets);
		const label = this.db
			.select({ id: schema.labels.id })
			.from(schema.labels)
			.where(eq(schema.labels.id, input.labelId))
			.get();
		if (!label) return { status: "label_not_found" as const, results: [] };

		const results: Array<{
			emailId: string;
			status: "updated" | "not_found" | "outbound_delivery_active";
			affectedCount: number;
		}> = [];
		for (const target of targets) {
			const folderId = this.#visibleFolderId(target.folderId);
			const scope =
				target.conversationId && folderId
					? this.#conversationScope(target.conversationId, folderId)
					: null;
			const emailIds = scope
				? scope.emailIds
				: folderId
					? this.db
							.select({ id: schema.emails.id })
							.from(schema.emails)
							.where(
								and(
									eq(schema.emails.id, target.emailId),
									eq(schema.emails.folder_id, folderId),
								),
							)
							.all()
							.map((row) => row.id)
					: [];
			if (
				emailIds.length === 0 ||
				(target.conversationId && !emailIds.includes(target.emailId))
			) {
				results.push({
					emailId: target.emailId,
					status: "not_found",
					affectedCount: 0,
				});
				continue;
			}
			const existingIds = new Set(
				this.db
					.select({ emailId: schema.emailLabels.email_id })
					.from(schema.emailLabels)
					.where(
						and(
							eq(schema.emailLabels.label_id, input.labelId),
							inArray(schema.emailLabels.email_id, emailIds),
						),
					)
					.all()
					.map((row) => row.emailId),
			);
			const changedIds = input.action === "apply"
				? emailIds.filter((emailId) => !existingIds.has(emailId))
				: emailIds.filter((emailId) => existingIds.has(emailId));
			if (changedIds.length === 0) {
				results.push({
					emailId: target.emailId,
					status: "updated",
					affectedCount: 0,
				});
				continue;
			}
			const active = this.db
				.select({ id: schema.outboundDeliveries.id })
				.from(schema.outboundDeliveries)
				.where(
					and(
						inArray(schema.outboundDeliveries.email_id, changedIds),
						inArray(schema.outboundDeliveries.status, [
							"queued",
							"sending",
							"retrying",
						]),
					),
				)
				.limit(1)
				.get();
			if (active) {
				results.push({
					emailId: target.emailId,
					status: "outbound_delivery_active",
					affectedCount: 0,
				});
				continue;
			}
			const now = new Date().toISOString();
			this.ctx.storage.transactionSync(() => {
				if (input.action === "apply") {
					this.db
						.insert(schema.emailLabels)
						.values(
							changedIds.map((emailId) => ({
								email_id: emailId,
								label_id: input.labelId,
								created_at: now,
							})),
						)
						.onConflictDoNothing()
						.run();
				} else {
					this.db
						.delete(schema.emailLabels)
						.where(
							and(
								eq(schema.emailLabels.label_id, input.labelId),
								inArray(schema.emailLabels.email_id, changedIds),
							),
						)
						.run();
				}
				this.#recordActivity(
					actor,
					input.action === "apply" ? "label_applied" : "label_removed",
					target.conversationId ? "conversation" : "email",
					target.conversationId ?? target.emailId,
					{ labelId: input.labelId, affectedCount: changedIds.length },
					now,
				);
			});
			results.push({
				emailId: target.emailId,
				status: "updated",
				affectedCount: changedIds.length,
			});
		}
		return { status: "completed" as const, results };
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
			if (
				e instanceof Error &&
				e.message.includes("UNIQUE constraint failed")
			) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		if (isInternalFolderId(id)) return null;
    const current = this.db
      .select({ id: schema.folders.id, name: schema.folders.name })
      .from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();
    if (!current || current.name === name) return current ?? null;
    let result: { id: string; name: string } | undefined;
    this.ctx.storage.transactionSync(() => {
      result = this.db
        .update(schema.folders)
        .set({ name })
        .where(eq(schema.folders.id, id))
        .returning({ id: schema.folders.id, name: schema.folders.name })
        .get();
      if (result) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "superseded", updated_at: new Date().toISOString() })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "folder"),
              eq(schema.resourceCreateOperations.resource_id, id),
              eq(schema.resourceCreateOperations.state, "active"),
            ),
          )
          .run();
      }
    });
		return result;
	}

	async deleteFolder(id: string, actor: ActivityActor = { kind: "system" }) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder) return "not_found" as const;
		if (folder.is_deletable === 0) return "protected" as const;
		this.#assertAutomationTargetUnused({ folderId: id });

		let deleted: { id: string } | undefined;
		const occurredAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			deleted = this.db
				.delete(schema.folders)
				.where(
					and(
						eq(schema.folders.id, id),
						sql`NOT EXISTS (
							SELECT 1 FROM ${schema.emails}
							WHERE ${schema.emails.folder_id} = ${schema.folders.id}
						)`,
					),
				)
				.returning({ id: schema.folders.id })
				.get();
			if (deleted) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "unavailable", updated_at: occurredAt })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "folder"),
              eq(schema.resourceCreateOperations.resource_id, id),
              inArray(schema.resourceCreateOperations.state, [
                "active",
                "superseded",
              ]),
            ),
          )
          .run();
				this.#recordActivity(
					actor,
					"folder_deleted",
					"folder",
					id,
					{},
					occurredAt,
				);
			}
		});

		return deleted ? ("deleted" as const) : ("not_empty" as const);
	}

	async moveEmail(
		id: string,
		folderId: string,
		actor: ActivityActor = { kind: "system" },
	) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder || isInternalFolderId(folder.id)) return false;
		if (folder.id === Folders.SNOOZED) {
			return { status: "snoozed_state_requires_explicit_action" as const };
		}
		const email = this.db
			.select({
				id: schema.emails.id,
				folder_id: schema.emails.folder_id,
				snooze_source_folder_id: schema.emails.snooze_source_folder_id,
				snoozed_until: schema.emails.snoozed_until,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();
		if (!email || isInternalFolderId(email.folder_id)) return false;
		if (
			snoozeBlocksGenericMove({
			folderId: email.folder_id,
			wakeAt: email.snoozed_until,
			sourceFolderId: email.snooze_source_folder_id,
			})
		) {
			return { status: "snoozed_state_requires_unsnooze" as const };
		}
		if (folder.id === email.folder_id && folder.id !== Folders.TRASH) {
			return true;
		}
		const activeDelivery = this.#activeOutboundDeliveryForEmail(id);
		if (activeDelivery) {
			return {
				status: "outbound_delivery_active" as const,
				deliveryId: activeDelivery.id,
			};
		}

		const plan = planMove(email.folder_id, folder.id);
		if (plan.kind === "trash") {
			const trashResult = await this.trashEmail(id, actor);
			if (trashResult?.status === "outbound_delivery_active") {
				return trashResult;
			}
			return trashResult !== null;
		}
		const occurredAt = new Date().toISOString();

		this.ctx.storage.transactionSync(() => {
			this.db
				.update(schema.emails)
				.set({
					folder_id: folder.id,
					...(plan.clearTrashMetadata
						? { previous_folder_id: null, trashed_at: null }
						: {}),
				})
				.where(eq(schema.emails.id, id))
				.run();
			this.#recordActivity(
				actor,
				"email_moved",
				"email",
				id,
				{ fromFolderId: email.folder_id, toFolderId: folder.id },
				occurredAt,
			);
		});

		return true;
	}

	// ── Search ────────────────────────────────────────────────────

	async searchEmails(options: MailSearchOptions) {
		await this.#selfHealSnoozes();
		const plan = buildMailSearchPlan(options);
		const result = this.ctx.storage.sql.exec(plan.dataSql, ...plan.dataParams);
		const rows = [...result] as any[];
		const labelsByEmail = this.#labelsForEmailIds(
			rows.map((row) => String(row.id)),
		);
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			labels: labelsByEmail.get(String(row.id)) ?? [],
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: MailSearchOptions) {
		await this.#selfHealSnoozes();
		const plan = buildMailSearchPlan(options);
		const row = [
			...this.ctx.storage.sql.exec(plan.countSql, ...plan.countParams),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async resolveCanonicalThreadId(messageIds: string[]): Promise<string | null> {
		const ids = [
			...new Set(messageIds.map((id) => id.trim()).filter(Boolean)),
		].slice(0, 50);
		if (ids.length === 0) return null;
		const rows = this.db
			.select({
				id: schema.emails.id,
				messageId: schema.emails.message_id,
				threadId: schema.emails.thread_id,
			})
			.from(schema.emails)
			.where(
				or(
				inArray(schema.emails.message_id, ids),
				inArray(schema.emails.id, ids),
				),
			)
			.all();
		return resolveUnambiguousThreadReference(ids, rows);
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const cutoffs = mailboxSendCutoffs();
		const hourRow = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`,
				Folders.SENT,
				cutoffs.hour,
			),
		][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`,
				Folders.SENT,
				cutoffs.day,
			),
		][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
		actor?: ActivityActor,
		mailboxAddress?: string,
	) {
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
		let pushTargetCount: number | null = null;
		let automationCaptureError: unknown = null;
		if (email.automation_trigger !== undefined) {
			if (
				email.automation_trigger !== "live_inbound" ||
				folderId !== Folders.INBOX ||
				email.recipient_memory_origin !== RecipientMemoryOrigins.LIVE_INBOUND
			)
				throw new Error("Automation trigger is not eligible for this Message");
			// Register the alarm before accepting the Message. The Durable Object input
			// gate keeps it from running until this event completes; a later transaction
			// failure leaves only a harmless alarm with no due work.
			await this.#scheduleAlarmAt(Date.now() + 100);
		}

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
					sender_name: email.sender_name ?? null,
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
					recipient_memory_origin: email.recipient_memory_origin ?? null,
				})
				.run();

			if (attachments.length > 0) {
				this.db.insert(schema.attachments).values(attachments).run();
			}
			if (email.automation_trigger !== undefined) {
				const captured = this.#automationRules().captureLiveInbound(email.id, email.date);
				if (captured.captureFailed) automationCaptureError = captured.error;
			}
			if (
				mailboxAddress &&
				email.recipient_memory_origin === RecipientMemoryOrigins.LIVE_INBOUND &&
				recipientMemoryFolderEligible(folderId)
			) {
				const interaction = storedEmailInteraction(email, mailboxAddress);
				recordRecipientInteractions(this.ctx.storage.sql, {
					sourceEmailId: email.id,
					direction: interaction.direction,
					occurredAt: email.date,
					mailboxAddress,
					addresses: interaction.addresses,
				});
			}
			if (mailboxAddress && email.recipient_memory_origin) {
				createMailPeopleProjector({
					store: this.ctx.storage,
					mailboxAddress,
				}).projectMessage(email.id);
			}
			if (folderId === Folders.INBOX && email.snooze_wake_thread_id) {
				this.ctx.storage.sql.exec(
					`INSERT INTO snooze_reply_wake_queue (thread_id, requested_at)
					 SELECT ?1, ?2
					 WHERE EXISTS (
						SELECT 1 FROM emails
						WHERE folder_id = ?3 AND thread_id = ?1
					 )
					 ON CONFLICT(thread_id) DO UPDATE SET requested_at = excluded.requested_at`,
					email.snooze_wake_thread_id,
					email.date,
					Folders.SNOOZED,
				);
			}
			if (folderId === Folders.INBOX && email.follow_up_reply_mailbox_address) {
				this.db
					.insert(schema.followUpReplyCompletionQueue)
					.values({
					inbound_message_id: email.id,
					mailbox_address: email.follow_up_reply_mailbox_address,
					conversation_key: email.thread_id?.trim() || email.id,
					inbound_message_date: email.date,
					attempts: 0,
					next_attempt_at: Date.now(),
					created_at: Date.now(),
					last_error: null,
					})
					.onConflictDoNothing()
					.run();
			}
			if (actor) {
				this.#recordActivity(
					actor,
					"email_created",
					"email",
					email.id,
					{ folderId },
					email.date,
				);
			}
			if (email.push_notification !== undefined) {
				if (
					folderId !== Folders.INBOX ||
					email.recipient_memory_origin !==
						RecipientMemoryOrigins.LIVE_INBOUND ||
					!mailboxAddress
				)
					throw new Error("Push notification is not eligible for this Message");
				pushTargetCount = enqueuePushNotification(this.ctx.storage.sql, {
					emailId: email.id,
					mailboxId: mailboxAddress,
					payload: email.push_notification,
					now: email.date,
				}).targetCount;
			}
		});
		if (automationCaptureError) {
			console.error(
				"[automation-rules] capture failed after Message acceptance",
				{
				emailId: email.id,
					error:
						automationCaptureError instanceof Error
					? automationCaptureError.message
					: String(automationCaptureError),
				},
			);
		}
		if (pushTargetCount !== null) {
			await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
				console.error("[push-outbox] failed to schedule durable delivery", {
					emailId: email.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
		if (folderId === Folders.INBOX && email.snooze_wake_thread_id) {
			const queued = this.db
				.select({ threadId: schema.snoozeReplyWakeQueue.thread_id })
				.from(schema.snoozeReplyWakeQueue)
				.where(
					eq(
					schema.snoozeReplyWakeQueue.thread_id,
					email.snooze_wake_thread_id,
					),
				)
				.get();
			if (queued) {
				await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
					console.error("failed to schedule Snooze reply wake alarm", {
						threadId: email.snooze_wake_thread_id,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		if (folderId === Folders.INBOX && email.follow_up_reply_mailbox_address) {
			await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
				console.error("failed to schedule follow-up reply completion", {
					inboundMessageId: email.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}

	// ── Truthful outbound delivery ─────────────────────────────────

	#outboxService(
		pendingAttachments: readonly PendingOutboundAttachment[] = [],
		fixedEmailId?: string,
	) {
		const storage = new DurableObjectOutboundDeliveryStorage(
			this.db,
			this.ctx.storage,
			{
				resolvePendingAttachments: () => pendingAttachments,
			},
		);
		return new TruthfulOutboxService(storage, {
			createId: (prefix) =>
				prefix === "email" && fixedEmailId
					? fixedEmailId
					: `${prefix}_${crypto.randomUUID()}`,
		});
	}

	async #enqueueOutboundInternal(
		command: EnqueueOutboundCommand,
		attachments: readonly PendingOutboundAttachment[],
		emailId: string,
		onCommittedSync?: (result: EnqueuedDelivery) => void,
	) {
		const inlineMapping = validateResolvedInlineImages(
			command.snapshot.html ?? "",
			attachments,
		);
		if (!inlineMapping.ok) {
			throw new InlineImageMappingError(inlineMapping.error);
		}
		const result = this.#outboxService(attachments, emailId).enqueue(
			command,
			onCommittedSync,
		);
		await finalizeCommittedOutboundMutation({
			ensureAlarm: () => this.#ensureOutboundAlarm(),
			recordActivity: () =>
				this.#recordActivity(
					command.actor,
					result.replayed ? "outbound_enqueue_replayed" : "outbound_enqueued",
					"outbound_delivery",
					result.delivery.id,
					{
						emailId: result.delivery.emailId,
						kind: result.delivery.kind,
						status: result.delivery.status,
					},
					command.requestedAt,
				),
		});
		if (result.replayed && result.delivery.emailId !== emailId) {
			const orphanKeys = attachments.map((attachment) =>
				attachmentKey(emailId, attachment.id, attachment.filename),
			);
			if (orphanKeys.length > 0) {
				try {
					await this.env.BUCKET.delete(orphanKeys);
				} catch {
					await this.queueAttachmentCleanup(emailId, orphanKeys, command.actor);
				}
			}
		}
		return result;
	}

	async enqueueOutbound(
		command: EnqueueOutboundCommand,
		attachments: readonly PendingOutboundAttachment[],
		emailId: string,
	) {
		return this.#enqueueOutboundInternal(command, attachments, emailId);
	}

	async listOutboundDeliveries() {
		const deliveries = this.#outboxService().list();
		await this.#ensureOutboundAlarm();
		return deliveries;
	}

	async listOutboundDeliveriesForEmailIds(emailIds: string[]) {
		const uniqueIds = [...new Set(emailIds.filter(Boolean))].slice(0, 100);
		if (uniqueIds.length === 0) return [];
		const rows = this.db
			.select({ id: schema.outboundDeliveries.id })
			.from(schema.outboundDeliveries)
			.where(inArray(schema.outboundDeliveries.email_id, uniqueIds))
			.all();
		const service = this.#outboxService();
		const deliveries = rows.flatMap(({ id }) => {
			const delivery = service.get(id);
			return delivery ? [delivery] : [];
		});
		await this.#ensureOutboundAlarm();
		return deliveries;
	}

	/**
	 * Return at most one bounded, server-ranked delivery highlight for each
	 * represented thread. Failure states rank ahead of routine sent history so
	 * an older bounce cannot disappear behind the thread's latest row.
	 */
	async listOutboundDeliveryHighlights(
		emailIds: string[],
		threadIds: string[],
	) {
		const uniqueEmailIds = [...new Set(emailIds.filter(Boolean))].slice(0, 100);
		const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))].slice(
			0,
			100,
		);
		if (uniqueEmailIds.length === 0 && uniqueThreadIds.length === 0) return [];

		const params = [...uniqueEmailIds, ...uniqueThreadIds];
		const emailPlaceholders = uniqueEmailIds.map((_, index) => `?${index + 1}`);
		const threadPlaceholders = uniqueThreadIds.map(
			(_, index) => `?${uniqueEmailIds.length + index + 1}`,
		);
		const scope = [
			emailPlaceholders.length
				? `e.id IN (${emailPlaceholders.join(",")})`
				: "",
			threadPlaceholders.length
				? `e.thread_id IN (${threadPlaceholders.join(",")})`
				: "",
		]
			.filter(Boolean)
			.join(" OR ");
		const rows = [
			...this.ctx.storage.sql.exec(
				`WITH ranked AS (
				SELECT od.id, e.thread_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(e.thread_id, e.id)
						ORDER BY CASE od.status
							WHEN 'bounced' THEN 0
							WHEN 'failed' THEN 1
							WHEN 'unknown' THEN 2
							WHEN 'retrying' THEN 3
							WHEN 'sending' THEN 4
							WHEN 'queued' THEN 5
							WHEN 'sent' THEN 6
							WHEN 'cancelled' THEN 7
							ELSE 8
						END,
						od.updated_at DESC
					) AS rank
				FROM outbound_deliveries od
				JOIN emails e ON e.id = od.email_id
				WHERE ${scope}
			)
			SELECT id, thread_id FROM ranked WHERE rank = 1 LIMIT 100`,
				...params,
			),
		] as Array<{ id: string; thread_id: string | null }>;
		const service = this.#outboxService();
		const deliveries = rows.flatMap((row) => {
			const delivery = service.get(row.id);
			return delivery
				? [
						{
							...delivery,
							...(row.thread_id ? { threadId: row.thread_id } : {}),
						},
					]
				: [];
		});
		await this.#ensureOutboundAlarm();
		return deliveries;
	}

	async getOutboundDelivery(deliveryId: string) {
		const delivery = this.#outboxService().get(deliveryId);
		await this.#ensureOutboundAlarm();
		return delivery;
	}

	async getOutboundDeliveryByIdempotencyKey(idempotencyKey: string) {
		const delivery = this.#outboxService().getByIdempotencyKey(idempotencyKey);
		await this.#ensureOutboundAlarm();
		return delivery;
	}

	async cancelOutboundDelivery(
		deliveryId: string,
		actor: OutboundDeliveryActor,
	) {
		const at = new Date().toISOString();
		const service = this.#outboxService();
		const existing = service.get(deliveryId);
		if (existing?.status === "cancelled") {
			const recoveredDraftId = await this.#recoverCancelledOutboundSnapshot(
				existing,
				actor,
				at,
			);
			const recoveredDelivery = service.get(deliveryId) ?? existing;
			return {
				delivery: recoveredDelivery,
				actor,
				sourceDraftAction: existing.draftId
					? ("retain" as const)
					: ("none" as const),
				...(recoveredDraftId ? { recoveredDraftId } : {}),
			};
		}
		const result = service.cancel(deliveryId, actor, at);
		const recoveredDraftId = await this.#recoverCancelledOutboundSnapshot(
			result.delivery,
			actor,
			at,
		);
		this.#recordActivity(
			actor,
			"outbound_cancelled",
			"outbound_delivery",
			deliveryId,
			{},
			at,
		);
		return { ...result, ...(recoveredDraftId ? { recoveredDraftId } : {}) };
	}

	async #recoverCancelledOutboundSnapshot(
		delivery: { emailId: string; draftId?: string },
		actor: OutboundDeliveryActor,
		at: string,
	) {
		const snapshot = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, delivery.emailId))
			.get();
		if (!snapshot) {
			throw new Error(
				`Missing cancelled outbound snapshot ${delivery.emailId}`,
			);
		}
		const immutableSnapshot = deserializeOutboundSnapshot(snapshot.raw_headers);
		if (!immutableSnapshot) {
			throw new Error(
				`Invalid cancelled outbound snapshot ${delivery.emailId}`,
			);
		}
		const sourceDraft = delivery.draftId
			? this.db
					.select()
					.from(schema.emails)
					.where(eq(schema.emails.id, delivery.draftId))
					.get()
			: null;
		const sourceDraftWithAttachments = sourceDraft
			? {
					...sourceDraft,
					attachments: this.db
						.select({ id: schema.attachments.id })
						.from(schema.attachments)
						.where(eq(schema.attachments.email_id, sourceDraft.id))
						.all(),
				}
			: null;
		const sourceDraftEquivalent = sourceDraftMatchesSnapshot(
			sourceDraftWithAttachments,
			immutableSnapshot,
		);
		const plan = planCancelledOutboundRecovery({ sourceDraftEquivalent });
		if (!cancellationRecoveryPending("cancelled", snapshot.folder_id)) {
			if (!plan.createRecoveredDraft) return undefined;
			const recoveredId = recoveredDraftId(delivery.emailId);
			const recovered = this.db
				.select({ id: schema.emails.id })
				.from(schema.emails)
				.where(
					and(
						eq(schema.emails.id, recoveredId),
						eq(schema.emails.folder_id, Folders.DRAFT),
					),
				)
				.get();
			return recovered ? recoveredId : undefined;
		}

		const recoveredDraftIdValue = plan.createRecoveredDraft
			? recoveredDraftId(delivery.emailId)
			: undefined;
		const recoveredExists = recoveredDraftIdValue
			? Boolean(
					this.db
						.select({ id: schema.emails.id })
						.from(schema.emails)
						.where(
							and(
								eq(schema.emails.id, recoveredDraftIdValue),
								eq(schema.emails.folder_id, Folders.DRAFT),
							),
						)
						.get(),
				)
			: false;
		const snapshotAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, delivery.emailId))
			.all();
		const recoveredAttachments =
			recoveredDraftIdValue && !recoveredExists
				? (
						await prepareRecoveredDraftAttachments(
							this.env.BUCKET,
							delivery.emailId,
							snapshotAttachments,
						)
					).attachments
				: [];
		const attachments = plan.deleteSnapshotAttachments
			? snapshotAttachments
			: [];

		const recoveryCommitted = this.ctx.storage.transactionSync(() => {
			const currentSnapshot = this.db
				.select({ folderId: schema.emails.folder_id })
				.from(schema.emails)
				.where(eq(schema.emails.id, delivery.emailId))
				.get();
			if (
				!cancellationRecoveryPending("cancelled", currentSnapshot?.folderId)
			) {
				return false;
			}
			if (recoveredDraftIdValue && !recoveredExists) {
				this.db
					.insert(schema.emails)
					.values({
						...snapshot,
						id: recoveredDraftIdValue,
						folder_id: Folders.DRAFT,
						date: at,
						message_id: null,
						raw_headers: null,
						previous_folder_id: null,
						trashed_at: null,
						draft_version: 1,
					})
					.run();
				if (recoveredAttachments.length > 0) {
					this.db.insert(schema.attachments).values(recoveredAttachments).run();
				}
				this.#recordActivity(
					actor,
					"outbound_cancelled_recovered_as_draft",
					"email",
					recoveredDraftIdValue,
					{ sourceSnapshotId: delivery.emailId },
					at,
				);
			}
			this.db
				.update(schema.emails)
				.set({
					folder_id: plan.folderId,
					previous_folder_id: null,
					trashed_at: null,
				})
				.where(eq(schema.emails.id, delivery.emailId))
				.run();
			if (plan.deleteSnapshotAttachments) {
				this.db
					.delete(schema.attachments)
					.where(eq(schema.attachments.email_id, delivery.emailId))
					.run();
			}
			this.#recordActivity(
				actor,
				"outbound_cancelled_snapshot_retired",
				"email",
				delivery.emailId,
				{},
				at,
			);
			return true;
		});
		if (!recoveryCommitted) return recoveredDraftIdValue;

		if (attachments.length > 0) {
			const keys = attachments.map((attachment) =>
				attachmentKey(delivery.emailId, attachment.id, attachment.filename),
			);
			try {
				await this.env.BUCKET.delete(keys);
			} catch {
				await this.queueAttachmentCleanup(delivery.emailId, keys, actor);
			}
		}
		return recoveredDraftIdValue;
	}

	async retryOutboundDelivery(
		deliveryId: string,
		actor: OutboundDeliveryActor,
		acknowledgeDuplicateRisk = false,
	) {
		const at = new Date().toISOString();
		const existing = this.#outboxService().get(deliveryId);
		if (!existing)
			throw new Error(`Outbound delivery ${deliveryId} was not found`);
		const result =
			existing.status === "unknown"
				? this.#outboxService().retryUnknown(
						deliveryId,
						actor,
						acknowledgeDuplicateRisk as true,
						at,
						(delivery) => this.#assertBulkRetryCapacitySync(delivery),
					)
				: this.#outboxService().retryFailed(deliveryId, actor, at, (delivery) =>
						this.#assertBulkRetryCapacitySync(delivery),
					);
		await finalizeCommittedOutboundMutation({
			ensureAlarm: () => this.#ensureOutboundAlarm(),
			recordActivity: () =>
				this.#recordActivity(
					actor,
					"outbound_retry_requested",
					"outbound_delivery",
					deliveryId,
					{ acknowledgedDuplicateRisk: acknowledgeDuplicateRisk },
					at,
				),
		});
		return result;
	}

	async recordSesBounce(input: {
		deliveryId?: string;
		sesMessageId: string;
		eventType: "bounce" | "complaint";
		message?: string;
		at: string;
	}) {
		const service = this.#outboxService();
		const delivery = input.deliveryId
			? service.get(input.deliveryId)
			: service.getBySesMessageId(input.sesMessageId);
		if (!delivery) return { status: "not_found" as const };
		if (delivery.status === "bounced") {
			const email = await this.getEmail(delivery.emailId);
			if (email?.folder_id !== Folders.SENT) {
				await this.#moveAcceptedOutboundToSent(
					delivery.emailId,
					delivery.sesMessageId ?? input.sesMessageId,
					delivery.actor,
					delivery.updatedAt,
				);
			}
			await this.#consumeAcceptedSourceDraft(
				delivery.draftId,
				delivery.draftVersion,
				delivery.actor,
			);
			return { status: "already_recorded" as const, delivery };
		}
		if (delivery.status !== "sent" && delivery.status !== "unknown") {
			return { status: "invalid_state" as const, delivery };
		}
		const bounced = service.markBounced(delivery.id, {
			at: input.at,
			code: input.eventType === "complaint" ? "ses_complaint" : "ses_bounce",
			message: input.message,
			sesMessageId: input.sesMessageId,
		});
		this.#recordActivity(
			{ kind: "system" },
			input.eventType === "complaint"
				? "outbound_complaint_recorded"
				: "outbound_bounce_recorded",
			"outbound_delivery",
			delivery.id,
			{ sesMessageId: input.sesMessageId },
			input.at,
		);
		const email = await this.getEmail(bounced.emailId);
		if (email?.folder_id !== Folders.SENT) {
			await this.#moveAcceptedOutboundToSent(
				bounced.emailId,
				input.sesMessageId,
				bounced.actor,
				input.at,
			);
		}
		await this.#consumeAcceptedSourceDraft(
			bounced.draftId,
			bounced.draftVersion,
			bounced.actor,
		);
		return { status: "recorded" as const, delivery: bounced };
	}

	async #scheduleAlarmAt(timestamp: number) {
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null || timestamp < existing) {
			await this.ctx.storage.setAlarm(timestamp);
		}
	}

	async #scheduleBulkAlarmAt(
		timestamp: number,
		input: {
			stage: "throttle_schedule" | "next_job_schedule";
			startedAt: number;
			jobId: string;
			job?: BulkJob;
		},
	): Promise<void> {
		try {
			await this.#scheduleAlarmAt(timestamp);
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: input.stage,
				mailboxId: input.job?.fromEmail,
				operationId: input.job?.operationId,
				jobId: input.jobId,
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - input.startedAt,
			});
			throw error;
		}
	}

	async #ensureBulkMaintenanceAlarmForJob(input: {
		startedAt: number;
		jobId: string;
		job?: BulkJob;
	}): Promise<void> {
		try {
			await this.#ensureBulkMaintenanceAlarm();
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: "terminal_maintenance_schedule",
				mailboxId: input.job?.fromEmail,
				operationId: input.job?.operationId,
				jobId: input.jobId,
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - input.startedAt,
			});
			throw error;
		}
	}

	async #processSemanticIndexAlarm(alarmNow: number): Promise<number | null> {
		const mailboxId = await this.ctx.storage.get<string>(
			SEMANTIC_SCHEDULER_MAILBOX_KEY,
		);
		if (!mailboxId) return null;
		const brand = resolveBrand(this.env.BRAND);
		if (
			!isSemanticSearchEnabled(this.env.FEATURES, brand.id) ||
			!this.env.SEMANTIC_INDEX
		) {
			await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
			await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
			return null;
		}

		try {
			await advanceSemanticMailboxIndex({
				mailbox: this,
				bucket: {
					head: (key) => this.env.BUCKET.head(key),
					get: async (key, etag) => {
						const object = await this.env.BUCKET.get(key, {
							onlyIf: { etagMatches: etag },
						});
						return object && "body" in object ? object : null;
					},
				},
					converter: createWorkersAiSemanticRichDocumentConverter(this.env),
				provider: createSemanticIndexProvider(this.env, mailboxId),
				namespace: await semanticMailboxNamespace(brand.id, mailboxId),
				onObservationError: (error) => {
					console.error("[semantic-index] visibility observation failed", {
						errorCode: semanticSchedulerErrorCode(error),
					});
				},
			});
			await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
			const next = createSemanticIndex({
				store: this.ctx.storage,
			}).nextAdvanceAt(Date.now());
			if (next === null) {
				await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
				return null;
			}
			return Math.max(Date.now() + 100, next);
		} catch (error) {
			const failures =
				((await this.ctx.storage.get<number>(
				SEMANTIC_SCHEDULER_FAILURES_KEY,
				)) ?? 0) + 1;
			console.error("[semantic-index] alarm turn failed", {
				errorCode: semanticSchedulerErrorCode(error),
				attempt: failures,
			});
			if (failures >= SEMANTIC_SCHEDULER_MAX_FAILURES) {
				createSemanticIndex({ store: this.ctx.storage }).failProjection(
					"scheduler_exhausted",
				);
				await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
				await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
				return null;
			}
			await this.ctx.storage.put(SEMANTIC_SCHEDULER_FAILURES_KEY, failures);
			return alarmNow + Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000);
		}
	}

	#nextAutomationAlarmAt(): number | null {
		const row = [
			...this.ctx.storage.sql.exec<{ dueAt: string | null }>(
			`SELECT MIN(due_at) AS dueAt FROM (
			 SELECT next_attempt_at AS due_at FROM automation_runs
			 WHERE state = 'pending' AND next_attempt_at IS NOT NULL
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM automation_runs
			 WHERE state = 'processing' AND lease_expires_at IS NOT NULL
			)`,
			),
		][0];
		if (!row?.dueAt) return null;
		const timestamp = Date.parse(row.dueAt);
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	#processAutomationRulesAlarm(): number | null {
		const automation = this.#automationRules();
		for (let processed = 0; processed < 2; processed += 1) {
			let claim;
			try {
				claim = automation.claimNextRun();
			} catch (error) {
				console.error("[automation-rules] could not claim due work", {
					error: error instanceof Error ? error.message : String(error),
				});
				break;
			}
			if (!claim) break;
			try {
				const context = readAutomationPlanningContext(
					this.ctx.storage.sql,
					claim.triggerMessageId,
				);
				if (!context) {
					automation.failClaim(claim, "message_unavailable", false);
					continue;
				}
				const plan = automation.planRun(claim.rules, context);
				const finalized = automation.finalizeClaim(claim, plan, (ownedPlan) => {
					applyAutomationActionPlan(
						this.ctx.storage.sql,
						claim,
						context,
						ownedPlan,
						(activity) =>
							this.#recordActivity(
							activity.actor,
							activity.action,
							activity.entityType,
							activity.entityId,
							activity.metadata,
						),
					);
				});
				if (!finalized) {
					console.warn("[automation-rules] lease expired before finalization", {
						runId: claim.id,
					});
				}
			} catch (error) {
				let recorded = false;
				try {
					recorded = automation.failClaim(claim, "runtime_failure", true);
				} catch (failureError) {
					console.error(
						"[automation-rules] could not persist execution failure",
						{
						runId: claim.id,
							error:
								failureError instanceof Error
							? failureError.message
							: String(failureError),
						},
					);
				}
				console.error("[automation-rules] execution failed", {
					runId: claim.id,
					retryScheduled: recorded,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return this.#nextAutomationAlarmAt();
	}

	#processDueSnoozeBatch(now = Date.now()): number | null {
		const rows = [
			...this.ctx.storage.sql.exec(
			`SELECT id,
			        snooze_source_folder_id AS sourceFolderId,
			        snoozed_until AS wakeAt
			 FROM emails
			 WHERE folder_id = ?1
			 ORDER BY snoozed_until ASC, id ASC
			 LIMIT 101`,
			Folders.SNOOZED,
			),
		] as Array<{ id: string; sourceFolderId: string | null; wakeAt: string }>;
		const visibleFolders = new Set(
			this.db
				.select({ id: schema.folders.id })
				.from(schema.folders)
				.all()
				.map((folder) => folder.id),
		);
		const plan = planDueSnoozeWake(rows, now, (folderId) =>
			visibleFolders.has(folderId),
		);
		if (plan.wake.length > 0) {
			const occurredAt = new Date(now).toISOString();
			this.ctx.storage.transactionSync(() => {
				for (const target of plan.wake) {
					this.db
						.update(schema.emails)
						.set({
							folder_id: target.folderId,
							snooze_source_folder_id: null,
							snoozed_until: null,
						})
						.where(
							and(
							eq(schema.emails.id, target.id),
							eq(schema.emails.folder_id, Folders.SNOOZED),
							),
						)
						.run();
				}
				this.#recordActivity(
					{ kind: "system" },
					"snooze_due_wake_batch",
					"folder",
					Folders.SNOOZED,
					{ affectedCount: plan.wake.length },
					occurredAt,
				);
			});
		}
		return plan.nextWakeAt;
	}

	#processReplyWakeBatch(): boolean {
		const queued = this.db
			.select()
			.from(schema.snoozeReplyWakeQueue)
			.orderBy(
				asc(schema.snoozeReplyWakeQueue.requested_at),
				asc(schema.snoozeReplyWakeQueue.thread_id),
			)
			.limit(1)
			.get();
		if (!queued) return false;
		const rows = [
			...this.ctx.storage.sql.exec(
			`SELECT id FROM emails
			 WHERE folder_id = ?1 AND thread_id = ?2
			 ORDER BY date ASC, id ASC
			 LIMIT 100`,
			Folders.SNOOZED,
			queued.thread_id,
			),
		] as Array<{ id: string }>;
		const occurredAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			if (rows.length > 0) {
				this.db
					.update(schema.emails)
					.set({
						folder_id: Folders.INBOX,
						snooze_source_folder_id: null,
						snoozed_until: null,
					})
					.where(
						inArray(
							schema.emails.id,
							rows.map((row) => row.id),
						),
					)
					.run();
				this.#recordActivity(
					{ kind: "system" },
					"conversation_woken_by_reply",
					"conversation",
					queued.thread_id,
					{ affectedCount: rows.length },
					occurredAt,
				);
			}
			const remaining = this.db
				.select({ id: schema.emails.id })
				.from(schema.emails)
				.where(
					and(
					eq(schema.emails.folder_id, Folders.SNOOZED),
					eq(schema.emails.thread_id, queued.thread_id),
					),
				)
				.limit(1)
				.get();
			if (!remaining) {
				this.db
					.delete(schema.snoozeReplyWakeQueue)
					.where(eq(schema.snoozeReplyWakeQueue.thread_id, queued.thread_id))
					.run();
			}
		});
		return Boolean(
			this.db
				.select({ threadId: schema.snoozeReplyWakeQueue.thread_id })
				.from(schema.snoozeReplyWakeQueue)
				.limit(1)
				.get(),
		);
	}

	async #processFollowUpReplyCompletionQueue(
		now: number,
	): Promise<number | null> {
		const repository: FollowUpReplyQueueRepository = {
			nextDue: async (dueAt) => {
				const row = this.db
					.select()
					.from(schema.followUpReplyCompletionQueue)
					.where(
						lte(schema.followUpReplyCompletionQueue.next_attempt_at, dueAt),
					)
					.orderBy(
						asc(schema.followUpReplyCompletionQueue.next_attempt_at),
						asc(schema.followUpReplyCompletionQueue.inbound_message_id),
					)
					.limit(1)
					.get();
				return row
					? {
					inboundMessageId: row.inbound_message_id,
					mailboxAddress: row.mailbox_address,
					conversationKey: row.conversation_key,
					inboundMessageDate: row.inbound_message_date,
					attempts: row.attempts,
						}
					: null;
			},
			remove: async (inboundMessageId) => {
				this.db
					.delete(schema.followUpReplyCompletionQueue)
					.where(
						eq(
						schema.followUpReplyCompletionQueue.inbound_message_id,
						inboundMessageId,
						),
					)
					.run();
			},
			retry: async (input) => {
				this.db
					.update(schema.followUpReplyCompletionQueue)
					.set({
						attempts: input.attempts,
						next_attempt_at: input.nextAttemptAt,
						last_error: input.lastError,
					})
					.where(
						eq(
						schema.followUpReplyCompletionQueue.inbound_message_id,
						input.inboundMessageId,
						),
					)
					.run();
			},
			nextAttemptAt: async () =>
				this.db
					.select({
						nextAttemptAt: schema.followUpReplyCompletionQueue.next_attempt_at,
					})
				.from(schema.followUpReplyCompletionQueue)
				.orderBy(
					asc(schema.followUpReplyCompletionQueue.next_attempt_at),
					asc(schema.followUpReplyCompletionQueue.inbound_message_id),
				)
				.limit(1)
				.get()?.nextAttemptAt ?? null,
		};
		return processOneFollowUpReplyCompletion({
			repository,
			now,
			complete: (item) =>
				followUpReminderD1Store(this.env).completeForInboundReply({
					mailboxAddress: item.mailboxAddress,
					conversationKey: item.conversationKey,
					inboundMessageId: item.inboundMessageId,
					inboundMessageDate: item.inboundMessageDate,
					occurredAt: Date.now(),
				}),
		});
	}

	async #selfHealSnoozes(now = Date.now()) {
		const replyWakePending = this.#processReplyWakeBatch();
		const nextDueAt = this.#processDueSnoozeBatch(now);
		const nextFollowUpAt = await this.#processFollowUpReplyCompletionQueue(now);
		const next = earliestMailboxAlarm([
			replyWakePending ? now + 100 : null,
			nextDueAt,
			nextFollowUpAt,
		]);
		if (next !== null) {
			await finalizeCommittedSnooze({
				ensureAlarm: () => this.#scheduleAlarmAt(Math.max(now, next)),
				logFailure: (error) =>
					console.error("failed to re-arm Snooze during read self-heal", {
						error: error instanceof Error ? error.message : String(error),
					}),
			});
		}
	}

	async #ensureOutboundAlarm() {
		const nextActionAt = this.#outboxService().nextActionAt();
		if (!nextActionAt) return;
		const next = Date.parse(nextActionAt);
		if (Number.isFinite(next)) {
			await this.#scheduleAlarmAt(Math.max(Date.now(), next));
		}
	}

	async #moveAcceptedOutboundToSent(
		emailId: string,
		sesMessageId: string,
		actor: OutboundDeliveryActor,
		at: string,
	) {
		const snapshotRow = this.db
			.select({ raw_headers: schema.emails.raw_headers })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		const snapshot = deserializeOutboundSnapshot(
			snapshotRow?.raw_headers ?? null,
		);
		this.ctx.storage.transactionSync(() => {
			this.db
				.update(schema.emails)
				.set({
					folder_id: Folders.SENT,
					date: at,
					message_id: sesMessageId,
					read: 1,
					recipient_memory_origin: RecipientMemoryOrigins.ACCEPTED_OUTBOUND,
				})
				.where(eq(schema.emails.id, emailId))
				.run();
			if (snapshot) {
				recordRecipientInteractions(this.ctx.storage.sql, {
					sourceEmailId: emailId,
					direction: "sent",
					occurredAt: at,
					mailboxAddress: snapshot.mailboxId,
					addresses: [...snapshot.to, ...snapshot.cc, ...snapshot.bcc],
				});
				createMailPeopleProjector({
					store: this.ctx.storage,
					mailboxAddress: snapshot.mailboxId,
				}).projectMessage(emailId);
			}
			this.#recordActivity(
				actor,
				"outbound_provider_accepted",
				"email",
				emailId,
				{ sesMessageId },
				at,
			);
		});
	}

	async getRecipientSuggestions(
		mailboxAddress: string,
		query: string,
		limit: number,
	) {
		this.ctx.storage.transactionSync(() => {
			seedRecipientInteractions(this.ctx.storage.sql, mailboxAddress);
		});
		return readRecipientSuggestions(
			this.ctx.storage.sql,
			mailboxAddress,
			query,
			limit,
		);
	}

	async listMailPeople(
		mailboxAddress: string,
		query: NormalizedMailPeopleListQuery,
	) {
		const normalizedMailbox = normalizeMailAddress(mailboxAddress);
		if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
			throw new Error("Mailbox address is invalid");
		}
		return createMailPeopleProjector({
			store: this.ctx.storage,
			mailboxAddress: normalizedMailbox,
		}).listPeople(validateNormalizedMailPeopleListQuery(query));
	}

	async getMailPerson(mailboxAddress: string, personId: string) {
		const normalizedMailbox = normalizeMailAddress(mailboxAddress);
		if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
			throw new Error("Mailbox address is invalid");
		}
		return createMailPeopleProjector({
			store: this.ctx.storage,
			mailboxAddress: normalizedMailbox,
		}).getPerson(validateMailPersonId(personId));
	}

	async listMailPersonTimeline(
		mailboxAddress: string,
		personId: string,
		query: NormalizedMailPersonTimelineQuery,
	) {
		const normalizedMailbox = normalizeMailAddress(mailboxAddress);
		if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
			throw new Error("Mailbox address is invalid");
		}
		const id = validateMailPersonId(personId);
		return createMailPeopleProjector({
			store: this.ctx.storage,
			mailboxAddress: normalizedMailbox,
		}).listPersonTimeline(
			id,
			validateNormalizedMailPersonTimelineQuery(query, id),
		);
	}

	async getRelationshipBriefEvidence(mailboxAddress: string, personId: string) {
		const normalizedMailbox = normalizeMailAddress(mailboxAddress);
		if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
			throw new Error("Mailbox address is invalid");
		}
		const id = validateMailPersonId(personId);
		const projector = createMailPeopleProjector({
			store: this.ctx.storage,
			mailboxAddress: normalizedMailbox,
		});
		const prepared = projector.getPerson(id);
		if (prepared.status === "building") {
			return {
				state: "building" as const,
				processedMessages: prepared.processedMessages,
				retryAfterMs: prepared.retryAfterMs,
			};
		}
		if (prepared.person === null) return { state: "not_found" as const };
		return readRelationshipBriefEvidence(this.ctx.storage.sql, id);
	}

	async claimRelationshipBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
		expiresAt: number,
	) {
		return this.claimTodayBriefGeneration(
			cacheKey,
			ownerUserId,
			claimToken,
			expiresAt,
		);
	}

	async releaseRelationshipBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
	) {
		return this.releaseTodayBriefGeneration(cacheKey, ownerUserId, claimToken);
	}

	async #consumeAcceptedSourceDraft(
		draftId: string | undefined,
		draftVersion: number | undefined,
		actor: OutboundDeliveryActor,
	) {
		if (!draftId || draftVersion === undefined) return;
		const consumed = await this.consumeDraftVersion(
			draftId,
			draftVersion,
			actor,
		);
		if (consumed.status !== "consumed") return;
		const keys = consumed.attachments.map((attachment) =>
			attachmentKey(draftId, attachment.id, attachment.filename),
		);
		if (keys.length === 0) return;
		try {
			await this.env.BUCKET.delete(keys);
		} catch {
			await this.queueAttachmentCleanup(draftId, keys, actor);
		}
	}

	async #loadOutboundAttachments(emailId: string) {
		const email = await this.getEmail(emailId);
		if (!email) throw new Error(`Missing outbound email snapshot ${emailId}`);
		return Promise.all(
			email.attachments.map(async (attachment) => {
				const object = await this.env.BUCKET.get(
					attachmentKey(emailId, attachment.id, attachment.filename),
				);
				if (!object) {
					throw new Error(`Outbound attachment ${attachment.id} is missing`);
				}
				return {
					content: arrayBufferToBase64(await object.arrayBuffer()),
					filename: attachment.filename,
					type: attachment.mimetype,
					disposition:
						attachment.disposition === "inline"
							? ("inline" as const)
							: ("attachment" as const),
					...(attachment.disposition === "inline" && attachment.content_id
						? { contentId: attachment.content_id }
						: {}),
				};
			}),
		);
	}

	async #outboundActorStillAuthorized(
		actor: OutboundDeliveryActor,
		mailboxId: string,
	): Promise<boolean> {
		if (!actor.id) return false;
		return mailboxAccess(this.env).canAccessMailbox(actor.id, mailboxId);
	}

	#dispatchQuotaPlan(now: string) {
		const hourStart = new Date(Date.parse(now) - 60 * 60_000).toISOString();
		const dayStart = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
		const sentHour = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) AS count, MIN(date) AS oldest
			 FROM emails
			 WHERE folder_id = ?1 AND date >= ?2`,
				Folders.SENT,
				hourStart,
			),
		][0] as { count: number; oldest: string | null } | undefined;
		const sentDay = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) AS count, MIN(date) AS oldest
			 FROM emails
			 WHERE folder_id = ?1 AND date >= ?2`,
				Folders.SENT,
				dayStart,
			),
		][0] as { count: number; oldest: string | null } | undefined;
		const active = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) AS count
			 FROM outbound_deliveries
			 WHERE status = 'sending'`,
			),
		][0] as { count: number } | undefined;

		return planDispatchQuota({
			sentLastHour: Number(sentHour?.count ?? 0),
			sentLastDay: Number(sentDay?.count ?? 0),
			activeReservations: Number(active?.count ?? 0),
			...(sentHour?.oldest ? { oldestSentInHour: sentHour.oldest } : {}),
			...(sentDay?.oldest ? { oldestSentInDay: sentDay.oldest } : {}),
			now,
		});
	}

	async #processOutboundAlarm(): Promise<void> {
		const service = this.#outboxService();
		const now = new Date().toISOString();
		service.recoverExpiredLeases(now);

		// Reconcile both the Sent move and exact draft-version consumption. The
		// latter also runs after the email already moved, covering a crash between
		// those two idempotent steps.
		for (const delivery of service.listUnreconciledAccepted()) {
			if (delivery.sesMessageId) {
				const email = await this.getEmail(delivery.emailId);
				if (email?.folder_id !== Folders.SENT) {
					await this.#moveAcceptedOutboundToSent(
						delivery.emailId,
						delivery.sesMessageId,
						delivery.actor,
						delivery.sentAt ?? now,
					);
				}
				await this.#consumeAcceptedSourceDraft(
					delivery.draftId,
					delivery.draftVersion,
					delivery.actor,
				);
			}
		}

		const claimed = service.claimNext(now, 60_000);
		if (!claimed) {
			await this.#ensureOutboundAlarm();
			return;
		}
		await this.#scheduleAlarmAt(Date.parse(claimed.delivery.leaseExpiresAt!));

		let observed;
		try {
			const snapshot = claimed.snapshot;
			const fromDomain = snapshot.from.split("@")[1] ?? "";
			const attachments = await this.#loadOutboundAttachments(
				claimed.delivery.emailId,
			);

			let actorAuthorized: boolean;
			try {
				actorAuthorized = await this.#outboundActorStillAuthorized(
					claimed.delivery.actor,
					claimed.delivery.mailboxId,
				);
			} catch (error) {
				const failedAt = new Date().toISOString();
				service.finalizeRetryableFailure(
					claimed.delivery.id,
					claimed.attempt.leaseToken,
					{
						at: failedAt,
						retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
						code: "authority_check_unavailable",
						message: error instanceof Error ? error.message : String(error),
					},
				);
				await this.#ensureOutboundAlarm();
				return;
			}
			if (!actorAuthorized) {
				const failedAt = new Date().toISOString();
				service.finalizeDefinitiveFailure(
					claimed.delivery.id,
					claimed.attempt.leaseToken,
					{
						at: failedAt,
						code: "authorization_revoked",
						message:
							"The initiating actor no longer has access to this mailbox.",
					},
				);
				this.#recordActivity(
					{ kind: "system" },
					"outbound_authorization_revoked",
					"outbound_delivery",
					claimed.delivery.id,
					{
						actorKind: claimed.delivery.actor.kind,
						actorId: claimed.delivery.actor.id,
					},
					failedAt,
				);
				await this.#ensureOutboundAlarm();
				return;
			}

			const quota = this.#dispatchQuotaPlan(new Date().toISOString());
			if (!quota.allowed) {
				const failedAt = new Date().toISOString();
				service.finalizeRetryableFailure(
					claimed.delivery.id,
					claimed.attempt.leaseToken,
					{
						at: failedAt,
						retryAt: quota.retryAt,
						code: quota.code,
						message:
							"Mailbox send capacity is reserved until the current window advances.",
					},
				);
				this.#recordActivity(
					{ kind: "system" },
					"outbound_quota_deferred",
					"outbound_delivery",
					claimed.delivery.id,
					{ code: quota.code, retryAt: quota.retryAt },
					failedAt,
				);
				await this.#ensureOutboundAlarm();
				return;
			}

			observed = await sendEmailWithOutcome(this.env, {
				to: snapshot.to,
				cc: snapshot.cc,
				bcc: snapshot.bcc,
				from: snapshot.from,
				subject: snapshot.subject,
				html: snapshot.html,
				text: snapshot.text,
				attachments,
				headers: buildThreadingHeaders(
					snapshot.inReplyTo ?? null,
					snapshot.references ?? [],
					buildThreadToken(snapshot.threadId, fromDomain),
				),
				tracking: {
					mailboxId: snapshot.mailboxId,
					deliveryId: claimed.delivery.id,
				},
			});
		} catch (error) {
			// Attachment reads and other failures before SES dispatch are proven safe
			// to retry. The SES adapter separately classifies transport ambiguity.
			observed = {
				kind: "not_dispatched" as const,
				detail: error instanceof Error ? error.message : String(error),
			};
		}

		const classified = classifySesOutcome(observed);
		const finishedAt = new Date().toISOString();
		if (classified.kind === "sent") {
			const finalized = service.finalizeAccepted(
				claimed.delivery.id,
				claimed.attempt.leaseToken,
				classified.sesMessageId,
				finishedAt,
			);
			await this.#moveAcceptedOutboundToSent(
				finalized.delivery.emailId,
				classified.sesMessageId,
				finalized.delivery.actor,
				finishedAt,
			);
			await this.#consumeAcceptedSourceDraft(
				finalized.delivery.draftId,
				finalized.delivery.draftVersion,
				finalized.delivery.actor,
			);
		} else if (classified.kind === "unknown") {
			service.finalizeUnknown(claimed.delivery.id, claimed.attempt.leaseToken, {
				at: finishedAt,
				code: classified.code,
				message: observed.detail,
			});
		} else if (classified.automaticRetry) {
			const backoffMs = Math.min(
				30 * 60_000,
				30_000 * 2 ** Math.max(0, claimed.delivery.attemptCount - 1),
			);
			service.finalizeRetryableFailure(
				claimed.delivery.id,
				claimed.attempt.leaseToken,
				{
					at: finishedAt,
					retryAt: new Date(Date.now() + backoffMs).toISOString(),
					code: classified.code,
					message: observed.detail,
					...(observed.kind === "http_error"
						? { httpStatus: observed.status }
						: {}),
				},
			);
		} else {
			service.finalizeDefinitiveFailure(
				claimed.delivery.id,
				claimed.attempt.leaseToken,
				{
					at: finishedAt,
					code: classified.code,
					message: observed.detail,
					...(observed.kind === "http_error"
						? { httpStatus: observed.status }
						: {}),
				},
			);
		}

		await this.#ensureOutboundAlarm();
	}

	// ── Bulk send (mail merge) — alarm-scheduled, throttled (F-06) ──

	/** Extract {{placeholder}} variable names from a template string. */
	#extractVars(tpl: string): string[] {
		const out = new Set<string>();
		for (const m of tpl.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) out.add(m[1]);
		return [...out];
	}

	#removeBulkActiveSync(jobId: string): void {
		const active =
			this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
		this.ctx.storage.kv.put(
			BULK_ACTIVE_KEY,
			active.filter((entry) => entry.jobId !== jobId),
			);
		}

	#recordBulkTerminalSync(
		jobId: string,
		admissionKey: string,
		completedAt: number,
	): void {
		const prior =
			this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
			[];
		const existing = prior.find((entry) => entry.jobId === jobId);
		this.ctx.storage.kv.put(BULK_TERMINAL_HISTORY_KEY, [
			...prior.filter((entry) => entry.jobId !== jobId),
			{
				jobId,
				admissionKey,
				completedAt: existing?.completedAt ?? completedAt,
			},
		]);
		}

	#bulkCleanupEntriesSync(): Array<[string, BulkCleanupIntent]> {
		return [
			...this.ctx.storage.kv.list<BulkCleanupIntent>({
				prefix: BULK_ATTACHMENT_CLEANUP_PREFIX,
			}),
		];
		}

	#bulkReservationEntriesSync(): Array<
		[string, BulkAdmissionReservation]
	> {
		return [
			...this.ctx.storage.kv.list<BulkAdmissionReservation>({
				prefix: BULK_RESERVATION_PREFIX,
			}),
		];
	}

	#pruneBulkReservationsSync(now: number): void {
		for (const [key, reservation] of this.#bulkReservationEntriesSync()) {
			if (reservation.expiresAt <= now) {
				this.ctx.storage.kv.delete(key);
			}
		}
	}

	#createBulkCleanupIntentSync(input: {
		ownerId: string;
		keys: string[];
		dueAt: number;
		verifyAt?: number;
		protectAdmissionKey?: string;
		protectGeneration?: number;
		protectDeliveryKey?: string;
		protectEmailId?: string;
		protectPreparationKey?: string;
	}): string | null {
		const keys = [...new Set(input.keys)].slice(0, ATTACHMENT_LIMITS.maxFiles);
		if (keys.length === 0) return null;
		const id = crypto.randomUUID();
		const intent: BulkCleanupIntent = {
			id,
			ownerId: input.ownerId,
			keys,
			dueAt: input.dueAt,
			leaseToken: null,
			leaseExpiresAt: null,
			attempts: 0,
			createdAt: Date.now(),
			...(input.verifyAt ? { verifyAt: input.verifyAt } : {}),
			...(input.protectAdmissionKey
				? { protectAdmissionKey: input.protectAdmissionKey }
				: {}),
			...(input.protectGeneration !== undefined
				? { protectGeneration: input.protectGeneration }
				: {}),
			...(input.protectDeliveryKey
				? { protectDeliveryKey: input.protectDeliveryKey }
				: {}),
			...(input.protectEmailId ? { protectEmailId: input.protectEmailId } : {}),
			...(input.protectPreparationKey
				? { protectPreparationKey: input.protectPreparationKey }
				: {}),
		};
		this.ctx.storage.kv.put(`${BULK_ATTACHMENT_CLEANUP_PREFIX}${id}`, intent);
		return id;
	}

	#markBulkCleanupDueSync(id: string, dueAt: number): void {
		const key = `${BULK_ATTACHMENT_CLEANUP_PREFIX}${id}`;
		const intent = this.ctx.storage.kv.get<BulkCleanupIntent>(key);
		if (!intent) return;
		const next: BulkCleanupIntent = {
			...intent,
			dueAt,
			leaseToken: null,
			leaseExpiresAt: null,
		};
		delete next.deleteConfirmedAt;
		this.ctx.storage.kv.put(key, next);
	}

	#markBulkGenerationCleanupDueSync(jobId: string, dueAt: number): void {
		for (const [, intent] of this.#bulkCleanupEntriesSync()) {
			if (!intent.ownerId.startsWith(`${jobId}:generation-`)) continue;
			this.#markBulkCleanupDueSync(intent.id, dueAt);
				}
			}

	#bulkOutstandingRecipientCountSync(): number {
		const active =
			this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
		const countedJobIds = new Set<string>();
		let unfinishedRecipients = 0;
		for (const entry of active) {
			const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
			if (!job) continue;
			countedJobIds.add(entry.jobId);
			unfinishedRecipients += Math.max(0, job.total - job.cursor);
		}
		const legacyQueue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
		for (const jobId of new Set(legacyQueue)) {
			if (countedJobIds.has(jobId)) continue;
			const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${jobId}`);
			if (
				!job ||
				job.status === "done" ||
				job.status === "cancelled" ||
				job.status === "failed"
			) {
				continue;
			}
			unfinishedRecipients += Math.max(0, job.total - job.cursor);
		}
		const outboxRow = [
			...this.ctx.storage.sql.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM outbound_deliveries
         WHERE source = 'bulk' AND status IN ('queued', 'sending', 'retrying')`,
			),
		][0];
		return unfinishedRecipients + Number(outboxRow?.count ?? 0);
	}

	#assertBulkRetryCapacitySync(delivery: StoredOutboundDelivery): void {
		if (delivery.source !== "bulk") return;
		if (
			this.#bulkOutstandingRecipientCountSync() >=
			BULK_LIMITS.maxOutstandingRecipients
		) {
			throw new OutboundRetryCapacityError();
		}
	}

	#abandonBulkRecipientPreparationSync(
		jobId: string,
		cursor: number,
		now: number,
	): void {
		const key = `${BULK_RECIPIENT_PREPARATION_PREFIX}${jobId}:${cursor}`;
		const preparation = this.ctx.storage.kv.get<BulkRecipientPreparation>(key);
		if (!preparation) return;
		this.#markBulkCleanupDueSync(preparation.cleanupIntentId, now);
		this.ctx.storage.kv.delete(key);
	}

	#pruneBulkTerminalSync(now: number): void {
		const history =
			this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
			[];
		const retained: BulkTerminalEntry[] = [];
		for (const entry of history) {
			if (entry.completedAt + BULK_LIMITS.terminalRetentionMs > now) {
				retained.push(entry);
				continue;
			}
			this.ctx.storage.kv.delete(`bulk:job:${entry.jobId}`);
			this.ctx.storage.kv.delete(`bulk:rows:${entry.jobId}`);
			this.ctx.storage.kv.delete(entry.admissionKey);
		}
		this.ctx.storage.kv.put(BULK_TERMINAL_HISTORY_KEY, retained);
	}

	#expireBulkPreparationsSync(now: number): void {
		const prior =
			this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
		const active: BulkActiveEntry[] = [];
		for (const entry of prior) {
			const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
			if (
				!job ||
				job.status === "done" ||
				job.status === "failed" ||
				job.status === "cancelled"
			) {
				continue;
			}
			if (
				job.status !== "preparing" ||
				now < job.createdAt + BULK_PREPARATION_MAX_AGE_MS
			) {
				active.push(entry);
				continue;
			}
			const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
				entry.admissionKey,
			);
			if (admission?.status === "preparing") {
				const failed = failBulkAdmission(
					admission,
					admission.generation,
					"Bulk job preparation expired. Start a new submission.",
					now,
				);
				if (failed) this.ctx.storage.kv.put(entry.admissionKey, failed);
			}
			const failedJob: BulkJob = {
				...job,
				status: "failed",
				errors: [
					{
						email: "",
						error: "Bulk job preparation expired. Start a new submission.",
					},
				],
				updatedAt: now,
			};
			this.ctx.storage.kv.put(`bulk:job:${entry.jobId}`, failedJob);
			this.ctx.storage.kv.delete(`bulk:rows:${entry.jobId}`);
			this.#createBulkCleanupIntentSync({
				ownerId: `${entry.jobId}:expired-preparation`,
				keys: job.preparationAttachmentKeys ?? [],
				dueAt: now,
				});
			this.#markBulkGenerationCleanupDueSync(entry.jobId, now);
			this.#recordBulkTerminalSync(entry.jobId, entry.admissionKey, now);
			console.error("[bulk-send] admission preparation completed", {
				operation: "bulk_admission_prepare",
				mailboxId: job.fromEmail,
				operationId: job.operationId,
				jobId: job.id,
				stage: "preparation_deadline",
				result: "expired",
				errorCode: "preparation_expired",
				retryDecision: "terminal",
				durationMs: now - job.createdAt,
			});
			}
		this.ctx.storage.kv.put(BULK_ACTIVE_KEY, active);
	}

	#bulkMaintenanceAtSync(): number | null {
		const candidates: number[] = [];
		for (const [, reservation] of this.#bulkReservationEntriesSync()) {
			candidates.push(reservation.expiresAt);
		}
		const cleanupAt = bulkCleanupNextAt(
			this.#bulkCleanupEntriesSync().map(([, intent]) => intent),
			);
		if (cleanupAt !== null) candidates.push(cleanupAt);
		const active =
			this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
		for (const entry of active) {
			const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
			if (job?.status === "preparing") {
				candidates.push(job.createdAt + BULK_PREPARATION_MAX_AGE_MS);
			}
		}
		const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
		const head = queue[0]
			? this.ctx.storage.kv.get<BulkJob>(`bulk:job:${queue[0]}`)
			: null;
		if (head?.status === "queued" || head?.status === "running") {
			candidates.push(head.nextEnqueueAt ?? head.createdAt);
		}
		const history =
			this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
			[];
		for (const entry of history) {
			candidates.push(entry.completedAt + BULK_LIMITS.terminalRetentionMs);
		}
		return candidates.length > 0 ? Math.min(...candidates) : null;
	}

	async #ensureBulkMaintenanceAlarm(): Promise<void> {
		const next = this.ctx.storage.transactionSync(() =>
			this.#bulkMaintenanceAtSync(),
		);
		if (next !== null) await this.#scheduleAlarmAt(Math.max(Date.now(), next));
	}

	async #processBulkAdmissionPreparation(): Promise<boolean> {
		const preparation = this.ctx.storage.transactionSync(() => {
			const active =
				this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
			for (const entry of active) {
				const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
				const admission =
					this.ctx.storage.kv.get<BulkAdmissionRecord>(entry.admissionKey);
				if (
					job?.status === "preparing" &&
					admission?.status === "preparing" &&
					job.preparationGeneration === admission.generation
				) {
					return { entry, job, admission };
				}
			}
			return null;
		});
		if (!preparation) return false;

		const startedAt = Date.now();
		const { entry, job, admission } = preparation;
		const attachments: BulkAttachment[] = [];
		try {
			const staged: Array<{
				bytes: ArrayBuffer;
				filename: string;
				type: string;
				size: number;
			}> = [];
			for (const sourceKey of job.preparationAttachmentKeys ?? []) {
				const object = await this.env.BUCKET.get(sourceKey);
				if (!object) {
					throw new Error("missing_bulk_upload");
				}
				const metadata = object.customMetadata ?? {};
				staged.push({
					bytes: await object.arrayBuffer(),
					filename: (metadata.filename || "untitled").replace(
						/[\/\\:*?"<>|\x00-\x1f]/g,
						"_",
					),
					type:
						metadata.type ||
						object.httpMetadata?.contentType ||
						"application/octet-stream",
					size: object.size,
				});
			}
			const setError = validateAttachmentSet(
				staged.map((attachment) => ({
					filename: attachment.filename,
					size: attachment.size,
				})),
			);
			if (setError) throw new Error("invalid_bulk_attachment_set");

			// This is the sole R2 writer for admission copies. Durable Object alarm
			// invocations have a 15-minute hard wall-time limit, so the later
			// 20-minute deletion verification cannot race an unbounded HTTP writer.
			// https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type
			for (const [index, attachment] of staged.entries()) {
				const key = bulkAttachmentPreparationKey(
					job.id,
					admission.generation,
					index,
				);
				await this.env.BUCKET.put(key, attachment.bytes, {
					httpMetadata: { contentType: attachment.type },
				});
				attachments.push({
					key,
					filename: attachment.filename,
					type: attachment.type,
					size: attachment.size,
				});
			}
		} catch (error) {
			const failedAt = Date.now();
			const missing =
				error instanceof Error && error.message === "missing_bulk_upload";
			const publicError = missing
				? "An attachment upload was not found or has expired. Re-attach and try again."
				: "Bulk attachments could not be prepared. Re-attach them and try again.";
			const committed = this.ctx.storage.transactionSync(() => {
				const current =
					this.ctx.storage.kv.get<BulkAdmissionRecord>(entry.admissionKey);
				if (!current) return false;
				const failed = failBulkAdmission(
					current,
					admission.generation,
					publicError,
					failedAt,
				);
				if (!failed) return false;
				this.ctx.storage.kv.put(entry.admissionKey, failed);
				this.ctx.storage.kv.put(`bulk:job:${job.id}`, {
					...job,
					status: "failed",
					errors: [{ email: "", error: publicError }],
					updatedAt: failedAt,
				});
				this.ctx.storage.kv.delete(`bulk:rows:${job.id}`);
				this.#createBulkCleanupIntentSync({
					ownerId: `${job.id}:failed-preparation`,
					keys: job.preparationAttachmentKeys ?? [],
					dueAt: failedAt + BULK_PREPARATION_MAX_AGE_MS,
				});
				if (job.preparationCleanupIntentId) {
					this.#markBulkCleanupDueSync(
						job.preparationCleanupIntentId,
						failedAt,
					);
				}
				this.#removeBulkActiveSync(job.id);
				this.#recordBulkTerminalSync(job.id, entry.admissionKey, failedAt);
				return true;
			});
			console.error("[bulk-send] admission preparation completed", {
				operation: "bulk_admission_prepare",
				mailboxId: job.fromEmail,
				operationId: job.operationId,
				jobId: job.id,
				stage: "r2_generation_copy",
				result: committed ? "failed" : "fence_lost",
				errorCode: missing ? "missing_upload" : "r2_or_validation_failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				durationMs: failedAt - startedAt,
				retryDecision: "terminal",
			});
			await this.#ensureBulkMaintenanceAlarm();
			await this.#scheduleAlarmAt(Date.now() + 100);
			return true;
		}

		const committedAt = Date.now();
		const committed = this.ctx.storage.transactionSync(() => {
			const currentAdmission =
				this.ctx.storage.kv.get<BulkAdmissionRecord>(entry.admissionKey);
			const currentJob = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${job.id}`);
			if (!currentAdmission || !currentJob) return false;
			const nextAdmission = completeBulkAdmission(
				currentAdmission,
				admission.generation,
				committedAt,
			);
			if (!nextAdmission || currentJob.status !== "preparing") return false;
			const queuedJob: BulkJob = {
				...currentJob,
				status: "queued",
				updatedAt: committedAt,
				nextEnqueueAt: committedAt + 100,
				attachments: attachments.length > 0 ? attachments : undefined,
			};
			delete queuedJob.preparationCleanupIntentId;
			delete queuedJob.preparationGeneration;
			const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
			this.ctx.storage.kv.put(`bulk:job:${job.id}`, queuedJob);
			this.ctx.storage.kv.put(
				BULK_QUEUE_KEY,
				ensureBulkQueueMembership(queue, job.id),
			);
			this.ctx.storage.kv.put(entry.admissionKey, nextAdmission);
			this.#createBulkCleanupIntentSync({
				ownerId: `${job.id}:staging`,
				keys: currentJob.preparationAttachmentKeys ?? [],
				dueAt: committedAt + BULK_PREPARATION_MAX_AGE_MS,
			});
			return true;
		});
		if (!committed && job.preparationCleanupIntentId) {
			this.ctx.storage.transactionSync(() =>
				this.#markBulkCleanupDueSync(
					job.preparationCleanupIntentId!,
					committedAt,
				),
			);
		}
		console.info("[bulk-send] admission preparation completed", {
			operation: "bulk_admission_prepare",
			mailboxId: job.fromEmail,
			operationId: job.operationId,
			jobId: job.id,
			stage: "r2_generation_copy",
			result: committed ? "success" : "fence_lost",
			durationMs: committedAt - startedAt,
			retryDecision: committed ? "queue" : "cleanup",
		});
		await this.#ensureBulkMaintenanceAlarm();
		await this.#scheduleAlarmAt(Date.now() + 100);
		return true;
	}

	/**
	 * Enqueue a bulk-send job: validate the template against the CSV columns,
	 * persist recipients + template, and kick the alarm. The alarm sends one
	 * message per tick with a randomized throttle, so even a 200-recipient job
	 * stays well within per-invocation Worker limits and survives restarts.
	 */
	async reserveBulkOperation(input: {
		operationId: string;
		actorUserId: string;
		fingerprint: string;
		total: number;
	}): Promise<BulkReservationResult> {
		if (
			!BULK_OPERATION_ID_PATTERN.test(input.operationId) ||
			typeof input.actorUserId !== "string" ||
			input.actorUserId.length === 0 ||
			input.actorUserId.length > BULK_LIMITS.actorIdChars ||
			!/^[0-9a-f]{64}$/.test(input.fingerprint) ||
			!Number.isInteger(input.total) ||
			input.total < 1 ||
			input.total > BULK_LIMITS.maxRecipients
		) {
			return { status: "forbidden" };
		}

		const now = Date.now();
		const result = this.ctx.storage.transactionSync(() => {
			this.#pruneBulkReservationsSync(now);
			const reservationKey = `${BULK_RESERVATION_PREFIX}${input.operationId}`;
			const existingReservation =
				this.ctx.storage.kv.get<BulkAdmissionReservation>(reservationKey) ??
				null;
			const existingAdmission =
				this.ctx.storage.kv.get<BulkAdmissionRecord>(
					`bulk:admission:${input.operationId}`,
				) ?? null;
			const planned = planBulkAdmissionReservation({
				existingReservation,
				existingAdmission,
				...input,
				now,
			});
			if (planned.status !== "reserved" || planned.replayed) return planned;
			const mailboxDailyPlan = planBulkDailyReservation(
				this.ctx.storage.kv.get<BulkDailyReservationRecord>(
					BULK_DAILY_RESERVATION_KEY,
				) ?? null,
				now,
			);
			const actorDailyKey = `${BULK_DAILY_RESERVATION_ACTOR_PREFIX}${encodeURIComponent(input.actorUserId)}`;
			const actorDailyPlan = planBulkDailyReservation(
				this.ctx.storage.kv.get<BulkDailyReservationRecord>(actorDailyKey) ??
					null,
				now,
				BULK_LIMITS.maxReservationsPerActorPerUtcDay,
			);
			if (
				mailboxDailyPlan.status === "capacity" ||
				actorDailyPlan.status === "capacity"
			) {
				return {
					status: "capacity" as const,
					retryAt: bulkNextUtcDayAt(now),
				};
			}

			const reservations = this.#bulkReservationEntriesSync();
			const activeReservations = reservations.filter(
				([, reservation]) => reservation.expiresAt > now,
			);
			const actorActiveReservations = activeReservations.filter(
				([, reservation]) => reservation.actorUserId === input.actorUserId,
			);
			if (reservations.length >= BULK_LIMITS.maxReservationRecords) {
				const retryAt = Math.min(
					...reservations.map(
						([, reservation]) => reservation.expiresAt,
					),
				);
				return {
					status: "capacity" as const,
					retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
				};
			}
			if (activeReservations.length >= BULK_LIMITS.maxPendingReservations) {
				const retryAt = Math.min(
					...activeReservations.map(([, reservation]) => reservation.expiresAt),
				);
				return {
					status: "capacity" as const,
					retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
				};
			}
			if (
				actorActiveReservations.length >=
				BULK_LIMITS.maxPendingReservationsPerActor
			) {
				const retryAt = Math.min(
					...actorActiveReservations.map(
						([, reservation]) => reservation.expiresAt,
					),
				);
				return {
					status: "capacity" as const,
					retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
				};
			}
			this.ctx.storage.kv.put(reservationKey, planned.record);
			this.ctx.storage.kv.put(
				BULK_DAILY_RESERVATION_KEY,
				mailboxDailyPlan.record,
			);
			this.ctx.storage.kv.put(actorDailyKey, actorDailyPlan.record);
			return planned;
		});
		await this.#ensureBulkMaintenanceAlarm();
		return result;
	}

	async cancelBulkReservation(operationId: string, actorUserId: string) {
		if (
			!BULK_OPERATION_ID_PATTERN.test(operationId) ||
			typeof actorUserId !== "string" ||
			actorUserId.length === 0 ||
			actorUserId.length > BULK_LIMITS.actorIdChars
		) {
			return { status: "forbidden" as const };
		}
		const now = Date.now();
		const result = this.ctx.storage.transactionSync(() => {
			const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
				`bulk:admission:${operationId}`,
			);
			if (admission) {
				if (admission.actorUserId !== actorUserId) {
					return { status: "forbidden" as const };
				}
				return {
					status: "admitted" as const,
					jobId: admission.jobId,
					total: admission.total,
					admissionStatus: admission.status,
				};
			}
			const key = `${BULK_RESERVATION_PREFIX}${operationId}`;
			const reservation =
				this.ctx.storage.kv.get<BulkAdmissionReservation>(key);
			if (!reservation) return { status: "missing" as const };
			if (reservation.actorUserId !== actorUserId) {
				return { status: "forbidden" as const };
			}
			if (reservation.expiresAt <= now) {
				return { status: "expired" as const };
			}
			this.ctx.storage.kv.delete(key);
			return { status: "cancelled" as const };
		});
		await this.#ensureBulkMaintenanceAlarm();
		return result;
	}

	async enqueueBulkJob(input: {
		operationId: string;
		actorUserId: string;
		fromEmail: string;
		fromName: string;
		subject: string;
		html?: string;
		text?: string;
		recipients: BulkRecipient[];
		attachmentUploadIds?: string[];
	}): Promise<BulkEnqueueResult> {
		if (
			typeof input.operationId !== "string" ||
			typeof input.actorUserId !== "string" ||
			typeof input.fromEmail !== "string" ||
			typeof input.fromName !== "string" ||
			typeof input.subject !== "string" ||
			(input.html !== undefined && typeof input.html !== "string") ||
			(input.text !== undefined && typeof input.text !== "string") ||
			!Array.isArray(input.recipients) ||
			(input.attachmentUploadIds !== undefined &&
				!Array.isArray(input.attachmentUploadIds))
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Bulk request is invalid.",
			};
		}
		const recipients = input.recipients;
		const uuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (
			input.actorUserId.length === 0 ||
			input.actorUserId.length > BULK_LIMITS.actorIdChars ||
			input.fromEmail.length === 0 ||
			input.fromEmail.length > BULK_LIMITS.emailChars ||
			input.fromName.length > BULK_LIMITS.fromNameChars
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Bulk sender context is invalid.",
			};
		}
		if (!uuid.test(input.operationId)) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Bulk operation identity is invalid.",
			};
		}
		if (recipients.length === 0) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "No recipients provided.",
			};
		}
		if (recipients.length > BULK_LIMITS.maxRecipients) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: `Too many recipients: max ${BULK_LIMITS.maxRecipients} per job.`,
			};
		}
		if (
			!input.subject.trim() ||
			input.subject.length > BULK_LIMITS.subjectChars
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Subject is required.",
			};
		}
		if (
			(!input.html && !input.text) ||
			(input.html?.length ?? 0) > BULK_LIMITS.bodyChars ||
			(input.text?.length ?? 0) > BULK_LIMITS.bodyChars
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Email body is required.",
			};
		}
		const htmlError = bulkPersonalizedHtmlValidationError(
			input.html,
			recipients,
		);
		if (htmlError) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: htmlError,
			};
		}
		if ((input.attachmentUploadIds?.length ?? 0) > ATTACHMENT_LIMITS.maxFiles) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: `Too many attachments: max ${ATTACHMENT_LIMITS.maxFiles}.`,
			};
		}
		if (
			(input.attachmentUploadIds ?? []).some(
				(uploadId) =>
					typeof uploadId !== "string" ||
					!isCanonicalAttachmentUploadId(uploadId),
			)
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Attachment upload identity is invalid.",
			};
		}

		for (const r of recipients) {
			if (!r || typeof r !== "object" || Array.isArray(r)) {
				return {
					status: "rejected",
					code: "invalid_bulk_request",
					error: "Recipient rows are invalid.",
				};
			}
			const entries = Object.entries(r);
			if (
				entries.length === 0 ||
				entries.length > BULK_LIMITS.maxColumns ||
				entries.some(
					([key, value]) =>
						key.length === 0 ||
						key.length > BULK_LIMITS.columnNameChars ||
						typeof value !== "string" ||
						value.length > BULK_LIMITS.recipientValueChars,
				)
			) {
				return {
					status: "rejected",
					code: "invalid_bulk_request",
					error: "Recipient columns exceed the bulk request limits.",
				};
			}
			if (
				!r.email ||
				r.email.length > BULK_LIMITS.emailChars ||
				!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)
			) {
				return {
					status: "rejected",
					code: "invalid_bulk_request",
					error: "Every recipient row needs a valid 'email' column.",
				};
			}
		}
		const canonicalPayload = JSON.stringify({
			subject: input.subject,
			html: input.html,
			text: input.text,
			recipients,
			attachmentUploadIds: input.attachmentUploadIds ?? [],
		});
		if (
			new TextEncoder().encode(canonicalPayload).byteLength >
			BULK_LIMITS.requestBytes
		) {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: `Bulk request exceeds the ${BULK_LIMITS.requestBytes / 1_024} KB limit.`,
			};
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
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: `Template uses columns not in the CSV: ${missing.join(", ")}`,
			};
		}

		const fingerprint = await bulkAdmissionFingerprint({
			actorUserId: input.actorUserId,
			subject: input.subject,
			html: input.html,
			text: input.text,
			recipients,
			attachmentUploadIds: input.attachmentUploadIds,
		});
		const admissionKey = `bulk:admission:${input.operationId}`;
		const now = Date.now();
		// Cloudflare's Durable Objects rules warn that input gates do not protect
		// across R2 I/O. Claim in one local storage transaction before touching R2,
		// then fence the later commit by generation.
		// https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
		const claimResult = this.ctx.storage.transactionSync(() => {
			const active =
				this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
			const existingAdmission =
				this.ctx.storage.kv.get<BulkAdmissionRecord>(admissionKey) ?? null;
			let dailyPlan: ReturnType<typeof planBulkDailyAdmission> | null = null;
			if (!existingAdmission) {
				const reservation = this.ctx.storage.kv.get<BulkAdmissionReservation>(
					`${BULK_RESERVATION_PREFIX}${input.operationId}`,
				);
				if (
					!reservation ||
					reservation.actorUserId !== input.actorUserId ||
					reservation.fingerprint !== fingerprint ||
					reservation.total !== recipients.length ||
					reservation.expiresAt <= now
				) {
					return { status: "reservation_invalid" as const };
				}
				const rejectCapacity = (
					reason: "active_backlog" | "cleanup_backlog" | "daily_limit",
					retryAt: number,
				) => {
					this.ctx.storage.kv.delete(
						`${BULK_RESERVATION_PREFIX}${input.operationId}`,
					);
					return { status: "capacity" as const, reason, retryAt };
				};
				const activeJobIds = new Set(active.map((entry) => entry.jobId));
				let outstandingJobs = 0;
				for (const entry of active) {
					const job = this.ctx.storage.kv.get<BulkJob>(
						`bulk:job:${entry.jobId}`,
					);
					if (!job) continue;
					outstandingJobs += 1;
				}
				const legacyQueue =
					this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
				for (const queuedJobId of new Set(legacyQueue)) {
					if (activeJobIds.has(queuedJobId)) continue;
					const queuedJob = this.ctx.storage.kv.get<BulkJob>(
						`bulk:job:${queuedJobId}`,
					);
					if (
						!queuedJob ||
						queuedJob.status === "done" ||
						queuedJob.status === "cancelled" ||
						queuedJob.status === "failed"
					)
						continue;
					outstandingJobs += 1;
				}
				const outstandingRecipients = this.#bulkOutstandingRecipientCountSync();
				const cleanupBacklog = bulkCleanupBacklogCount(
					this.#bulkCleanupEntriesSync().map(([, intent]) => intent),
					now,
					60_000,
				);
				dailyPlan = planBulkDailyAdmission(
					this.ctx.storage.kv.get<BulkDailyAdmissionRecord>(
						BULK_DAILY_ADMISSION_KEY,
					) ?? null,
					now,
					recipients.length,
				);
				if (dailyPlan.status === "capacity") {
					return rejectCapacity("daily_limit", bulkNextUtcDayAt(now));
				}
				if (cleanupBacklog >= BULK_LIMITS.maxCleanupJobs) {
					return rejectCapacity("cleanup_backlog", now + 60_000);
				}
				if (
					outstandingJobs >= BULK_LIMITS.maxActiveJobs ||
					outstandingRecipients + recipients.length >
						BULK_LIMITS.maxOutstandingRecipients
				) {
					return rejectCapacity("active_backlog", now + 60_000);
				}
			}

			const planned = planBulkAdmissionClaim({
				existing: existingAdmission,
				operationId: input.operationId,
				actorUserId: input.actorUserId,
				fingerprint,
				total: recipients.length,
				now,
				createJobId: () => `job_${crypto.randomUUID()}`,
			});
			let generationCleanupIntentId: string | null = null;
			if (planned.status === "claimed") {
				this.#markBulkGenerationCleanupDueSync(planned.record.jobId, now);
				this.ctx.storage.kv.put(admissionKey, planned.record);
				this.ctx.storage.kv.delete(
					`${BULK_RESERVATION_PREFIX}${input.operationId}`,
				);
				if (!existingAdmission && dailyPlan?.status === "accepted") {
					this.ctx.storage.kv.put(BULK_DAILY_ADMISSION_KEY, dailyPlan.record);
				}
				const existingJob = this.ctx.storage.kv.get<BulkJob>(
					`bulk:job:${planned.record.jobId}`,
				);
				this.ctx.storage.kv.put(`bulk:job:${planned.record.jobId}`, {
					...(existingJob ?? {
						id: planned.record.jobId,
						operationId: input.operationId,
			actorUserId: input.actorUserId,
			fromEmail: input.fromEmail.toLowerCase(),
			fromName: input.fromName,
			subject: input.subject,
			html: input.html,
			text: input.text,
			total: recipients.length,
			enqueued: 0,
			failed: 0,
			cursor: 0,
			errors: [],
						createdAt: planned.record.createdAt,
					}),
					status: "preparing",
					preparationAttachmentKeys: (input.attachmentUploadIds ?? []).map(
						(uploadId) => uploadKey(input.fromEmail, uploadId),
					),
			updatedAt: now,
				} satisfies BulkJob);
				const generationKeys = (input.attachmentUploadIds ?? []).map(
					(_uploadId, index) =>
						bulkAttachmentPreparationKey(
							planned.record.jobId,
							planned.record.generation,
							index,
						),
				);
				generationCleanupIntentId = this.#createBulkCleanupIntentSync({
					ownerId: `${planned.record.jobId}:generation-${planned.record.generation}`,
					keys: generationKeys,
					dueAt: planned.record.createdAt + BULK_PREPARATION_MAX_AGE_MS,
					verifyAt: planned.record.createdAt + BULK_STALE_WRITER_VERIFY_MS,
					protectAdmissionKey: admissionKey,
					protectGeneration: planned.record.generation,
				});
				const preparingJob = this.ctx.storage.kv.get<BulkJob>(
					`bulk:job:${planned.record.jobId}`,
				);
				if (preparingJob) {
					this.ctx.storage.kv.put(`bulk:job:${planned.record.jobId}`, {
						...preparingJob,
						preparationCleanupIntentId: generationCleanupIntentId,
						preparationGeneration: planned.record.generation,
					});
				}
				this.ctx.storage.kv.put(
					`bulk:rows:${planned.record.jobId}`,
					recipients,
				);
				if (!active.some((entry) => entry.jobId === planned.record.jobId)) {
					active.push({
						jobId: planned.record.jobId,
						admissionKey,
						total: recipients.length,
						createdAt: planned.record.createdAt,
					});
				}
			}
			this.ctx.storage.kv.put(BULK_ACTIVE_KEY, active);
			return {
				status: "claim" as const,
				claim: planned,
			};
		});
		await this.#ensureBulkMaintenanceAlarm();
		if (claimResult.status === "reservation_invalid") {
			return {
				status: "rejected",
				code: "bulk_reservation_expired",
				error:
					"This bulk operation reservation is unavailable or expired. Start a new submission.",
			};
		}
		if (claimResult.status === "capacity") {
			const messages = {
				active_backlog:
					"This Mailbox has the maximum safe bulk backlog. Wait for current jobs to progress.",
				cleanup_backlog:
					"This Mailbox is finishing attachment cleanup. Retry shortly.",
				daily_limit:
					"This Mailbox reached today's safe bulk sending limit. Retry after the next UTC day begins.",
			} as const;
			return {
				status: "capacity",
				code: "bulk_capacity_reached",
				error: messages[claimResult.reason],
				reason: claimResult.reason,
				retryAt: claimResult.retryAt,
			};
		}
		const claim = claimResult.claim;
		if (claim.status === "forbidden") {
			return {
				status: "rejected",
				code: "invalid_bulk_request",
				error: "Bulk operation identity is unavailable.",
			};
		}

		if (claim.status === "conflict") {
			return {
				status: "conflict",
				jobId: claim.record.jobId,
				total: claim.record.total,
			};
		}
		if (claim.status === "failed") {
			return {
				status: "rejected",
				code: "bulk_admission_failed",
				error: claim.record.error ?? "Bulk job could not be prepared.",
				jobId: claim.record.jobId,
			};
		}
		if (claim.status === "preparing") {
			await this.#scheduleAlarmAt(Date.now() + 100);
			return {
				status: "accepted",
				jobId: claim.record.jobId,
				total: claim.record.total,
				replayed: true,
				admissionStatus: "preparing",
			};
		}
		if (claim.status === "replay") {
			if (this.#repairBulkQueueMembership(claim.record.jobId)) {
				await this.#scheduleAlarmAt(Date.now() + 100);
			}
			return {
				status: "accepted",
				jobId: claim.record.jobId,
				total: claim.record.total,
				replayed: true,
				admissionStatus: "queued",
			};
		}
		await this.#scheduleAlarmAt(Date.now() + 100);
		return {
			status: "accepted",
			jobId: claim.record.jobId,
			total: recipients.length,
			replayed: false,
			admissionStatus: "preparing",
		};
	}

	async getBulkJob(jobId: string): Promise<BulkJobProgress | null> {
		if (!BULK_JOB_ID_PATTERN.test(jobId)) return null;
		const job = await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`);
		if (!job) return null;
		return {
			id: job.id,
			status: job.status,
			total: job.total,
			enqueued: job.enqueued,
			failed: job.failed,
			cursor: job.cursor,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			errorCount: job.errors.length,
			errorsTruncated: job.errors.length > BULK_LIMITS.maxRecipients + 1,
			errors: job.errors
				.slice(0, BULK_LIMITS.maxRecipients + 1)
				.map((error) => ({
					email: error.email.slice(0, BULK_LIMITS.emailChars),
					error: SAFE_BULK_ERRORS.has(error.error)
						? error.error
						: "Recipient could not be queued.",
				})),
		};
	}

	async getBulkJobByOperation(operationId: string, actorUserId: string) {
		if (
			!BULK_OPERATION_ID_PATTERN.test(operationId) ||
			typeof actorUserId !== "string" ||
			actorUserId.length === 0 ||
			actorUserId.length > BULK_LIMITS.actorIdChars
		) {
			return null;
		}
		const recovered = this.ctx.storage.transactionSync(() => {
			const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
				`bulk:admission:${operationId}`,
			);
			if (admission) {
				if (admission.actorUserId !== actorUserId) return null;
				const job = this.ctx.storage.kv.get<BulkJob>(
					`bulk:job:${admission.jobId}`,
				);
				if (job && job.actorUserId !== actorUserId) return null;
				return {
					state: "admitted" as const,
					jobId: admission.jobId,
					total: admission.total,
					admissionStatus: admission.status,
					jobStatus: job?.status ?? null,
				};
			}
			const reservation =
				this.ctx.storage.kv.get<BulkAdmissionReservation>(
					`${BULK_RESERVATION_PREFIX}${operationId}`,
				);
			if (!reservation || reservation.actorUserId !== actorUserId) return null;
			if (reservation.expiresAt <= Date.now()) {
				return { state: "expired" as const };
			}
			return {
				state: "reserved" as const,
				expiresAt: reservation.expiresAt,
			};
		});
		if (!recovered) return null;
		await this.#ensureBulkMaintenanceAlarm();
		if (recovered.state === "admitted") {
			if (
				recovered.jobStatus === "queued" ||
				recovered.jobStatus === "running"
			) {
				this.#repairBulkQueueMembership(recovered.jobId);
				await this.#scheduleAlarmAt(Date.now() + 100);
			} else if (recovered.jobStatus === "preparing") {
				await this.#scheduleAlarmAt(Date.now() + 100);
			}
			const { jobStatus: _jobStatus, ...projection } = recovered;
			return projection;
		}
		return recovered;
	}

	#repairBulkQueueMembership(jobId: string): boolean {
		return this.ctx.storage.transactionSync(() => {
			const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${jobId}`);
			if (!job || (job.status !== "queued" && job.status !== "running")) {
				return false;
			}
			const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
			this.ctx.storage.kv.put(
				BULK_QUEUE_KEY,
				ensureBulkQueueMembership(queue, jobId),
			);
			return true;
		});
	}

	#bulkRecipientPreparationKey(jobId: string, cursor: number): string {
		return `${BULK_RECIPIENT_PREPARATION_PREFIX}${jobId}:${cursor}`;
	}

	#createBulkRecipientPreparationSync(
		job: BulkJob,
		messageId: string,
	): BulkRecipientPreparation | null {
		if (!job.attachments?.length) return null;
		const key = this.#bulkRecipientPreparationKey(job.id, job.cursor);
		const existing = this.ctx.storage.kv.get<BulkRecipientPreparation>(key);
		if (existing) return existing;
		const attachments = job.attachments.map((attachment, index) => {
			const id = `bulk_attachment_${index}_${crypto.randomUUID()}`;
			return {
					id,
					email_id: messageId,
					filename: safeAttachmentStorageFilename(
						attachment.filename,
						attachmentKeyPrefix(messageId, id),
					),
					mimetype: attachment.type,
					size: attachment.size,
					disposition: "attachment",
				} satisfies PendingOutboundAttachment;
		});
		const keys = attachments.map((attachment) =>
			attachmentKey(messageId, attachment.id, attachment.filename),
		);
		const idempotencyKey = `bulk:${job.id}:${job.cursor}`;
		const cleanupIntentId = this.#createBulkCleanupIntentSync({
			ownerId: `${job.id}:recipient-${job.cursor}`,
			keys,
			dueAt: Date.now() + BULK_LIMITS.recipientCleanupDelayMs,
			protectDeliveryKey: idempotencyKey,
			protectEmailId: messageId,
			protectPreparationKey: key,
		});
		if (!cleanupIntentId) return null;
		const preparation: BulkRecipientPreparation = {
			jobId: job.id,
			cursor: job.cursor,
			idempotencyKey,
			messageId,
			attachments,
			keys,
			cleanupIntentId,
			createdAt: Date.now(),
		};
		this.ctx.storage.kv.put(key, preparation);
		return preparation;
	}

	#finishBulkRecipientPreparationSync(
		preparation: BulkRecipientPreparation,
		committedToEmailId: string | null,
	): void {
		const preparationKey = this.#bulkRecipientPreparationKey(
			preparation.jobId,
			preparation.cursor,
		);
		if (committedToEmailId === preparation.messageId) {
			this.ctx.storage.kv.delete(
				`${BULK_ATTACHMENT_CLEANUP_PREFIX}${preparation.cleanupIntentId}`,
			);
		} else {
			this.#markBulkCleanupDueSync(preparation.cleanupIntentId, Date.now());
		}
		this.ctx.storage.kv.delete(preparationKey);
	}

	async #processBulkAttachmentCleanup(): Promise<void> {
		const claim = this.ctx.storage.transactionSync(() => {
			const planned = planBulkCleanupClaim(
				this.#bulkCleanupEntriesSync(),
				Date.now(),
				crypto.randomUUID(),
				BULK_LIMITS.cleanupLeaseMs,
			);
			if (!planned) return null;
			this.ctx.storage.kv.put(planned.key, planned.intent);
			return planned;
		});
		if (!claim) return;
		const cleanupStartedAt = Date.now();

		const retry = () => {
			this.ctx.storage.transactionSync(() => {
				const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
				if (!current) return;
				const next = retryBulkCleanupClaim(
					current,
					claim.intent.leaseToken!,
					Date.now(),
					60_000,
				);
				if (next) this.ctx.storage.kv.put(claim.key, next);
			});
		};
		const complete = () => {
			this.ctx.storage.transactionSync(() => {
				const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
				if (
					current &&
					completeBulkCleanupClaim(current, claim.intent.leaseToken!)
				) {
					this.ctx.storage.kv.delete(claim.key);
	}
			});
		};

		if (claim.intent.protectAdmissionKey) {
			const protectedByGeneration = this.ctx.storage.transactionSync(() => {
				const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
					claim.intent.protectAdmissionKey!,
		);
				const job = admission
					? this.ctx.storage.kv.get<BulkJob>(`bulk:job:${admission.jobId}`)
					: null;
				const preparing =
					admission?.status === "preparing" &&
					admission.generation === claim.intent.protectGeneration;
				const jobOwnsKeys =
					admission?.generation === claim.intent.protectGeneration &&
					(job?.status === "queued" || job?.status === "running") &&
					claim.intent.keys.every((key) =>
						job.attachments?.some((attachment) => attachment.key === key),
					);
				if (!preparing && !jobOwnsKeys) return false;
				const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
				if (current) {
					const next = retryBulkCleanupClaim(
						current,
						claim.intent.leaseToken!,
						Date.now(),
						BULK_LIMITS.recipientCleanupDelayMs,
					);
					if (next) this.ctx.storage.kv.put(claim.key, next);
				}
				return true;
			});
			if (protectedByGeneration) {
				console.info("[bulk-send] attachment cleanup completed", {
					operation: "bulk_attachment_cleanup",
					cleanupId: claim.intent.id,
					ownerId: claim.intent.ownerId,
					result: "deferred_for_generation",
					retryDecision: "retry",
					durationMs: Date.now() - cleanupStartedAt,
				});
				await this.#ensureBulkMaintenanceAlarm();
				return;
			}
		}

		if (claim.intent.protectDeliveryKey) {
			let delivery;
			try {
				delivery = await this.getOutboundDeliveryByIdempotencyKey(
					claim.intent.protectDeliveryKey,
				);
			} catch (error) {
				retry();
				console.error("[bulk-send] attachment cleanup completed", {
					operation: "bulk_attachment_cleanup",
					cleanupId: claim.intent.id,
					ownerId: claim.intent.ownerId,
					result: "ownership_check_failure",
					target: "outbound_delivery_store",
					errorName: error instanceof Error ? error.name : "UnknownError",
					retryDecision: "retry",
					durationMs: Date.now() - cleanupStartedAt,
				});
				await this.#ensureBulkMaintenanceAlarm();
				return;
			}
			if (delivery?.emailId === claim.intent.protectEmailId) {
				complete();
				console.info("[bulk-send] attachment cleanup completed", {
					operation: "bulk_attachment_cleanup",
					cleanupId: claim.intent.id,
					ownerId: claim.intent.ownerId,
					result: "transferred_to_delivery",
					retryDecision: "complete",
					durationMs: Date.now() - cleanupStartedAt,
				});
				await this.#ensureBulkMaintenanceAlarm();
				return;
			}
		}

		if (claim.intent.protectPreparationKey) {
			const protectedByPreparation = this.ctx.storage.transactionSync(() => {
				const preparation = this.ctx.storage.kv.get<BulkRecipientPreparation>(
					claim.intent.protectPreparationKey!,
				);
				if (!preparation) return false;
				const job = this.ctx.storage.kv.get<BulkJob>(
					`bulk:job:${preparation.jobId}`,
				);
				if (
					job &&
					(job.status === "queued" || job.status === "running") &&
					job.cursor === preparation.cursor
				) {
					const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
					if (current) {
						const next = retryBulkCleanupClaim(
							current,
							claim.intent.leaseToken!,
							Date.now(),
							BULK_LIMITS.recipientCleanupDelayMs,
						);
						if (next) this.ctx.storage.kv.put(claim.key, next);
					}
					return true;
				}
				this.ctx.storage.kv.delete(claim.intent.protectPreparationKey!);
				return false;
			});
			if (protectedByPreparation) {
				console.info("[bulk-send] attachment cleanup completed", {
					operation: "bulk_attachment_cleanup",
					cleanupId: claim.intent.id,
					ownerId: claim.intent.ownerId,
					result: "deferred_for_recipient",
					retryDecision: "retry",
					durationMs: Date.now() - cleanupStartedAt,
				});
				await this.#ensureBulkMaintenanceAlarm();
				return;
			}
		}

		try {
			await this.env.BUCKET.delete(claim.intent.keys);
			const deletedAt = Date.now();
			if (claim.intent.verifyAt && claim.intent.verifyAt > deletedAt) {
				this.ctx.storage.transactionSync(() => {
					const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
					if (current?.leaseToken !== claim.intent.leaseToken) return;
					this.ctx.storage.kv.put(claim.key, {
						...current,
						dueAt: claim.intent.verifyAt!,
						leaseToken: null,
						leaseExpiresAt: null,
						deleteConfirmedAt: deletedAt,
					});
				});
			} else {
				complete();
			}
			console.info("[bulk-send] attachment cleanup completed", {
				operation: "bulk_attachment_cleanup",
				cleanupId: claim.intent.id,
				ownerId: claim.intent.ownerId,
				result:
					claim.intent.verifyAt && claim.intent.verifyAt > deletedAt
						? "verification_scheduled"
						: "deleted",
				target: "r2",
				keyCount: claim.intent.keys.length,
				retryDecision:
					claim.intent.verifyAt && claim.intent.verifyAt > deletedAt
						? "verify"
						: "complete",
				durationMs: Date.now() - cleanupStartedAt,
			});
		} catch (error) {
			retry();
			console.error("[bulk-send] attachment cleanup completed", {
				operation: "bulk_attachment_cleanup",
				cleanupId: claim.intent.id,
				ownerId: claim.intent.ownerId,
				result: "failure",
				target: "r2",
				keyCount: claim.intent.keys.length,
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry",
				durationMs: Date.now() - cleanupStartedAt,
			});
		}
		await this.#ensureBulkMaintenanceAlarm();
	}

	#commitBulkTerminalSync(jobId: string, job?: BulkJob): number {
		return this.ctx.storage.transactionSync(() => {
			const completedAt = Date.now();
			if (job) {
				this.ctx.storage.kv.put(`bulk:job:${jobId}`, job);
				this.#createBulkCleanupIntentSync({
					ownerId: `${jobId}:terminal`,
					keys: [
						...(job.attachments?.map((attachment) => attachment.key) ?? []),
					],
					dueAt: completedAt,
				});
				this.#markBulkGenerationCleanupDueSync(jobId, completedAt);
				this.#abandonBulkRecipientPreparationSync(
					jobId,
					job.cursor,
					completedAt,
				);
			}
			this.ctx.storage.kv.delete(`bulk:rows:${jobId}`);
			const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
			const remaining = removeBulkQueueMembership(queue, jobId);
			this.ctx.storage.kv.put(BULK_QUEUE_KEY, remaining);
			const active =
				this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
			const activeEntry = active.find((entry) => entry.jobId === jobId);
			this.#removeBulkActiveSync(jobId);
			const admissionKey = job?.operationId
				? `bulk:admission:${job.operationId}`
				: activeEntry?.admissionKey;
			if (admissionKey) {
				this.#recordBulkTerminalSync(jobId, admissionKey, completedAt);
			}
			return remaining.length;
		});
	}

	/** Enqueue the next recipient of the head job, persist progress, reschedule. */
	async alarm(): Promise<void> {
		const alarmNow = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.#expireBulkPreparationsSync(alarmNow);
			this.#pruneBulkTerminalSync(alarmNow);
			this.#pruneBulkReservationsSync(alarmNow);
		});
		await this.#ensureBulkMaintenanceAlarm();
		await this.#processBulkAdmissionPreparation();
		const nextSemanticAt = await this.#processSemanticIndexAlarm(alarmNow);
		if (nextSemanticAt !== null) await this.#scheduleAlarmAt(nextSemanticAt);
		try {
			const nextAutomationAt = this.#processAutomationRulesAlarm();
			if (nextAutomationAt !== null) {
				await this.#scheduleAlarmAt(
					Math.max(Date.now() + 100, nextAutomationAt),
				);
			}
		} catch (error) {
			console.error("[automation-rules] alarm pass failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		const pushVapid = vapidConfig(this.env);
		const nextPushAt = await processPushOutbox({
			storage: {
				sql: this.ctx.storage.sql,
				transactionSync: (run) => this.ctx.storage.transactionSync(run),
			},
			vapidConfigured: pushVapid !== null,
			createToken: () => crypto.randomUUID(),
			canAccess: (userId, mailboxId) =>
				mailboxAccess(this.env).canAccessMailbox(userId, mailboxId),
			send: (subscription, payload, options) => {
				if (!pushVapid) {
					return Promise.resolve({
						ok: false as const,
						reason: "CONFIG_ERROR" as const,
						shouldDelete: false,
						statusCode: null,
					});
				}
				return sendWebPush(subscription, payload, pushVapid, {
					signal: options.signal,
					timeoutMs: Math.max(1, options.deadlineMs - Date.now()),
				});
			},
			scheduleAlarmAt: (timestamp) => this.#scheduleAlarmAt(timestamp),
		});
		if (nextPushAt !== null) await this.#scheduleAlarmAt(nextPushAt);
		const replyWakePending = this.#processReplyWakeBatch();
		const nextSnoozeAt = this.#processDueSnoozeBatch(alarmNow);
		const nextFollowUpAt =
			await this.#processFollowUpReplyCompletionQueue(alarmNow);
		const nextSnoozeAlarm = earliestMailboxAlarm([
			replyWakePending ? alarmNow + 100 : null,
			nextSnoozeAt,
			nextFollowUpAt,
		]);
		if (nextSnoozeAlarm !== null) {
			await this.#scheduleAlarmAt(Math.max(alarmNow, nextSnoozeAlarm));
		}
		const nextDraftSaveCleanupAt = await this.#processDraftSaveCleanup(alarmNow);
		if (nextDraftSaveCleanupAt !== null) {
			await this.#scheduleAlarmAt(
				Math.max(Date.now() + 100, nextDraftSaveCleanupAt),
			);
		}
		const cleanupPending = await this.#processAttachmentCleanup();
		await this.#processBulkAttachmentCleanup();
		if (cleanupPending) {
			await this.#scheduleAlarmAt(Date.now() + 60_000);
		}
		await this.#processOutboundAlarm();
		let queue: string[];
		try {
			queue = (await this.ctx.storage.get<string[]>(BULK_QUEUE_KEY)) ?? [];
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: "queue_read",
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - alarmNow,
			});
			throw error;
		}
		if (queue.length === 0) {
			await this.#ensureBulkMaintenanceAlarm();
			return;
		}

		const jobId = queue[0];
		let job: BulkJob | undefined;
		try {
			job = await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`);
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: "job_read",
				jobId,
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - alarmNow,
			});
			throw error;
		}
		let rows: BulkRecipient[];
		try {
			rows =
				(await this.ctx.storage.get<BulkRecipient[]>(`bulk:rows:${jobId}`)) ??
				[];
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: "rows_read",
				mailboxId: job?.fromEmail,
				operationId: job?.operationId,
				jobId,
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - alarmNow,
			});
			throw error;
		}
		if (job) job.enqueued ??= job.sent ?? 0;

		// Drop a finished/missing job and move on.
		if (
			!job ||
			job.status === "done" ||
			job.status === "cancelled" ||
			job.cursor >= rows.length
		) {
			if (job && job.cursor >= rows.length) {
				job.status = "done";
				job.updatedAt = Date.now();
			}
			const remainingJobs = this.#commitBulkTerminalSync(
				jobId,
				job ?? undefined,
			);
			if (job) {
				console.info("[bulk-send] job reached terminal state", {
					operation: "bulk_job_terminal",
					mailboxId: job.fromEmail,
					actorUserId: job.actorUserId,
					operationId: job.operationId,
					jobId,
					status: job.status,
					result: "reconciled_terminal",
					terminalReason:
						job.cursor >= rows.length
							? "cursor_exhausted"
							: "already_terminal",
					total: job.total,
					cursor: job.cursor,
					enqueued: job.enqueued,
					failed: job.failed,
					remainingJobs,
					retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
					durationMs: Date.now() - job.createdAt,
				});
			} else {
				console.error("[bulk-send] job reached terminal state", {
					operation: "bulk_job_terminal",
					jobId,
					result: "missing_job",
					terminalReason: "queue_entry_without_job",
					action: "removed_from_queue",
					remainingJobs,
					retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
					durationMs: Date.now() - alarmNow,
				});
			}
			await this.#ensureBulkMaintenanceAlarmForJob({
				startedAt: alarmNow,
				jobId,
				...(job ? { job } : {}),
			});
			if (remainingJobs > 0) {
				await this.#scheduleBulkAlarmAt(Date.now() + 100, {
					stage: "next_job_schedule",
					startedAt: alarmNow,
					jobId,
					...(job ? { job } : {}),
				});
			}
			return;
		}

		let canAccess = false;
		if (job.actorUserId) {
			const authorizationStartedAt = Date.now();
			try {
				canAccess = await mailboxAccess(this.env).canAccessMailbox(
					job.actorUserId,
					job.fromEmail,
				);
			} catch (error) {
				console.error("[bulk-send] job authorization failed", {
					operation: "bulk_job_authorization",
					mailboxId: job.fromEmail,
					actorUserId: job.actorUserId,
					operationId: job.operationId,
					jobId,
					result: "failure",
					target: "mailbox_access",
					errorName: error instanceof Error ? error.name : "UnknownError",
					retryDecision: "retry_alarm",
					durationMs: Date.now() - authorizationStartedAt,
				});
				throw error;
			}
		}
		if (!job.actorUserId || !canAccess) {
			job.status = "cancelled";
			job.updatedAt = Date.now();
			job.errors.push({
				email: "",
				error:
					"Job cancelled because the initiating user's mailbox access ended.",
			});
			const remainingJobs = this.#commitBulkTerminalSync(jobId, job);
			console.warn("[bulk-send] job reached terminal state", {
				operation: "bulk_job_terminal",
				mailboxId: job.fromEmail,
				actorUserId: job.actorUserId || undefined,
				operationId: job.operationId,
				jobId,
				status: job.status,
				result: "cancelled",
				terminalReason: job.actorUserId ? "access_revoked" : "missing_actor",
				total: job.total,
				cursor: job.cursor,
				enqueued: job.enqueued,
				failed: job.failed,
				remainingJobs,
				retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
				durationMs: Date.now() - job.createdAt,
			});
			await this.#ensureBulkMaintenanceAlarmForJob({
				startedAt: alarmNow,
				jobId,
				job,
			});
			if (remainingJobs > 0) {
				await this.#scheduleBulkAlarmAt(Date.now() + 100, {
					stage: "next_job_schedule",
					startedAt: alarmNow,
					jobId,
					job,
				});
			}
			return;
		}

		const currentTime = Date.now();
		const nextEnqueueAt = job.nextEnqueueAt ?? job.createdAt;
		if (nextEnqueueAt > currentTime) {
			await this.#scheduleBulkAlarmAt(nextEnqueueAt, {
				stage: "throttle_schedule",
				startedAt: alarmNow,
				jobId,
				job,
			});
			return;
		}

		if (job.status === "queued") job.status = "running";

		const row = rows[job.cursor];
		const to = row.email;
		const subject = renderBulkTemplate(job.subject, row, false)
			.replace(/[\r\n]+/g, " ")
			.trim();
		const html = job.html
			? renderBulkTemplate(job.html, row, true)
			: undefined;
		const text = job.text
			? renderBulkTemplate(job.text, row, false)
			: undefined;

		const idempotencyKey = `bulk:${job.id}:${job.cursor}`;
		const recipientStartedAt = Date.now();
		let authoritative: StoredOutboundDelivery | null;
		try {
			authoritative =
				await this.getOutboundDeliveryByIdempotencyKey(idempotencyKey);
		} catch (error) {
			console.error("[bulk-send] recipient enqueue completed", {
				operation: "bulk_recipient_enqueue",
				mailboxId: job.fromEmail,
				operationId: job.operationId,
				jobId: job.id,
				cursor: job.cursor,
				stage: "idempotency_lookup",
				result: "failure",
				target: "outbound_delivery_store",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - recipientStartedAt,
			});
			throw error;
		}
		let preparation: BulkRecipientPreparation | null = null;
		let messageId = authoritative?.emailId ?? "";
		if (authoritative) {
			try {
				this.ctx.storage.transactionSync(() => {
					const stalePreparation =
						this.ctx.storage.kv.get<BulkRecipientPreparation>(
							this.#bulkRecipientPreparationKey(job.id, job.cursor),
						);
					if (stalePreparation) {
						this.#finishBulkRecipientPreparationSync(
							stalePreparation,
							authoritative!.emailId,
						);
					}
				});
			} catch (error) {
				console.error("[bulk-send] recipient enqueue completed", {
					operation: "bulk_recipient_enqueue",
					mailboxId: job.fromEmail,
					operationId: job.operationId,
					jobId: job.id,
					cursor: job.cursor,
					stage: "replay_cleanup",
					result: "failure",
					target: "durable_storage",
					errorName: error instanceof Error ? error.name : "UnknownError",
					retryDecision: "retry_alarm",
					durationMs: Date.now() - recipientStartedAt,
				});
				throw error;
			}
		}

		try {
			if (!authoritative) {
				const fromDomain = job.fromEmail.split("@")[1] || "";
				const generated = generateMessageId(fromDomain).messageId;
				preparation = this.ctx.storage.transactionSync(() =>
					this.#createBulkRecipientPreparationSync(job, generated),
				);
				messageId = preparation?.messageId ?? generated;
				if (preparation) {
					const activePreparation = preparation;
					// Cloudflare alarms are at-least-once but have a bounded automatic
					// retry count. Persist and schedule cleanup before external R2 I/O.
					// https://developers.cloudflare.com/durable-objects/api/alarms/
					await this.#ensureBulkMaintenanceAlarm();
					for (const [index, attachment] of (job.attachments ?? []).entries()) {
						const source = await this.env.BUCKET.get(attachment.key);
						if (!source) {
							throw new BulkRecipientAttachmentUnavailableError(
								attachment.filename,
							);
						}
						await this.env.BUCKET.put(
							activePreparation.keys[index],
							await source.arrayBuffer(),
							{
								httpMetadata: { contentType: attachment.type },
							},
						);
					}
				}
				const pendingAttachments = preparation?.attachments ?? [];
				const activePreparation = preparation;
			const requestedAt = new Date().toISOString();
				await this.#enqueueOutboundInternal(
				{
						idempotencyKey,
					source: "bulk",
					actor: { kind: "user", id: job.actorUserId },
					snapshot: {
						mailboxId: job.fromEmail,
						kind: "bulk",
						to: [to.toLowerCase()],
						cc: [],
						bcc: [],
						from: job.fromEmail,
						subject,
						...(html !== undefined ? { html } : {}),
						...(text !== undefined ? { text } : {}),
						threadId: messageId,
						attachmentIds: pendingAttachments.map(
							(attachment) => attachment.id,
						),
					},
					requestedAt,
					undoUntil: requestedAt,
				},
				pendingAttachments,
				messageId,
					activePreparation
						? (result) =>
								this.#finishBulkRecipientPreparationSync(
									activePreparation,
									result.delivery.emailId,
								)
						: undefined,
			);
			}
			// This counter now records rows durably accepted into the truthful outbox.
			// Provider acceptance remains visible on each outbound delivery record.
			job.enqueued += 1;
			console.info("[bulk-send] recipient enqueue completed", {
				operation: "bulk_recipient_enqueue",
				mailboxId: job.fromEmail,
				operationId: job.operationId,
				jobId: job.id,
				cursor: job.cursor,
				result: authoritative ? "replay" : "committed",
				target: "outbound_delivery_store",
				durationMs: Date.now() - recipientStartedAt,
			});
		} catch (e) {
			try {
				authoritative =
					await this.getOutboundDeliveryByIdempotencyKey(idempotencyKey);
			} catch (reconciliationError) {
				// The alarm must retry while commit state is indeterminate. Deleting
				// bytes or advancing the cursor could corrupt an accepted snapshot.
				console.error("[bulk-send] recipient enqueue completed", {
					operation: "bulk_recipient_enqueue",
					mailboxId: job.fromEmail,
					operationId: job.operationId,
					jobId: job.id,
					cursor: job.cursor,
					result: "commit_state_unknown",
					target: "outbound_delivery_store",
					errorName:
						reconciliationError instanceof Error
							? reconciliationError.name
							: "UnknownError",
					retryDecision: "retry_alarm",
					durationMs: Date.now() - recipientStartedAt,
				});
				throw e;
			}
			const reconciliation = planBulkEnqueueReconciliation(
				authoritative,
				messageId,
			);
			const disposition = planBulkRecipientEnqueueDisposition(
				reconciliation.status,
				e,
			);
			if (disposition === "retry") {
				console.error("[bulk-send] recipient enqueue completed", {
					operation: "bulk_recipient_enqueue",
					mailboxId: job.fromEmail,
					operationId: job.operationId,
					jobId: job.id,
					cursor: job.cursor,
					result: "transient_failure",
					target: "outbound_delivery_store",
					errorName: e instanceof Error ? e.name : "UnknownError",
					retryDecision: "retry_alarm",
					durationMs: Date.now() - recipientStartedAt,
				});
				throw e;
			}
			if (preparation) {
				const activePreparation = preparation;
				this.ctx.storage.transactionSync(() =>
					this.#finishBulkRecipientPreparationSync(
						activePreparation,
						disposition === "committed"
							? (authoritative?.emailId ?? null)
							: null,
					),
				);
			}
			if (disposition === "committed") {
				job.enqueued += 1;
				console.info("[bulk-send] recipient enqueue completed", {
					operation: "bulk_recipient_enqueue",
					mailboxId: job.fromEmail,
					operationId: job.operationId,
					jobId: job.id,
					cursor: job.cursor,
					result: "recovered_commit",
					target: "outbound_delivery_store",
					retryDecision: "continue",
					durationMs: Date.now() - recipientStartedAt,
				});
				await this.#ensureOutboundAlarm();
			} else {
				job.failed += 1;
				job.errors.push({ email: to, error: "Recipient could not be queued." });
				console.error("[bulk-send] recipient enqueue completed", {
					operation: "bulk_recipient_enqueue",
					mailboxId: job.fromEmail,
					operationId: job.operationId,
					jobId: job.id,
					cursor: job.cursor,
					result: "failed",
					target: "outbound_delivery_store",
					errorName: e instanceof Error ? e.name : "UnknownError",
					retryDecision: "terminal_for_recipient",
					durationMs: Date.now() - recipientStartedAt,
				});
			}
		}

		job.cursor += 1;
		job.updatedAt = Date.now();
		job.nextEnqueueAt = nextBulkEnqueueAt(job.updatedAt, Math.random());
		if (job.cursor >= rows.length) {
			job.status = "done";
			const remainingJobs = this.#commitBulkTerminalSync(jobId, job);
			console.info("[bulk-send] job reached terminal state", {
				operation: "bulk_job_terminal",
				mailboxId: job.fromEmail,
				actorUserId: job.actorUserId,
				operationId: job.operationId,
				jobId,
				status: job.status,
				result: "completed",
				terminalReason: "all_recipients_processed",
				total: job.total,
				cursor: job.cursor,
				enqueued: job.enqueued,
				failed: job.failed,
				remainingJobs,
				retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
				durationMs: Date.now() - job.createdAt,
			});
			await this.#ensureBulkMaintenanceAlarmForJob({
				startedAt: alarmNow,
				jobId,
				job,
			});
			if (remainingJobs > 0) {
				await this.#scheduleBulkAlarmAt(Date.now() + 100, {
					stage: "next_job_schedule",
					startedAt: alarmNow,
					jobId,
					job,
				});
			}
			return;
		}
		try {
			await this.ctx.storage.put(`bulk:job:${jobId}`, job);
		} catch (error) {
			console.error("[bulk-send] alarm pass failed", {
				operation: "bulk_alarm_pass",
				stage: "progress_persist",
				mailboxId: job.fromEmail,
				operationId: job.operationId,
				jobId,
				result: "failure",
				errorName: error instanceof Error ? error.name : "UnknownError",
				retryDecision: "retry_alarm",
				durationMs: Date.now() - alarmNow,
			});
			throw error;
		}
		await this.#scheduleBulkAlarmAt(job.nextEnqueueAt, {
			stage: "next_job_schedule",
			startedAt: alarmNow,
			jobId,
			job,
		});
		}

	// ── Deterministic inbound Automation Rules ─────────────────────

	#automationTargetSets() {
		return {
			labels: new Set(
				[
					...this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM labels"),
				].map((row) => row.id),
			),
			folders: new Set(
				[
					...this.ctx.storage.sql.exec<{ id: string }>(
					`SELECT id FROM folders
					 WHERE id = ? OR (is_deletable = 1 AND id <> ?)`,
					Folders.ARCHIVE,
					InternalFolders.RETIRED_OUTBOUND,
					),
				].map((row) => row.id),
			),
		};
	}

	#automationRuleHistory() {
		return new Map(
			[
				...this.ctx.storage.sql.exec<{
				ruleId: string;
				lastRunAt: string;
				lastMatchedAt: string | null;
			}>(
				`SELECT rule_id AS ruleId, MAX(created_at) AS lastRunAt,
				        MAX(CASE WHEN outcome NOT IN ('not_matched', 'stopped')
				                 THEN created_at ELSE NULL END) AS lastMatchedAt
				 FROM automation_run_results GROUP BY rule_id`,
				),
			].map((row) => [row.ruleId, row]),
		);
	}

	#automationTargetUsage(target: { labelId?: string; folderId?: string }) {
		const current = this.#automationRules().rulesUsingTarget(target);
		const referenceTable = target.labelId
			? "automation_run_label_refs"
			: "automation_run_folder_refs";
		const referenceColumn = target.labelId ? "label_id" : "folder_id";
		const targetId = target.labelId ?? target.folderId;
		if (!targetId)
			throw new AutomationRuleError(
				"INVALID",
				"Automation Rule target is invalid",
			);
		const pending = [
			...this.ctx.storage.sql.exec<{ id: string; name: string }>(
			`SELECT DISTINCT rr.rule_id AS id, rr.rule_name AS name
			 FROM ${referenceTable} ref
			 JOIN automation_runs run ON run.id = ref.run_id
			 JOIN automation_run_rules rr ON rr.run_id = run.id
			 WHERE ref.${referenceColumn} = ? AND run.state IN ('pending', 'processing')
			 ORDER BY rr.ordinal ASC, rr.rule_id ASC LIMIT 20`,
			targetId,
			),
		];
		return [
			...new Set([...current, ...pending].map((rule) => rule.name)),
		].slice(0, 5);
	}

	#assertAutomationTargetUnused(target: {
		labelId?: string;
		folderId?: string;
	}) {
		const names = this.#automationTargetUsage(target);
		if (names.length > 0) {
			throw new AutomationRuleError(
				"RULE_TARGET_IN_USE",
				`Target is used by Automation ${names.length === 1 ? "Rule" : "Rules"}: ${names.join(", ")}`,
			);
		}
	}

	#automationRuleView(
		rule: AutomationRuleRecord,
		versions: AutomationRuleVersionRecord[],
		targets = this.#automationTargetSets(),
		history = this.#automationRuleHistory(),
	) {
		const active =
			versions.find((version) => version.version === rule.activeVersion) ??
			null;
		const draft =
			versions.find((version) => version.version === rule.draftVersion) ?? null;
		let targetHealth: "ready" | "needs_attention" = "ready";
		for (const version of [active, draft]) {
			if (!version) continue;
			for (const action of version.definition.actions) {
				if (
					action.kind === "apply_labels" &&
					action.labelIds.some((labelId) => !targets.labels.has(labelId))
				)
					targetHealth = "needs_attention";
				if (
					action.kind === "move_to_folder" &&
					!targets.folders.has(action.folderId)
				)
					targetHealth = "needs_attention";
			}
		}
		return {
			id: rule.id,
			name: rule.name,
			state:
				targetHealth === "needs_attention" && rule.state !== "archived"
				? ("needs_attention" as const)
				: rule.state,
			position: rule.position,
			revision: rule.revision,
			activeVersion: rule.activeVersion,
			draftVersion: rule.draftVersion,
			activeDefinition: active?.definition ?? null,
			draftDefinition: draft?.definition ?? null,
			createdBy: rule.createdBy,
			createdAt: rule.createdAt,
			updatedBy: rule.updatedBy,
			updatedAt: rule.updatedAt,
			archivedBy: rule.archivedBy,
			archivedAt: rule.archivedAt,
			targetHealth,
			lastRunAt: history.get(rule.id)?.lastRunAt ?? null,
			lastMatchedAt: history.get(rule.id)?.lastMatchedAt ?? null,
		};
	}

	async listAutomationRules(includeArchived = true) {
		const automation = this.#automationRules();
		const targets = this.#automationTargetSets();
		const history = this.#automationRuleHistory();
		const rules = automation.listRules(includeArchived).map((rule) => {
			try {
				return this.#automationRuleView(
					rule,
					automation.listVersions(rule.id),
					targets,
					history,
				);
			} catch {
				return {
					...this.#automationRuleView(rule, [], targets, history),
					state:
						rule.state === "archived"
							? rule.state
							: ("needs_attention" as const),
					targetHealth: "needs_attention" as const,
				};
			}
		});
		return { rules, ...automation.state() };
	}

	async getAutomationRule(ruleId: string) {
		const automation = this.#automationRules();
		const rule = automation
			.listRules(true)
			.find((candidate) => candidate.id === ruleId);
		if (!rule) return null;
		const versions = automation.listVersions(ruleId);
		return {
			rule: this.#automationRuleView(rule, versions),
			versions: versions.map((version) => ({
				...version,
				isActive: version.version === rule.activeVersion,
				isDraft: version.version === rule.draftVersion,
			})),
		};
	}

	async #automationMutationResult(rule: AutomationRuleRecord) {
		const automation = this.#automationRules();
		return {
			rule: this.#automationRuleView(rule, automation.listVersions(rule.id)),
			...automation.state(),
		};
	}

	async createAutomationRuleDraft(input: {
		definition: unknown;
		actorId: string;
		expectedOrderRevision: number;
	}) {
		const rule = await this.#automationRules().createDraft(input);
		return this.#automationMutationResult(rule);
	}

	async updateAutomationRuleDraft(input: {
		ruleId: string;
		definition: unknown;
		actorId: string;
		expectedRevision: number;
	}) {
		const rule = await this.#automationRules().updateDraft(input);
		return this.#automationMutationResult(rule);
	}

	async setAutomationRuleEnabled(input: {
		ruleId: string;
		enabled: boolean;
		actorId: string;
		expectedRevision: number;
	}) {
		const automation = this.#automationRules();
		const rule = input.enabled
			? (() => {
					const current = automation
						.listRules(true)
						.find((item) => item.id === input.ruleId);
					if (!current)
						throw new AutomationRuleError(
							"NOT_FOUND",
							"Automation Rule was not found",
						);
				return current.draftVersion === null
					? automation.setEnabled(input)
					: automation.enable(input);
			})()
			: automation.setEnabled(input);
		return this.#automationMutationResult(rule);
	}

	async archiveAutomationRule(input: {
		ruleId: string;
		actorId: string;
		expectedRevision: number;
	}) {
		return this.#automationMutationResult(
			this.#automationRules().archive(input),
		);
	}

	async reorderAutomationRules(input: {
		orderedRuleIds: string[];
		expectedOrderRevision: number;
		actorId: string;
	}) {
		this.#automationRules().reorder(input);
		return this.listAutomationRules(true);
	}

	async restoreAutomationRuleVersion(input: {
		ruleId: string;
		version: number;
		actorId: string;
		expectedRevision: number;
	}) {
		const rule = await this.#automationRules().restoreVersion(input);
		return this.#automationMutationResult(rule);
	}

	async dryRunAutomationRule(input: {
		definition: unknown;
		actorId: string;
		ruleId: string;
		ruleVersion: number;
		acknowledgedZero: boolean;
	}) {
		const automation = this.#automationRules();
		const currentRules = automation.listRules(false);
		const requestedRule = currentRules.find((rule) => rule.id === input.ruleId);
		if (!requestedRule) {
			throw new AutomationRuleError(
				"NOT_FOUND",
				"Automation Rule was not found",
			);
		}
		if (
			requestedRule &&
			(input.ruleVersion !== requestedRule.draftVersion ||
				requestedRule.draftVersion === null)
		) {
			throw new AutomationRuleError(
				"CONFLICT",
				"Automation Rule draft changed; refresh and try again",
			);
		}
		const enabled = currentRules.filter(
			(rule) => rule.state === "enabled" && rule.activeVersion !== null,
		);
		const orderedRules = enabled.map((rule, ordinal) => {
			const version = automation
				.listVersions(rule.id)
				.find((candidate) => candidate.version === rule.activeVersion);
			if (!version) {
				throw new AutomationRuleError(
					"INVALID",
					"An active Automation Rule version is unavailable",
				);
			}
			return {
				ordinal,
				ruleId: rule.id,
				ruleName: rule.name,
				version: version.version,
				definition: version.definition,
				definitionFingerprint: version.definitionFingerprint,
			};
		});
		const proposedOrdinal = enabled.filter(
			(rule) =>
				rule.id !== requestedRule.id &&
				rule.position < requestedRule.position,
		).length;
		return this.#automationTestView(
			await automation.dryRun({
			...input,
				contexts: readAutomationDryRunContexts(
					this.ctx.storage.sql,
					Date.now(),
				),
			orderedRules,
			proposedOrdinal,
			}),
		);
	}

	async automationRulesUsingTarget(target: {
		labelId?: string;
		folderId?: string;
	}) {
		return this.#automationRules().rulesUsingTarget(target);
	}

	async getAutomationTargetUsage(target: {
		labelId?: string;
		folderId?: string;
	}) {
		return this.#automationTargetUsage(target);
	}

	#automationMessageView(messageId: string) {
		if (!messageId || messageId.length > 300) return null;
		const row = [
			...this.ctx.storage.sql.exec<{
			emailId: string;
			folderId: string;
			threadId: string | null;
			sender: string | null;
			subject: string | null;
			date: string | null;
		}>(
			`SELECT id AS emailId, folder_id AS folderId, thread_id AS threadId,
			        sender, subject, date
			 FROM emails WHERE id = ? AND folder_id <> ? LIMIT 1`,
			messageId,
			InternalFolders.RETIRED_OUTBOUND,
			),
		][0];
		if (!row || !row.date || !Number.isFinite(Date.parse(row.date)))
			return null;
		return {
			emailId: row.emailId,
			folderId: row.folderId,
			conversationId: row.threadId ?? row.emailId,
			sender: (row.sender ?? "").slice(0, 320),
			subject: (row.subject ?? "").slice(0, 998),
			date: new Date(row.date).toISOString(),
		};
	}

	#automationRunView(run: AutomationRunRecord, includeResults = false) {
		return {
			...run,
			message: this.#automationMessageView(run.triggerMessageId),
			results: includeResults
				? this.#automationRules().listRunResults(run.id)
				: undefined,
		};
	}

	async listAutomationRuns(input: {
		state: string | null;
		beforeCreatedAt: string | null;
		beforeId: string | null;
		limit: number;
	}) {
		const beforeTime =
			input.beforeCreatedAt === null ? null : Date.parse(input.beforeCreatedAt);
		if (
			(input.state !== null &&
				!AUTOMATION_RUN_STATES.includes(
				input.state as (typeof AUTOMATION_RUN_STATES)[number],
			)) ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100 ||
			(input.beforeCreatedAt === null) !== (input.beforeId === null) ||
			(input.beforeCreatedAt !== null &&
				(!Number.isFinite(beforeTime) ||
					new Date(beforeTime!).toISOString() !== input.beforeCreatedAt)) ||
			(input.beforeId !== null &&
				(!input.beforeId || input.beforeId.length > 300))
		)
			throw new AutomationRuleError(
				"INVALID",
				"Automation Run query is invalid",
			);
		const rows = [
			...this.ctx.storage.sql.exec<AutomationRunRecord>(
			`SELECT id, trigger_message_id AS triggerMessageId,
			        ruleset_generation AS rulesetGeneration, state,
			        attempt_count AS attemptCount, started_at AS startedAt,
			        completed_at AS completedAt, evaluated_count AS evaluatedCount,
			        matched_count AS matchedCount, applied_count AS appliedCount,
			        stopped_by_rule_id AS stoppedByRuleId,
			        failure_category AS failureCategory,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM automation_runs
			 WHERE (? IS NULL OR state = ?)
			   AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			input.state,
			input.state,
			input.beforeCreatedAt,
			input.beforeCreatedAt,
			input.beforeCreatedAt,
			input.beforeId,
			input.limit + 1,
			),
		];
		const page = rows.slice(0, input.limit);
		const last = rows.length > input.limit ? (page.at(-1) ?? null) : null;
		return {
			runs: page.map((run) => this.#automationRunView(run)),
			next: last ? { createdAt: last.createdAt, id: last.id } : null,
		};
	}

	async getAutomationRun(runId: string) {
		try {
			return this.#automationRunView(
				this.#automationRules().getRun(runId),
				true,
			);
		} catch (error) {
			if (error instanceof AutomationRuleError && error.code === "NOT_FOUND")
				return null;
			throw error;
		}
	}

	#automationTestView(test: AutomationDryRunRecord) {
		return {
			...test,
			result: {
				...test.result,
				samples: test.result.samples.map((sample) => ({
					...sample,
					location: this.#automationMessageView(sample.messageId),
				})),
			},
		};
	}

	async listAutomationRuleTests(input: {
		ruleId: string | null;
		beforeCreatedAt: string | null;
		beforeId: string | null;
		limit: number;
	}) {
		const beforeTime =
			input.beforeCreatedAt === null ? null : Date.parse(input.beforeCreatedAt);
		if (
			(input.ruleId !== null && (!input.ruleId || input.ruleId.length > 300)) ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100 ||
			(input.beforeCreatedAt === null) !== (input.beforeId === null) ||
			(input.beforeCreatedAt !== null &&
				(!Number.isFinite(beforeTime) ||
					new Date(beforeTime!).toISOString() !== input.beforeCreatedAt)) ||
			(input.beforeId !== null &&
				(!input.beforeId || input.beforeId.length > 300))
		)
			throw new AutomationRuleError(
				"INVALID",
				"Automation Rule test query is invalid",
			);
		const rows = [
			...this.ctx.storage.sql.exec<{
			id: string;
			createdAt: string;
		}>(
			`SELECT id, created_at AS createdAt FROM automation_rule_tests
			 WHERE (? IS NULL OR rule_id = ?)
			   AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			input.ruleId,
			input.ruleId,
			input.beforeCreatedAt,
			input.beforeCreatedAt,
			input.beforeCreatedAt,
			input.beforeId,
			input.limit + 1,
			),
		];
		const page = rows.slice(0, input.limit);
		const automation = this.#automationRules();
		const tests = page.map((row) => automation.getTest(row.id));
		const last = rows.length > input.limit ? (page.at(-1) ?? null) : null;
		return {
			tests: tests.map((test) => this.#automationTestView(test)),
			next: last ? { createdAt: last.createdAt, id: last.id } : null,
		};
	}

	// ── Push subscriptions (WISER-240) ─────────────────────────────
	// Per-device capabilities for this mailbox. Live inbound writes snapshot their
	// opaque IDs into the durable outbox; alarm dispatch rechecks actor access and
	// the current capability generation before using any endpoint or key material.

	async upsertPushSubscription(input: {
		userId: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		deviceLabel: string;
	}): Promise<{ id: string; deviceLabel: string; generation: number }> {
		// Re-subscribing the same device yields the same endpoint, but every
		// accepted rebind advances its capability generation so an older in-flight
		// provider response can never act on the rebound record. Health is retained
		// only when the actor and key material are unchanged.
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, device_label)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(endpoint) DO UPDATE SET
				   user_id = excluded.user_id,
				   p256dh = excluded.p256dh,
				   auth = excluded.auth,
				   generation = push_subscriptions.generation + 1,
				   last_push_attempt_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_attempt_at END,
				   last_push_accepted_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_accepted_at END,
				   last_push_failure_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_failure_at END,
				   last_push_failure_reason = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_failure_reason END,
				   consecutive_push_failures = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN 0 ELSE push_subscriptions.consecutive_push_failures END,
				   last_seen_at = datetime('now')`,
			id,
			input.userId,
			input.endpoint,
			input.p256dh,
			input.auth,
			input.userAgent,
			input.deviceLabel,
		);
		const [row] = this.ctx.storage.sql.exec<{
			id: string;
			device_label: string;
			generation: number;
		}>(
			`SELECT id, device_label, generation FROM push_subscriptions WHERE endpoint = ?`,
			input.endpoint,
		);
		if (!row) throw new Error("Push subscription was not stored");
		await this.ensurePushAlarm();
		return {
			id: row.id,
			deviceLabel: row.device_label,
			generation: row.generation,
		};
	}

	async deletePushSubscription(
		id: string,
		userId: string,
		expectedGeneration?: number,
	): Promise<boolean> {
		const generationClause =
			expectedGeneration === undefined ? "" : " AND generation = ?";
		const bindings =
			expectedGeneration === undefined
			? [id, userId]
			: [id, userId, expectedGeneration];
		const existing = [
			...this.ctx.storage.sql.exec(
				`SELECT id FROM push_subscriptions WHERE id = ? AND user_id = ?${generationClause}`,
				...bindings,
			),
		];
		if (existing.length === 0) return false;
		this.ctx.storage.sql.exec(
			`DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?${generationClause}`,
			...bindings,
		);
		return true;
	}

	async removePushSubscriptionsForUser(userId: string): Promise<void> {
		this.ctx.storage.sql.exec(
			`DELETE FROM push_subscriptions WHERE user_id = ?`,
			userId,
		);
	}

	async ensurePushAlarm(): Promise<void> {
		const row = [
			...this.ctx.storage.sql.exec<{ due_at: string | null }>(
			`SELECT MIN(due_at) AS due_at FROM (
			 SELECT next_attempt_at AS due_at FROM automation_runs
			 WHERE state = 'pending' AND next_attempt_at IS NOT NULL
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM automation_runs
			 WHERE state = 'processing' AND lease_expires_at IS NOT NULL
			 UNION ALL
			 SELECT next_attempt_at AS due_at FROM push_notification_deliveries
			 WHERE status IN ('pending', 'retrying')
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM push_notification_deliveries
			 WHERE status = 'sending' AND lease_expires_at IS NOT NULL
			 UNION ALL
			 SELECT strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(completed_at, created_at), '+7 days') AS due_at
			 FROM push_notifications
			 WHERE state IN ('completed', 'no_targets', 'expired')
			)`,
			),
		][0];
		if (row?.due_at) await this.#scheduleAlarmAt(Date.parse(row.due_at));
	}

	async getPushHealth(userId: string) {
		await this.ensurePushAlarm();
		return readPushHealth(this.ctx.storage.sql, {
			userId,
			configured: vapidConfig(this.env) !== null,
			now: new Date().toISOString(),
		});
	}
}
