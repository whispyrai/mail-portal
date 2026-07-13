import { Folders, InternalFolders } from "../../shared/folders.ts";
import { truncateSemanticSearchText } from "../../shared/semantic-search.ts";
import {
  SEMANTIC_MESSAGE_CHUNK_VERSION,
  SEMANTIC_MESSAGE_POLICY_VERSION,
  semanticMessageChunks,
  semanticMessageEligible,
  semanticSourceFingerprint,
  semanticVectorId,
	type SemanticMessageSource,
} from "./semantic-search.ts";
import {
	SEMANTIC_ATTACHMENT_CHUNK_VERSION,
	SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
	SEMANTIC_ATTACHMENT_LIMITS,
	SEMANTIC_ATTACHMENT_POLICY_VERSION,
	semanticAttachmentChunks,
	semanticAttachmentVectorId,
	semanticDirectTextFormat,
} from "./semantic-attachment.ts";

const BACKFILL_BATCH = 20;
const REPLAY_BATCH = 100;
const JOB_BATCH = 20;
const MAX_JOB_ATTEMPTS = 5;
const SUBMITTED_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1_000;
const VISIBILITY_POLL_MS = 30_000;

type SqlValue = ArrayBuffer | string | number | null;
type SqlRow = Record<string, SqlValue>;

export type SemanticIndexStore = {
  sql: {
    exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): Iterable<T>;
  };
  transactionSync<T>(operation: () => T): T;
};

export type SemanticIndexReadiness = {
  state: "building" | "complete" | "unavailable";
  processedMessages: number;
  pendingJobs: number;
  submittedJobs: number;
  sourceCurrentThrough: number;
  currentSequence: number;
};

export type SemanticIndexJob = {
  vectorId: string;
  operation: "upsert" | "delete";
  content: string | null;
  leaseToken: string;
  attemptCount: number;
};

export type SemanticSubmittedJob = {
  vectorId: string;
  operation: "upsert" | "delete";
  submittedAt: number;
};

export type SemanticVisibilityObservation = {
  vectorId: string;
  visible: boolean;
};

type SemanticResolvedCandidateBase = {
	vectorId: string;
	messageId: string;
	score: number;
  subject: string;
  sender: string;
  recipient: string;
  date: string;
	folderId: string;
	excerpt: string;
};

export type SemanticResolvedCandidate = SemanticResolvedCandidateBase & (
	| { source: "message" }
	| {
		source: "attachment";
		attachmentId: string;
		attachmentFilename: string;
		attachmentStorageFilename: string;
		sourceFingerprint: string;
		r2Version: string;
		r2Etag: string;
		actualSize: number;
	}
);

export type SemanticAttachmentExtractionLease = {
	attachmentId: string;
	messageId: string;
	attachmentVersion: number;
	filename: string;
	mimetype: string;
	declaredSize: number;
	leaseToken: string;
	attemptCount: number;
};

export type SemanticAttachmentExtractionCompletion = {
	attachmentId: string;
	messageId: string;
	attachmentVersion: number;
	leaseToken: string;
	completedAt: number;
	byteSha256: string;
	sourceFingerprint: string;
	r2Version: string;
	r2Etag: string;
	actualSize: number;
	text: string;
};

function first<T extends SqlRow>(rows: Iterable<T>): T | null {
  return [...rows][0] ?? null;
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function operation(row: SqlRow): "upsert" | "delete" {
  return text(row, "operation") === "delete" ? "delete" : "upsert";
}

function currentSequence(store: SemanticIndexStore): number {
  return integer(
    first(
      store.sql.exec<SqlRow>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mailbox_changes",
      ),
    ) ?? {},
    "sequence",
  );
}

function semanticMessageVersion(
  store: SemanticIndexStore,
  messageId: string,
): number {
  return integer(
    first(
      store.sql.exec<SqlRow>(
        `SELECT version FROM semantic_message_versions WHERE message_id = ?1 LIMIT 1`,
        messageId,
      ),
    ) ?? {},
    "version",
  );
}

type SemanticAttachmentRow = {
	attachmentId: string;
	messageId: string;
	attachmentVersion: number;
	filename: string;
	mimetype: string;
	declaredSize: number;
	contentId: string;
	disposition: string;
	folderId: string;
};

function attachmentRow(
	store: SemanticIndexStore,
	attachmentId: string,
): SemanticAttachmentRow | null {
	const row = first(
		store.sql.exec<SqlRow>(
			`SELECT a.id AS attachmentId, a.email_id AS messageId,
				v.version AS attachmentVersion, a.filename, a.mimetype,
				a.size AS declaredSize, COALESCE(a.content_id, '') AS contentId,
				COALESCE(a.disposition, '') AS disposition, e.folder_id AS folderId
			 FROM attachments a
			 JOIN emails e ON e.id = a.email_id
			 JOIN semantic_attachment_versions v ON v.attachment_id = a.id
			 WHERE a.id = ?1 LIMIT 1`,
			attachmentId,
		),
	);
	if (!row) return null;
	const rawDeclaredSize = row.declaredSize;
	return {
		attachmentId: text(row, "attachmentId"),
		messageId: text(row, "messageId"),
		attachmentVersion: integer(row, "attachmentVersion"),
		filename: text(row, "filename"),
		mimetype: text(row, "mimetype"),
		declaredSize:
			typeof rawDeclaredSize === "number" && Number.isSafeInteger(rawDeclaredSize)
				? rawDeclaredSize
				: -1,
		contentId: text(row, "contentId"),
		disposition: text(row, "disposition").toLowerCase(),
		folderId: text(row, "folderId"),
	};
}

function attachmentEligible(row: SemanticAttachmentRow): boolean {
	return semanticMessageEligible(row.folderId) &&
		row.disposition !== "inline" &&
		!row.contentId;
}

function sourceRow(
  store: SemanticIndexStore,
  messageId: string,
): SemanticMessageSource | null {
  const row = first(
    store.sql.exec<SqlRow>(
      `SELECT id, folder_id AS folderId, COALESCE(subject, '') AS subject,
			COALESCE(sender, '') AS sender, COALESCE(recipient, '') AS recipient,
			COALESCE(cc, '') AS cc, COALESCE(bcc, '') AS bcc,
			COALESCE(date, '') AS date, SUBSTR(COALESCE(body, ''), 1, 96000) AS body
		 FROM emails WHERE id = ?1 LIMIT 1`,
      messageId,
    ),
  );
  if (!row) return null;
  return {
    id: text(row, "id"),
    folderId: text(row, "folderId"),
    subject: text(row, "subject"),
    sender: text(row, "sender"),
    recipient: text(row, "recipient"),
    cc: text(row, "cc"),
    bcc: text(row, "bcc"),
    date: text(row, "date"),
    body: text(row, "body"),
    semanticVersion: semanticMessageVersion(store, messageId),
  };
}

function ensureState(store: SemanticIndexStore, now: string): SqlRow {
  let existing = first(
    store.sql.exec<SqlRow>(
      "SELECT * FROM semantic_projection_state WHERE id = 1 LIMIT 1",
    ),
  );
	if (
		existing &&
		(integer(existing, "schema_version") !== 2 ||
      integer(existing, "policy_version") !== SEMANTIC_MESSAGE_POLICY_VERSION ||
      integer(existing, "chunk_version") !== SEMANTIC_MESSAGE_CHUNK_VERSION)
  ) {
		store.transactionSync(() => {
			store.sql.exec("DELETE FROM semantic_sources");
			store.sql.exec("DELETE FROM semantic_attachment_extractions");
      store.sql.exec("DELETE FROM semantic_projection_state WHERE id = 1");
    });
		existing = null;
	}
	if (
		existing &&
		(integer(existing, "attachment_extraction_version") !== SEMANTIC_ATTACHMENT_EXTRACTION_VERSION ||
			integer(existing, "attachment_policy_version") !== SEMANTIC_ATTACHMENT_POLICY_VERSION ||
			integer(existing, "attachment_chunk_version") !== SEMANTIC_ATTACHMENT_CHUNK_VERSION)
	) {
		store.transactionSync(() => {
			store.sql.exec("DELETE FROM semantic_sources WHERE source_type = 'attachment'");
			store.sql.exec("DELETE FROM semantic_attachment_extractions");
			store.sql.exec(
				`UPDATE semantic_projection_state SET attachment_status = 'building',
				 attachment_extraction_version = ?1,
				 attachment_policy_version = ?2, attachment_chunk_version = ?3,
				 attachment_backfill_date = NULL, attachment_backfill_message_id = NULL,
				 attachment_backfill_id = NULL, processed_attachments = 0,
				 attachment_last_error_code = NULL WHERE id = 1`,
				SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
				SEMANTIC_ATTACHMENT_POLICY_VERSION,
				SEMANTIC_ATTACHMENT_CHUNK_VERSION,
			);
		});
		existing = first(
			store.sql.exec<SqlRow>(
				"SELECT * FROM semantic_projection_state WHERE id = 1 LIMIT 1",
			),
		);
	}
  if (existing) return existing;
  const sequence = currentSequence(store);
  store.sql.exec(
    `INSERT INTO semantic_projection_state(
			id, schema_version, policy_version, chunk_version, status,
			baseline_change_sequence, applied_change_sequence, backfill_date,
			backfill_message_id, processed_messages, started_at, completed_at,
			last_error_code,
			attachment_status, attachment_backfill_date,
			attachment_extraction_version, attachment_policy_version,
			attachment_chunk_version,
			attachment_backfill_message_id, attachment_backfill_id,
			processed_attachments, attachment_last_error_code
		) VALUES (
			1, 2, ?1, ?2, 'building', ?3, ?3, NULL, NULL, 0, ?4, NULL, NULL,
			'building', NULL, ?5, ?6, ?7, NULL, NULL, 0, NULL
		)`,
    SEMANTIC_MESSAGE_POLICY_VERSION,
    SEMANTIC_MESSAGE_CHUNK_VERSION,
		sequence,
		now,
		SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
		SEMANTIC_ATTACHMENT_POLICY_VERSION,
		SEMANTIC_ATTACHMENT_CHUNK_VERSION,
  );
  return first(
    store.sql.exec<SqlRow>(
      "SELECT * FROM semantic_projection_state WHERE id = 1 LIMIT 1",
    ),
  )!;
}

function freshSourceToken(createId: () => string): string {
  const value = createId().replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(
      "Semantic source identity generator returned an invalid token",
    );
  }
  return value;
}

export function createSemanticIndex(input: {
  store: SemanticIndexStore;
  now?: () => string;
  createId?: () => string;
}) {
  const { store } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.createId ?? (() => crypto.randomUUID());

	const projectMessage = async (messageId: string): Promise<boolean> => {
		const source = sourceRow(store, messageId);
		if (!source || !semanticMessageEligible(source.folderId)) {
			store.transactionSync(() => {
				store.sql.exec(
					"DELETE FROM semantic_sources WHERE message_id = ?1",
					messageId,
				);
				store.sql.exec(
					"DELETE FROM semantic_attachment_extractions WHERE message_id = ?1",
					messageId,
				);
      });
      return false;
    }
    const fingerprint = await semanticSourceFingerprint(source);
    const chunks = semanticMessageChunks(source);
    const sourceToken = freshSourceToken(createId);
    const createdAt = now();
    return store.transactionSync(() => {
      const current = sourceRow(store, messageId);
      if (
        !current ||
        !semanticMessageEligible(current.folderId) ||
        current.semanticVersion !== source.semanticVersion
      )
        return false;
      const existing = first(
        store.sql.exec<SqlRow>(
				 `SELECT source_fingerprint AS fingerprint FROM semantic_sources
					 WHERE source_type = 'message' AND message_id = ?1 LIMIT 1`,
          messageId,
        ),
      );
      if (existing && text(existing, "fingerprint") === fingerprint)
        return true;
      store.sql.exec(
			"DELETE FROM semantic_sources WHERE source_type = 'message' AND message_id = ?1",
        messageId,
      );
      if (chunks.length === 0) return false;
      store.sql.exec(
			`INSERT INTO semantic_sources(
					source_id, source_type, message_id, attachment_id,
					attachment_filename, extraction_version, source_fingerprint,
					source_sequence, folder_id, created_at, updated_at
				) VALUES (?1, 'message', ?2, NULL, NULL, 0, ?3, ?4, ?5, ?6, ?6)`,
        sourceToken,
        messageId,
        fingerprint,
        source.semanticVersion,
        source.folderId,
        createdAt,
      );
      for (const chunk of chunks) {
        store.sql.exec(
				`INSERT INTO semantic_chunks(
						vector_id, source_id, source_type, message_id, attachment_id,
						source_fingerprint, ordinal, content, excerpt, created_at
					) VALUES (?1, ?2, 'message', ?3, NULL, ?4, ?5, ?6, ?7, ?8)`,
          semanticVectorId(sourceToken, chunk.ordinal),
          sourceToken,
          messageId,
          fingerprint,
          chunk.ordinal,
				chunk.embeddingText,
				chunk.excerpt,
				createdAt,
        );
      }
      return true;
    });
	};

	const projectAttachment = (attachmentId: string): boolean => {
		const attachment = attachmentRow(store, attachmentId);
		if (!attachment || !attachmentEligible(attachment)) {
			store.transactionSync(() => {
				store.sql.exec(
					"DELETE FROM semantic_sources WHERE source_type = 'attachment' AND attachment_id = ?1",
					attachmentId,
				);
				store.sql.exec(
					"DELETE FROM semantic_attachment_extractions WHERE attachment_id = ?1",
					attachmentId,
				);
			});
			return false;
		}
		const format = semanticDirectTextFormat(attachment.filename, attachment.mimetype);
		const declaredSizeValid = Number.isSafeInteger(attachment.declaredSize) &&
			attachment.declaredSize >= 0;
		const supported = format !== null &&
			declaredSizeValid &&
			attachment.declaredSize <= SEMANTIC_ATTACHMENT_LIMITS.inputBytes;
		const declaredSize = declaredSizeValid ? attachment.declaredSize : 0;
		const unsupportedError = format === null
			? "unsupported_format"
			: !declaredSizeValid
				? "invalid_size"
				: "size_exceeded";
		const updatedAt = now();
		return store.transactionSync(() => {
			const current = attachmentRow(store, attachmentId);
			if (
				!current ||
				!attachmentEligible(current) ||
				current.messageId !== attachment.messageId ||
				current.attachmentVersion !== attachment.attachmentVersion
			) {
				return false;
			}
			const existing = first(
				store.sql.exec<SqlRow>(
					`SELECT attachment_version AS attachmentVersion, state
					 FROM semantic_attachment_extractions
					 WHERE attachment_id = ?1 LIMIT 1`,
					attachmentId,
				),
			);
			if (
				existing &&
				integer(existing, "attachmentVersion") === attachment.attachmentVersion &&
				(text(existing, "state") === "ready" ||
					text(existing, "state") === "pending" ||
					text(existing, "state") === "processing" ||
					text(existing, "state") === "failed" ||
					text(existing, "state") === "unsupported")
			) {
				return text(existing, "state") !== "unsupported";
			}
			store.sql.exec(
				"DELETE FROM semantic_sources WHERE source_type = 'attachment' AND attachment_id = ?1",
				attachmentId,
			);
			store.sql.exec(
				`INSERT INTO semantic_attachment_extractions(
					attachment_id, message_id, attachment_version, filename, mimetype,
					declared_size, content_id, disposition, state, attempt_count,
					next_attempt_at, lease_token, lease_expires_at, byte_sha256,
					r2_version, r2_etag, actual_size, last_error_code,
					created_at, updated_at
				) VALUES (
					?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0,
					0, NULL, NULL, NULL, NULL, NULL, NULL, ?10, ?11, ?11
				)
				ON CONFLICT(attachment_id) DO UPDATE SET
					message_id = excluded.message_id,
					attachment_version = excluded.attachment_version,
					filename = excluded.filename, mimetype = excluded.mimetype,
					declared_size = excluded.declared_size,
					content_id = excluded.content_id, disposition = excluded.disposition,
					state = excluded.state, attempt_count = 0, next_attempt_at = 0,
					lease_token = NULL, lease_expires_at = NULL, byte_sha256 = NULL,
					r2_version = NULL, r2_etag = NULL, actual_size = NULL,
					last_error_code = excluded.last_error_code,
					updated_at = excluded.updated_at`,
				attachment.attachmentId,
				attachment.messageId,
				attachment.attachmentVersion,
				attachment.filename,
				attachment.mimetype,
				declaredSize,
				attachment.contentId || null,
				attachment.disposition || null,
				supported ? "pending" : "unsupported",
				supported ? null : unsupportedError,
				updatedAt,
			);
			return supported;
		});
	};

	const projectAttachmentsForMessage = (messageId: string): void => {
		const attachmentIds = store.sql.exec<SqlRow>(
			"SELECT id FROM attachments WHERE email_id = ?1 ORDER BY id ASC",
			messageId,
		);
		for (const row of attachmentIds) projectAttachment(text(row, "id"));
	};

	const backfill = async (state: SqlRow): Promise<boolean> => {
    const cursorDate = text(state, "backfill_date") || null;
    const cursorId = text(state, "backfill_message_id") || null;
    const rows = [
      ...store.sql.exec<SqlRow>(
        `SELECT id, COALESCE(date, '') AS date FROM emails
			 WHERE folder_id NOT IN (?1, ?2, ?3, ?4, ?5)
			   AND (?6 IS NULL OR COALESCE(date, '') < ?6 OR (COALESCE(date, '') = ?6 AND id > ?7))
			 ORDER BY COALESCE(date, '') DESC, id ASC
			 LIMIT ?8`,
        Folders.DRAFT,
        Folders.OUTBOX,
        Folders.TRASH,
        Folders.SPAM,
        InternalFolders.RETIRED_OUTBOUND,
        cursorDate,
        cursorId,
        BACKFILL_BATCH + 1,
      ),
    ];
    const page = rows.slice(0, BACKFILL_BATCH);
    for (const row of page) await projectMessage(text(row, "id"));
    const last = page.at(-1);
    store.transactionSync(() => {
      if (last) {
        store.sql.exec(
          `UPDATE semantic_projection_state SET
					 backfill_date = ?1, backfill_message_id = ?2,
					 processed_messages = processed_messages + ?3
					 WHERE id = 1`,
          text(last, "date"),
          text(last, "id"),
          page.length,
        );
      }
    });
		return rows.length <= BACKFILL_BATCH;
	};

	const backfillAttachments = (state: SqlRow): boolean => {
		const cursorDate = text(state, "attachment_backfill_date") || null;
		const cursorMessageId = text(state, "attachment_backfill_message_id") || null;
		const cursorAttachmentId = text(state, "attachment_backfill_id") || null;
		const rows = [
			...store.sql.exec<SqlRow>(
				`SELECT a.id, a.email_id AS messageId, COALESCE(e.date, '') AS date
				 FROM attachments a
				 JOIN emails e ON e.id = a.email_id
				 WHERE e.folder_id NOT IN (?1, ?2, ?3, ?4, ?5)
				   AND (
					 ?6 IS NULL OR COALESCE(e.date, '') < ?6
					 OR (COALESCE(e.date, '') = ?6 AND a.email_id > ?7)
					 OR (COALESCE(e.date, '') = ?6 AND a.email_id = ?7 AND a.id > ?8)
				   )
				 ORDER BY COALESCE(e.date, '') DESC, a.email_id ASC, a.id ASC
				 LIMIT ?9`,
				Folders.DRAFT,
				Folders.OUTBOX,
				Folders.TRASH,
				Folders.SPAM,
				InternalFolders.RETIRED_OUTBOUND,
				cursorDate,
				cursorMessageId,
				cursorAttachmentId,
				BACKFILL_BATCH + 1,
			),
		];
		const page = rows.slice(0, BACKFILL_BATCH);
		for (const row of page) projectAttachment(text(row, "id"));
		const last = page.at(-1);
		store.transactionSync(() => {
			if (last) {
				store.sql.exec(
					`UPDATE semantic_projection_state SET
					 attachment_backfill_date = ?1,
					 attachment_backfill_message_id = ?2,
					 attachment_backfill_id = ?3,
					 processed_attachments = processed_attachments + ?4
					 WHERE id = 1`,
					text(last, "date"),
					text(last, "messageId"),
					text(last, "id"),
					page.length,
				);
			}
			if (rows.length <= BACKFILL_BATCH) {
				store.sql.exec(
					"UPDATE semantic_projection_state SET attachment_status = 'ready' WHERE id = 1",
				);
			}
		});
		return rows.length <= BACKFILL_BATCH;
	};

  const replay = async (): Promise<boolean> => {
    const state = ensureState(store, now());
    const applied = integer(state, "applied_change_sequence");
    const changes = [
      ...store.sql.exec<SqlRow>(
		`SELECT sequence, resource, entity_id AS entityId, parent_id AS parentId FROM mailbox_changes
			 WHERE sequence > ?1 ORDER BY sequence ASC LIMIT ?2`,
        applied,
        REPLAY_BATCH + 1,
      ),
    ];
    const page = changes.slice(0, REPLAY_BATCH);
    const messageIds = [
      ...new Set(
        page
          .filter((row) => text(row, "resource") === "message")
          .map((row) => text(row, "entityId")),
      ),
    ];
		for (const messageId of messageIds) {
			await projectMessage(messageId);
			projectAttachmentsForMessage(messageId);
		}
		const attachmentIds = [
			...new Set(
				page
					.filter((row) => text(row, "resource") === "attachment")
					.map((row) => text(row, "entityId")),
			),
		];
		for (const attachmentId of attachmentIds) projectAttachment(attachmentId);
    const lastSequence = page.length
      ? integer(page.at(-1)!, "sequence")
      : applied;
    store.transactionSync(() => {
      store.sql.exec(
        "UPDATE semantic_projection_state SET applied_change_sequence = ?1 WHERE id = 1",
        lastSequence,
      );
    });
    return (
      changes.length <= REPLAY_BATCH && lastSequence >= currentSequence(store)
    );
  };

  const readiness = (): SemanticIndexReadiness => {
    const state = first(
      store.sql.exec<SqlRow>(
        "SELECT * FROM semantic_projection_state WHERE id = 1 LIMIT 1",
      ),
    );
    if (!state) {
      return {
        state: "building",
        processedMessages: 0,
        pendingJobs: 0,
        submittedJobs: 0,
        sourceCurrentThrough: 0,
        currentSequence: currentSequence(store),
      };
    }
		const counts =
      first(
        store.sql.exec<SqlRow>(
          `SELECT
				SUM(CASE WHEN state IN ('pending', 'processing', 'failed') THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN state = 'submitted' THEN 1 ELSE 0 END) AS submitted
			 FROM semantic_index_jobs`,
        ),
			) ?? {};
		const attachmentCounts =
			first(
				store.sql.exec<SqlRow>(
					`SELECT
					 SUM(CASE WHEN state IN ('pending', 'processing')
						OR (state = 'failed' AND attempt_count < ?1) THEN 1 ELSE 0 END) AS pending,
					 SUM(CASE WHEN state = 'failed' AND attempt_count >= ?1 THEN 1 ELSE 0 END) AS terminal
					 FROM semantic_attachment_extractions`,
					MAX_JOB_ATTEMPTS,
				),
			) ?? {};
		const projectionStatus = text(state, "status");
		const attachmentStatus = text(state, "attachment_status");
    const current = currentSequence(store);
    const applied = integer(state, "applied_change_sequence");
    const pendingJobs = integer(counts, "pending");
		const submittedJobs = integer(counts, "submitted");
		const pendingAttachments = integer(attachmentCounts, "pending");
		const terminalAttachments = integer(attachmentCounts, "terminal");
		return {
			state:
				projectionStatus === "failed" ||
				attachmentStatus === "failed" ||
				terminalAttachments > 0
					? "unavailable"
					: projectionStatus === "ready" &&
							attachmentStatus === "ready" &&
							applied >= current &&
							pendingJobs === 0 &&
							submittedJobs === 0 &&
							pendingAttachments === 0
            ? "complete"
            : "building",
      processedMessages: integer(state, "processed_messages"),
      pendingJobs,
      submittedJobs,
      sourceCurrentThrough: applied,
      currentSequence: current,
    };
  };

	const prepare = async (): Promise<SemanticIndexReadiness> => {
		let state = ensureState(store, now());
    if (text(state, "status") === "building") {
      const backfillComplete = await backfill(state);
			if (!backfillComplete) return readiness();
      const replayComplete = await replay();
      if (!replayComplete) return readiness();
      store.transactionSync(() => {
        store.sql.exec(
          `UPDATE semantic_projection_state SET status = 'ready', completed_at = ?1,
					 last_error_code = NULL WHERE id = 1`,
          now(),
        );
      });
			state = ensureState(store, now());
		}
		if (text(state, "status") === "failed") return readiness();
		if (text(state, "status") === "ready") await replay();
		state = ensureState(store, now());
		if (text(state, "attachment_status") === "building") {
			backfillAttachments(state);
		}
		return readiness();
	};

  const nextAdvanceAt = (nowMs: number): number | null => {
		const state = first(
			store.sql.exec<SqlRow>(
				`SELECT status, attachment_status AS attachmentStatus,
				 applied_change_sequence AS applied
				 FROM semantic_projection_state WHERE id = 1 LIMIT 1`,
			),
		);
		if (!state || text(state, "status") === "building") return nowMs;
		if (text(state, "attachmentStatus") === "building") return nowMs;
    if (
      text(state, "status") === "ready" &&
      integer(state, "applied") < currentSequence(store)
    )
      return nowMs;
    const due = first(
      store.sql.exec<SqlRow>(
        `SELECT MIN(due_at) AS dueAt FROM (
				SELECT next_attempt_at AS due_at FROM semantic_index_jobs
				WHERE state IN ('pending', 'failed') AND attempt_count < ?1
				UNION ALL
				SELECT lease_expires_at AS due_at FROM semantic_index_jobs
				WHERE state = 'processing' AND lease_expires_at IS NOT NULL
				UNION ALL
				SELECT next_attempt_at AS due_at FROM semantic_index_jobs
				WHERE state = 'submitted'
				UNION ALL
				SELECT next_attempt_at AS due_at FROM semantic_attachment_extractions
				WHERE state IN ('pending', 'failed') AND attempt_count < ?1
				UNION ALL
				SELECT lease_expires_at AS due_at FROM semantic_attachment_extractions
				WHERE state = 'processing' AND lease_expires_at IS NOT NULL
			)`,
        MAX_JOB_ATTEMPTS,
      ),
    );
    const dueAt = due?.dueAt;
    return typeof dueAt === "number" && Number.isSafeInteger(dueAt)
      ? dueAt
      : null;
  };

  const failProjection = (errorCode: string): void => {
    store.sql.exec(
      `UPDATE semantic_projection_state SET status = 'failed', last_error_code = ?1
			 WHERE id = 1`,
      errorCode.slice(0, 64),
    );
  };

	const rebuild = (): void => {
		store.transactionSync(() => {
			store.sql.exec("DELETE FROM semantic_sources");
			store.sql.exec("DELETE FROM semantic_attachment_extractions");
			store.sql.exec("DELETE FROM semantic_projection_state WHERE id = 1");
		});
	};

  const leaseJobs = (
    leaseToken: string,
    nowMs: number,
    leaseMs: number,
    limit = JOB_BATCH,
  ): SemanticIndexJob[] =>
    store.transactionSync(() => {
      const visibilityCutoff = nowMs - SUBMITTED_VISIBILITY_TIMEOUT_MS;
      store.sql.exec(
        `UPDATE semantic_projection_state SET status = 'failed',
			 last_error_code = 'visibility_unconfirmed'
			 WHERE id = 1 AND EXISTS (
				 SELECT 1 FROM semantic_index_jobs
				 WHERE state = 'submitted' AND submitted_at <= ?1
				   AND attempt_count >= ?2
			 )`,
        visibilityCutoff,
        MAX_JOB_ATTEMPTS,
      );
      store.sql.exec(
        `UPDATE semantic_index_jobs SET state = 'failed', mutation_id = NULL,
			 submitted_at = NULL, next_attempt_at = ?1,
			 last_error_code = 'visibility_unconfirmed', updated_at = ?2
			 WHERE state = 'submitted' AND submitted_at <= ?3
			   AND attempt_count >= ?4`,
        nowMs,
        now(),
        visibilityCutoff,
        MAX_JOB_ATTEMPTS,
      );
      store.sql.exec(
        `UPDATE semantic_index_jobs SET state = 'pending', mutation_id = NULL,
			 submitted_at = NULL, next_attempt_at = ?1, updated_at = ?2
			 WHERE state = 'submitted' AND submitted_at <= ?3
			   AND attempt_count < ?4`,
        nowMs,
        now(),
        visibilityCutoff,
        MAX_JOB_ATTEMPTS,
      );
      store.sql.exec(
        `UPDATE semantic_index_jobs SET state = 'pending', lease_token = NULL,
			 lease_expires_at = NULL, updated_at = ?1
			 WHERE state = 'processing' AND lease_expires_at <= ?2`,
        now(),
        nowMs,
      );
      const rows = [
        ...store.sql.exec<SqlRow>(
          `SELECT vector_id AS vectorId, operation, attempt_count AS attemptCount
			 FROM semantic_index_jobs
			 WHERE state IN ('pending', 'failed') AND next_attempt_at <= ?1
			   AND attempt_count < ?3
			 ORDER BY next_attempt_at ASC, vector_id ASC LIMIT ?2`,
          nowMs,
          Math.min(Math.max(Math.trunc(limit), 1), JOB_BATCH),
          MAX_JOB_ATTEMPTS,
        ),
      ];
      for (const row of rows) {
        store.sql.exec(
          `UPDATE semantic_index_jobs SET state = 'processing', lease_token = ?1,
				 lease_expires_at = ?2, attempt_count = attempt_count + 1, updated_at = ?3
				 WHERE vector_id = ?4`,
          leaseToken,
          nowMs + leaseMs,
          now(),
          text(row, "vectorId"),
        );
      }
      return rows
        .map((row) => {
          const vectorId = text(row, "vectorId");
          const jobOperation = operation(row);
          const chunk =
            jobOperation === "upsert"
              ? first(
                  store.sql.exec<SqlRow>(
                    "SELECT content FROM semantic_chunks WHERE vector_id = ?1 LIMIT 1",
                    vectorId,
                  ),
                )
              : null;
          return {
            vectorId,
            operation: jobOperation,
            content: chunk ? text(chunk, "content") : null,
            leaseToken,
            attemptCount: integer(row, "attemptCount") + 1,
          };
        })
        .filter((job) => job.operation === "delete" || job.content !== null);
    });

  const submitJobs = (
    jobs: ReadonlyArray<{ vectorId: string; leaseToken: string }>,
    mutationId: string,
    submittedAt: number,
  ): string[] =>
    store.transactionSync(() => {
      const accepted: string[] = [];
      for (const job of jobs.slice(0, JOB_BATCH)) {
        const current = first(
          store.sql.exec<SqlRow>(
            `SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
				 FROM semantic_index_jobs WHERE state = 'processing' AND vector_id = ?1`,
            job.vectorId,
          ),
        );
        if (
          !current ||
          text(current, "leaseToken") !== job.leaseToken ||
          integer(current, "leaseExpiresAt") <= submittedAt
        )
          continue;
        store.sql.exec(
          `UPDATE semantic_index_jobs SET state = 'submitted', mutation_id = ?1,
				 submitted_at = ?2, lease_token = NULL, lease_expires_at = NULL,
				 next_attempt_at = ?3, last_error_code = NULL, updated_at = ?4
				 WHERE vector_id = ?5`,
          mutationId,
          submittedAt,
          submittedAt + VISIBILITY_POLL_MS,
          now(),
          job.vectorId,
        );
        accepted.push(job.vectorId);
      }
      return accepted;
    });

  const retryJobs = (
    jobs: ReadonlyArray<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      errorCode: string;
      failedAt: number;
    }>,
  ): string[] =>
    store.transactionSync(() => {
      const accepted: string[] = [];
      for (const job of jobs.slice(0, JOB_BATCH)) {
        const current = first(
          store.sql.exec<SqlRow>(
            `SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
				 attempt_count AS attemptCount FROM semantic_index_jobs
				 WHERE state = 'processing' AND vector_id = ?1`,
            job.vectorId,
          ),
        );
        if (
          !current ||
          text(current, "leaseToken") !== job.leaseToken ||
          integer(current, "leaseExpiresAt") <= job.failedAt
        )
          continue;
        const exhausted = integer(current, "attemptCount") >= MAX_JOB_ATTEMPTS;
        store.sql.exec(
          `UPDATE semantic_index_jobs SET state = 'failed', next_attempt_at = ?1,
				 lease_token = NULL, lease_expires_at = NULL, submitted_at = NULL,
				 last_error_code = ?2, updated_at = ?3 WHERE vector_id = ?4`,
          job.nextAttemptAt,
          job.errorCode.slice(0, 64),
          now(),
          job.vectorId,
        );
        if (exhausted) {
          store.sql.exec(
            `UPDATE semantic_projection_state SET status = 'failed',
					 last_error_code = ?1 WHERE id = 1`,
            job.errorCode.slice(0, 64),
          );
        }
        accepted.push(job.vectorId);
      }
      return accepted;
    });

  const deferJobs = (
    jobs: ReadonlyArray<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      reasonCode: string;
      deferredAt: number;
    }>,
  ): string[] =>
    store.transactionSync(() => {
      const accepted: string[] = [];
      for (const job of jobs.slice(0, JOB_BATCH)) {
        const current = first(
          store.sql.exec<SqlRow>(
            `SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
				 FROM semantic_index_jobs WHERE state = 'processing' AND vector_id = ?1`,
            job.vectorId,
          ),
        );
        if (
          !current ||
          text(current, "leaseToken") !== job.leaseToken ||
          integer(current, "leaseExpiresAt") <= job.deferredAt
        )
          continue;
        store.sql.exec(
          `UPDATE semantic_index_jobs SET state = 'pending',
				 attempt_count = MAX(attempt_count - 1, 0), next_attempt_at = ?1,
				 lease_token = NULL, lease_expires_at = NULL, submitted_at = NULL,
				 last_error_code = ?2, updated_at = ?3 WHERE vector_id = ?4`,
          job.nextAttemptAt,
          job.reasonCode.slice(0, 64),
          now(),
          job.vectorId,
        );
        accepted.push(job.vectorId);
      }
      return accepted;
    });

  const confirmVisibility = (
    observations: readonly SemanticVisibilityObservation[],
    observedAt: number,
  ): void => {
    store.transactionSync(() => {
      for (const observation of observations.slice(0, 100)) {
        const job = first(
          store.sql.exec<SqlRow>(
            `SELECT vector_id AS vectorId, operation, submitted_at AS submittedAt
					 FROM semantic_index_jobs
					 WHERE state = 'submitted' AND vector_id = ?1 LIMIT 1`,
            observation.vectorId,
          ),
        );
        if (!job) continue;
        if (
          (operation(job) === "upsert" && observation.visible) ||
          (operation(job) === "delete" &&
            !observation.visible &&
            observedAt - integer(job, "submittedAt") >=
              SUBMITTED_VISIBILITY_TIMEOUT_MS)
        ) {
          store.sql.exec(
            "DELETE FROM semantic_index_jobs WHERE state = 'submitted' AND vector_id = ?1",
            observation.vectorId,
          );
        }
      }
    });
  };

  const submittedJobs = (limit = JOB_BATCH): SemanticSubmittedJob[] => {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return [
      ...store.sql.exec<SqlRow>(
        `SELECT vector_id AS vectorId, operation, submitted_at AS submittedAt
			 FROM semantic_index_jobs WHERE state = 'submitted'
			 ORDER BY updated_at ASC, vector_id ASC LIMIT ?1`,
        boundedLimit,
      ),
    ].map((row) => ({
      vectorId: text(row, "vectorId"),
      operation: operation(row),
      submittedAt: integer(row, "submittedAt"),
    }));
  };

	const dueSubmittedJobs = (
    observedAt: number,
    limit = JOB_BATCH,
  ): SemanticSubmittedJob[] =>
    store.transactionSync(() => {
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const rows = [
        ...store.sql.exec<SqlRow>(
          `SELECT vector_id AS vectorId, operation, submitted_at AS submittedAt
			 FROM semantic_index_jobs
			 WHERE state = 'submitted' AND next_attempt_at <= ?1
			 ORDER BY next_attempt_at ASC, vector_id ASC LIMIT ?2`,
          observedAt,
          boundedLimit,
        ),
      ];
      for (const row of rows) {
        const submittedAt = integer(row, "submittedAt");
        store.sql.exec(
          `UPDATE semantic_index_jobs SET next_attempt_at = ?1, updated_at = ?2
				 WHERE state = 'submitted' AND vector_id = ?3`,
          Math.min(
            observedAt + VISIBILITY_POLL_MS,
            submittedAt + SUBMITTED_VISIBILITY_TIMEOUT_MS,
          ),
          now(),
          text(row, "vectorId"),
        );
      }
      return rows.map((row) => ({
        vectorId: text(row, "vectorId"),
        operation: operation(row),
        submittedAt: integer(row, "submittedAt"),
      }));
		});

	const leaseAttachmentExtraction = (
		leaseToken: string,
		nowMs: number,
		leaseMs: number,
	): SemanticAttachmentExtractionLease | null =>
		store.transactionSync(() => {
			store.sql.exec(
				`UPDATE semantic_attachment_extractions SET
				 state = 'failed', next_attempt_at = ?1, lease_token = NULL,
				 lease_expires_at = NULL, last_error_code = 'lease_expired', updated_at = ?2
				 WHERE state = 'processing' AND lease_expires_at <= ?1`,
				nowMs,
				now(),
			);
			const row = first(
				store.sql.exec<SqlRow>(
					`SELECT attachment_id AS attachmentId, message_id AS messageId,
					 attachment_version AS attachmentVersion, filename, mimetype,
					 declared_size AS declaredSize, attempt_count AS attemptCount
					 FROM semantic_attachment_extractions
					 WHERE state IN ('pending', 'failed') AND next_attempt_at <= ?1
					   AND attempt_count < ?2
					 ORDER BY next_attempt_at ASC, attachment_id ASC LIMIT 1`,
					nowMs,
					MAX_JOB_ATTEMPTS,
				),
			);
			if (!row) return null;
			const attachmentId = text(row, "attachmentId");
			store.sql.exec(
				`UPDATE semantic_attachment_extractions SET state = 'processing',
				 lease_token = ?1, lease_expires_at = ?2,
				 attempt_count = attempt_count + 1, updated_at = ?3
				 WHERE attachment_id = ?4`,
				leaseToken,
				nowMs + leaseMs,
				now(),
				attachmentId,
			);
			return {
				attachmentId,
				messageId: text(row, "messageId"),
				attachmentVersion: integer(row, "attachmentVersion"),
				filename: text(row, "filename"),
				mimetype: text(row, "mimetype"),
				declaredSize: integer(row, "declaredSize"),
				leaseToken,
				attemptCount: integer(row, "attemptCount") + 1,
			};
		});

	const completeAttachmentExtraction = (
		completion: SemanticAttachmentExtractionCompletion,
	): boolean => {
		if (
			!/^([a-f0-9]{64})$/.test(completion.byteSha256) ||
			!/^([a-f0-9]{64})$/.test(completion.sourceFingerprint) ||
			!completion.r2Version ||
			!completion.r2Etag ||
			completion.actualSize < 0 ||
			completion.actualSize > SEMANTIC_ATTACHMENT_LIMITS.inputBytes
		) return false;
		const chunks = semanticAttachmentChunks("", completion.text);
		if (chunks.length === 0) return false;
		const sourceToken = freshSourceToken(createId);
		const createdAt = now();
		return store.transactionSync(() => {
			const current = first(
				store.sql.exec<SqlRow>(
					`SELECT x.lease_token AS leaseToken,
					 x.lease_expires_at AS leaseExpiresAt,
					 x.attachment_version AS attachmentVersion,
					 x.filename, x.mimetype, x.declared_size AS declaredSize,
					 a.email_id AS messageId, e.folder_id AS folderId,
					 COALESCE(a.content_id, '') AS contentId,
					 COALESCE(a.disposition, '') AS disposition,
					 v.version AS currentVersion
					 FROM semantic_attachment_extractions x
					 JOIN attachments a ON a.id = x.attachment_id
					 JOIN emails e ON e.id = a.email_id
					 JOIN semantic_attachment_versions v ON v.attachment_id = a.id
					 WHERE x.state = 'processing' AND x.attachment_id = ?1 LIMIT 1`,
					completion.attachmentId,
				),
			);
			if (
				!current ||
				text(current, "leaseToken") !== completion.leaseToken ||
				integer(current, "leaseExpiresAt") <= completion.completedAt ||
				text(current, "messageId") !== completion.messageId ||
				integer(current, "attachmentVersion") !== completion.attachmentVersion ||
				integer(current, "currentVersion") !== completion.attachmentVersion ||
				integer(current, "declaredSize") !== completion.actualSize ||
				!semanticMessageEligible(text(current, "folderId")) ||
				text(current, "disposition").toLowerCase() === "inline" ||
				Boolean(text(current, "contentId"))
			) {
				return false;
			}
			store.sql.exec(
				"DELETE FROM semantic_sources WHERE source_type = 'attachment' AND attachment_id = ?1",
				completion.attachmentId,
			);
			store.sql.exec(
				`INSERT INTO semantic_sources(
				 source_id, source_type, message_id, attachment_id,
				 attachment_filename, extraction_version,
				 attachment_policy_version, attachment_chunk_version, source_fingerprint,
				 source_sequence, folder_id, created_at, updated_at
				) VALUES (?1, 'attachment', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
				sourceToken,
				completion.messageId,
				completion.attachmentId,
				text(current, "filename"),
				SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
				SEMANTIC_ATTACHMENT_POLICY_VERSION,
				SEMANTIC_ATTACHMENT_CHUNK_VERSION,
				completion.sourceFingerprint,
				completion.attachmentVersion,
				text(current, "folderId"),
				createdAt,
			);
			const attachmentChunks = semanticAttachmentChunks(
				text(current, "filename"),
				completion.text,
			);
			for (const chunk of attachmentChunks) {
				store.sql.exec(
					`INSERT INTO semantic_chunks(
					 vector_id, source_id, source_type, message_id, attachment_id,
					 source_fingerprint, ordinal, content, excerpt, created_at
					) VALUES (?1, ?2, 'attachment', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
					semanticAttachmentVectorId(sourceToken, chunk.ordinal),
					sourceToken,
					completion.messageId,
					completion.attachmentId,
					completion.sourceFingerprint,
					chunk.ordinal,
					chunk.embeddingText,
					chunk.excerpt,
					createdAt,
				);
			}
			store.sql.exec(
				`UPDATE semantic_attachment_extractions SET state = 'ready',
				 lease_token = NULL, lease_expires_at = NULL, next_attempt_at = 0,
				 byte_sha256 = ?1, r2_version = ?2, r2_etag = ?3, actual_size = ?4,
				 last_error_code = NULL, updated_at = ?5 WHERE attachment_id = ?6`,
				completion.byteSha256,
				completion.r2Version,
				completion.r2Etag,
				completion.actualSize,
				createdAt,
				completion.attachmentId,
			);
			return true;
		});
	};

	const rejectAttachmentExtraction = (input: {
		attachmentId: string;
		leaseToken: string;
		rejectedAt: number;
		errorCode: string;
		terminal: boolean;
	}): boolean => store.transactionSync(() => {
		const row = first(store.sql.exec<SqlRow>(
			`SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
			 FROM semantic_attachment_extractions
			 WHERE state = 'processing' AND attachment_id = ?1 LIMIT 1`,
			input.attachmentId,
		));
		if (!row || text(row, "leaseToken") !== input.leaseToken ||
			integer(row, "leaseExpiresAt") <= input.rejectedAt) return false;
		store.sql.exec(
			`UPDATE semantic_attachment_extractions SET state = ?1,
			 attempt_count = CASE WHEN ?2 = 1 THEN ?3 ELSE attempt_count END,
			 lease_token = NULL, lease_expires_at = NULL, next_attempt_at = 0,
			 last_error_code = ?4, updated_at = ?5 WHERE attachment_id = ?6`,
			input.terminal ? "failed" : "unsupported",
			input.terminal ? 1 : 0,
			MAX_JOB_ATTEMPTS,
			input.errorCode.slice(0, 64),
			now(),
			input.attachmentId,
		);
		return true;
	});

	const retryAttachmentExtraction = (input: {
		attachmentId: string;
		leaseToken: string;
		failedAt: number;
		nextAttemptAt: number;
		errorCode: string;
	}): boolean => store.transactionSync(() => {
		const row = first(store.sql.exec<SqlRow>(
			`SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
			 FROM semantic_attachment_extractions
			 WHERE state = 'processing' AND attachment_id = ?1 LIMIT 1`,
			input.attachmentId,
		));
		if (!row || text(row, "leaseToken") !== input.leaseToken ||
			integer(row, "leaseExpiresAt") <= input.failedAt) return false;
		store.sql.exec(
			`UPDATE semantic_attachment_extractions SET state = 'failed',
			 lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?1,
			 last_error_code = ?2, updated_at = ?3 WHERE attachment_id = ?4`,
			input.nextAttemptAt,
			input.errorCode.slice(0, 64),
			now(),
			input.attachmentId,
		);
		return true;
	});

	const invalidateAttachmentAuthority = (input: {
		vectorId: string;
		attachmentId: string;
		sourceFingerprint: string;
		r2Version: string;
		r2Etag: string;
		actualSize: number;
		errorCode: string;
	}): boolean => store.transactionSync(() => {
		const row = first(store.sql.exec<SqlRow>(
			`SELECT s.source_id AS sourceId
			 FROM semantic_chunks c
			 JOIN semantic_sources s ON s.source_id = c.source_id
			 JOIN semantic_attachment_extractions x ON x.attachment_id = s.attachment_id
			 WHERE c.vector_id = ?1 AND s.source_type = 'attachment'
			   AND s.attachment_id = ?2 AND s.source_fingerprint = ?3
			   AND x.state = 'ready' AND x.r2_version = ?4 AND x.r2_etag = ?5
			   AND x.actual_size = ?6 LIMIT 1`,
			input.vectorId,
			input.attachmentId,
			input.sourceFingerprint,
			input.r2Version,
			input.r2Etag,
			input.actualSize,
		));
		if (!row) return false;
		store.sql.exec("DELETE FROM semantic_sources WHERE source_id = ?1", text(row, "sourceId"));
		store.sql.exec(
			`UPDATE semantic_attachment_extractions SET state = 'pending',
			 attempt_count = 0, next_attempt_at = 0, lease_token = NULL,
			 lease_expires_at = NULL, byte_sha256 = NULL, r2_version = NULL,
			 r2_etag = NULL, actual_size = NULL, last_error_code = ?1,
			 updated_at = ?2 WHERE attachment_id = ?3`,
			input.errorCode.slice(0, 64),
			now(),
			input.attachmentId,
		);
		return true;
	});

	const resolveCandidates = (
    candidates: ReadonlyArray<{ vectorId: string; score: number }>,
  ): SemanticResolvedCandidate[] => {
		const bestBySource = new Map<string, SemanticResolvedCandidate>();
    for (const candidate of candidates.slice(0, 50)) {
      if (!candidate.vectorId || !Number.isFinite(candidate.score)) continue;
      const row = first(
        store.sql.exec<SqlRow>(
			`SELECT c.vector_id AS vectorId, c.source_type AS sourceType,
					c.message_id AS messageId, c.attachment_id AS attachmentId,
					c.source_fingerprint AS chunkFingerprint, c.excerpt,
					s.source_fingerprint AS sourceFingerprint,
					s.source_sequence AS sourceSequence,
					s.attachment_filename AS attachmentFilename,
					s.extraction_version AS extractionVersion,
					s.attachment_policy_version AS attachmentPolicyVersion,
					s.attachment_chunk_version AS attachmentChunkVersion,
					x.state AS extractionState,
				x.byte_sha256 AS byteSha256, x.r2_version AS r2Version,
				x.r2_etag AS r2Etag, x.actual_size AS actualSize,
				x.attachment_version AS extractionSequence,
					v.version AS attachmentVersion, a.email_id AS attachmentMessageId,
					a.filename AS attachmentStorageFilename,
					COALESCE(e.subject, '') AS subject, COALESCE(e.sender, '') AS sender,
					COALESCE(e.recipient, '') AS recipient, COALESCE(e.date, '') AS date,
					e.folder_id AS folderId
				 FROM semantic_chunks c
				 JOIN semantic_sources s ON s.source_id = c.source_id
				 JOIN emails e ON e.id = c.message_id
				 LEFT JOIN attachments a ON a.id = c.attachment_id
				 LEFT JOIN semantic_attachment_versions v ON v.attachment_id = c.attachment_id
				 LEFT JOIN semantic_attachment_extractions x ON x.attachment_id = c.attachment_id
				 WHERE c.vector_id = ?1 LIMIT 1`,
          candidate.vectorId,
        ),
      );
      if (!row || !semanticMessageEligible(text(row, "folderId"))) continue;
      if (text(row, "chunkFingerprint") !== text(row, "sourceFingerprint"))
        continue;
		const messageId = text(row, "messageId");
		const source = text(row, "sourceType") === "attachment" ? "attachment" : "message";
		const attachmentId = text(row, "attachmentId");
		const attachmentStorageFilename = text(row, "attachmentStorageFilename");
		const attachmentSourceFilename = text(row, "attachmentFilename");
		if (source === "message") {
			if (semanticMessageVersion(store, messageId) !== integer(row, "sourceSequence")) {
				continue;
			}
		} else if (
			!attachmentId ||
			!attachmentStorageFilename.trim() ||
			attachmentSourceFilename !== attachmentStorageFilename ||
			text(row, "attachmentMessageId") !== messageId ||
			text(row, "extractionState") !== "ready" ||
			integer(row, "sourceSequence") !== integer(row, "attachmentVersion") ||
			integer(row, "sourceSequence") !== integer(row, "extractionSequence") ||
			integer(row, "extractionVersion") !== SEMANTIC_ATTACHMENT_EXTRACTION_VERSION ||
			integer(row, "attachmentPolicyVersion") !== SEMANTIC_ATTACHMENT_POLICY_VERSION ||
			integer(row, "attachmentChunkVersion") !== SEMANTIC_ATTACHMENT_CHUNK_VERSION ||
			!text(row, "byteSha256") ||
			!text(row, "r2Version") ||
			!text(row, "r2Etag")
		) {
			continue;
		}
		const common: SemanticResolvedCandidateBase = {
			vectorId: text(row, "vectorId"),
			messageId,
        score: Math.min(Math.max(candidate.score, 0), 1),
			subject: truncateSemanticSearchText(text(row, "subject"), 500),
			sender: truncateSemanticSearchText(text(row, "sender"), 320),
			recipient: truncateSemanticSearchText(text(row, "recipient"), 320),
			date: truncateSemanticSearchText(text(row, "date"), 64),
			folderId: truncateSemanticSearchText(text(row, "folderId"), 200),
			excerpt: truncateSemanticSearchText(text(row, "excerpt"), 600),
		};
		const resolved: SemanticResolvedCandidate = source === "attachment"
			? {
				...common,
				source,
				attachmentId,
				attachmentFilename: truncateSemanticSearchText(
					attachmentStorageFilename,
					SEMANTIC_ATTACHMENT_LIMITS.filenameChars,
				),
				attachmentStorageFilename,
				sourceFingerprint: text(row, "sourceFingerprint"),
				r2Version: text(row, "r2Version"),
				r2Etag: text(row, "r2Etag"),
				actualSize: integer(row, "actualSize"),
			}
			: { ...common, source };
		const identity = source === "message" ? `message\u0000${messageId}` :
			`attachment\u0000${messageId}\u0000${attachmentId}`;
		const existing = bestBySource.get(identity);
		if (!existing || resolved.score > existing.score)
			bestBySource.set(identity, resolved);
	}
	return [...bestBySource.values()].sort(
      (left, right) =>
        right.score - left.score ||
        right.date.localeCompare(left.date) ||
        left.messageId.localeCompare(right.messageId),
    );
  };

  return {
    prepare,
    readiness,
    nextAdvanceAt,
    failProjection,
    rebuild,
		projectMessage,
		projectAttachment,
		leaseAttachmentExtraction,
		completeAttachmentExtraction,
		rejectAttachmentExtraction,
		retryAttachmentExtraction,
		invalidateAttachmentAuthority,
    leaseJobs,
    submitJobs,
    retryJobs,
    deferJobs,
    submittedJobs,
    dueSubmittedJobs,
    confirmVisibility,
    resolveCandidates,
  };
}
