import { Folders, InternalFolders } from "../../shared/folders.ts";
import {
  SEMANTIC_MESSAGE_CHUNK_VERSION,
  SEMANTIC_MESSAGE_POLICY_VERSION,
  semanticMessageChunks,
  semanticMessageEligible,
  semanticSourceFingerprint,
  semanticVectorId,
  type SemanticMessageSource,
} from "./semantic-search.ts";

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

export type SemanticResolvedCandidate = {
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
    (integer(existing, "schema_version") !== 1 ||
      integer(existing, "policy_version") !== SEMANTIC_MESSAGE_POLICY_VERSION ||
      integer(existing, "chunk_version") !== SEMANTIC_MESSAGE_CHUNK_VERSION)
  ) {
    store.transactionSync(() => {
      store.sql.exec("DELETE FROM semantic_sources");
      store.sql.exec("DELETE FROM semantic_projection_state WHERE id = 1");
    });
    existing = null;
  }
  if (existing) return existing;
  const sequence = currentSequence(store);
  store.sql.exec(
    `INSERT INTO semantic_projection_state(
			id, schema_version, policy_version, chunk_version, status,
			baseline_change_sequence, applied_change_sequence, backfill_date,
			backfill_message_id, processed_messages, started_at, completed_at,
			last_error_code
		) VALUES (1, 1, ?1, ?2, 'building', ?3, ?3, NULL, NULL, 0, ?4, NULL, NULL)`,
    SEMANTIC_MESSAGE_POLICY_VERSION,
    SEMANTIC_MESSAGE_CHUNK_VERSION,
    sequence,
    now,
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
				 WHERE message_id = ?1 LIMIT 1`,
          messageId,
        ),
      );
      if (existing && text(existing, "fingerprint") === fingerprint)
        return true;
      store.sql.exec(
        "DELETE FROM semantic_sources WHERE message_id = ?1",
        messageId,
      );
      if (chunks.length === 0) return false;
      store.sql.exec(
        `INSERT INTO semantic_sources(
					source_id, message_id, source_fingerprint, source_sequence,
					folder_id, created_at, updated_at
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
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
						vector_id, source_id, message_id, source_fingerprint,
						ordinal, content, created_at
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          semanticVectorId(sourceToken, chunk.ordinal),
          sourceToken,
          messageId,
          fingerprint,
          chunk.ordinal,
          chunk.embeddingText,
          createdAt,
        );
      }
      return true;
    });
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

  const replay = async (): Promise<boolean> => {
    const state = ensureState(store, now());
    const applied = integer(state, "applied_change_sequence");
    const changes = [
      ...store.sql.exec<SqlRow>(
        `SELECT sequence, resource, entity_id AS entityId FROM mailbox_changes
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
    for (const messageId of messageIds) await projectMessage(messageId);
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
    const projectionStatus = text(state, "status");
    const current = currentSequence(store);
    const applied = integer(state, "applied_change_sequence");
    const pendingJobs = integer(counts, "pending");
    const submittedJobs = integer(counts, "submitted");
    return {
      state:
        projectionStatus === "failed"
          ? "unavailable"
          : projectionStatus === "ready" &&
              applied >= current &&
              pendingJobs === 0 &&
              submittedJobs === 0
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
      return readiness();
    }
    if (text(state, "status") === "failed") return readiness();
    await replay();
    return readiness();
  };

  const nextAdvanceAt = (nowMs: number): number | null => {
    const state = first(
      store.sql.exec<SqlRow>(
        "SELECT status, applied_change_sequence AS applied FROM semantic_projection_state WHERE id = 1 LIMIT 1",
      ),
    );
    if (!state || text(state, "status") === "building") return nowMs;
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

  const resolveCandidates = (
    candidates: ReadonlyArray<{ vectorId: string; score: number }>,
  ): SemanticResolvedCandidate[] => {
    const bestByMessage = new Map<string, SemanticResolvedCandidate>();
    for (const candidate of candidates.slice(0, 50)) {
      if (!candidate.vectorId || !Number.isFinite(candidate.score)) continue;
      const row = first(
        store.sql.exec<SqlRow>(
          `SELECT c.vector_id AS vectorId, c.message_id AS messageId,
					c.source_fingerprint AS chunkFingerprint, c.content AS excerpt,
					s.source_fingerprint AS sourceFingerprint,
					s.source_sequence AS sourceSequence,
					COALESCE(e.subject, '') AS subject, COALESCE(e.sender, '') AS sender,
					COALESCE(e.recipient, '') AS recipient, COALESCE(e.date, '') AS date,
					e.folder_id AS folderId
				 FROM semantic_chunks c
				 JOIN semantic_sources s ON s.source_id = c.source_id
				 JOIN emails e ON e.id = c.message_id
				 WHERE c.vector_id = ?1 LIMIT 1`,
          candidate.vectorId,
        ),
      );
      if (!row || !semanticMessageEligible(text(row, "folderId"))) continue;
      if (text(row, "chunkFingerprint") !== text(row, "sourceFingerprint"))
        continue;
      const messageId = text(row, "messageId");
      if (
        semanticMessageVersion(store, messageId) !==
        integer(row, "sourceSequence")
      )
        continue;
      const resolved: SemanticResolvedCandidate = {
        vectorId: text(row, "vectorId"),
        messageId,
        score: Math.min(Math.max(candidate.score, 0), 1),
        subject: text(row, "subject").slice(0, 500),
        sender: text(row, "sender").slice(0, 320),
        recipient: text(row, "recipient").slice(0, 320),
        date: text(row, "date").slice(0, 64),
        folderId: text(row, "folderId").slice(0, 200),
        excerpt: text(row, "excerpt").slice(0, 600),
      };
      const existing = bestByMessage.get(messageId);
      if (!existing || resolved.score > existing.score)
        bestByMessage.set(messageId, resolved);
    }
    return [...bestByMessage.values()].sort(
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
