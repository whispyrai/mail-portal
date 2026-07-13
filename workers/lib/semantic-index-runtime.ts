import type {
  SemanticIndexJob,
  SemanticIndexReadiness,
  SemanticSubmittedJob,
} from "./semantic-index.ts";
import {
	advanceSemanticAttachmentExtraction,
	type SemanticAttachmentRuntimeBucket,
	type SemanticAttachmentRuntimeMailbox,
} from "./semantic-attachment-runtime.ts";

// A mixed turn can run two embed/upsert pairs and one delete. Keep the durable
// lease beyond all five provider budgets with ample commit and scheduler margin.
const LEASE_MS = 120_000;
const JOB_LIMIT = 20;
const RETRY_DELAY_MS = 30_000;
const DEFER_DELAY_MS = 15 * 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 15_000;

export class SemanticIndexDeferredError extends Error {
  constructor(message = "Semantic indexing is deferred by its cost guard") {
    super(message);
    this.name = "SemanticIndexDeferredError";
  }
}

async function providerCall<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Semantic provider operation timed out")),
      PROVIDER_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type SemanticVector = {
  id: string;
  values: number[];
  namespace: string;
};

export type SemanticIndexRuntimeMailbox = {
  prepareSemanticIndex(): Promise<SemanticIndexReadiness>;
  readSemanticIndexReadiness(): Promise<SemanticIndexReadiness>;
  listSubmittedSemanticIndexJobs(
    limit: number,
    observedAt: number,
  ): Promise<SemanticSubmittedJob[]>;
  confirmSemanticIndexVisibility(
    observations: Array<{ vectorId: string; visible: boolean }>,
    observedAt: number,
  ): Promise<void>;
  leaseSemanticIndexJobs(
    leaseToken: string,
    nowMs: number,
    leaseMs: number,
    limit: number,
  ): Promise<SemanticIndexJob[]>;
  submitSemanticIndexJobs(
    jobs: Array<{ vectorId: string; leaseToken: string }>,
    mutationId: string,
    submittedAt: number,
  ): Promise<string[]>;
  retrySemanticIndexJobs(
    jobs: Array<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      errorCode: string;
      failedAt: number;
    }>,
  ): Promise<string[]>;
  deferSemanticIndexJobs(
    jobs: Array<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      reasonCode: string;
      deferredAt: number;
    }>,
  ): Promise<string[]>;
};

export type SemanticIndexRuntimeProvider = {
	embed(
		texts: string[],
		feature: "semantic_message_index" | "semantic_attachment_index",
	): Promise<number[][]>;
  upsert(vectors: SemanticVector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<Array<{ id: string }>>;
};

export type SemanticMailboxIndexRuntime = SemanticIndexRuntimeMailbox &
	SemanticAttachmentRuntimeMailbox;

function providerErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) {
    return `provider_${error.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(
      0,
      64,
    );
  }
  return "provider_error";
}

function mutationReceipt(
  value: unknown,
  createReceiptToken: () => string,
): string {
  if (value && typeof value === "object" && "mutationId" in value) {
    const mutationId = value.mutationId;
    if (typeof mutationId === "string" && mutationId.trim()) {
      return mutationId.trim().slice(0, 300);
    }
  }
  const token = createReceiptToken()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 200);
  if (!token)
    throw new Error(
      "Semantic vector receipt generator returned an invalid token",
    );
  return `local_${token}`;
}

function validateEmbeddings(
  embeddings: number[][],
  expected: number,
): number[][] {
  if (embeddings.length !== expected) {
    throw new Error(
      "Semantic embedding provider returned an unexpected vector count",
    );
  }
  let dimension = 0;
  for (const embedding of embeddings) {
    if (
      embedding.length === 0 ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Semantic embedding provider returned an invalid vector");
    }
    if (dimension === 0) dimension = embedding.length;
    if (embedding.length !== dimension) {
      throw new Error(
        "Semantic embedding provider returned inconsistent dimensions",
      );
    }
  }
  return embeddings;
}

async function confirmSubmittedJobs(
  mailbox: SemanticIndexRuntimeMailbox,
  provider: SemanticIndexRuntimeProvider,
  observedAt: number,
): Promise<void> {
  const submitted = await mailbox.listSubmittedSemanticIndexJobs(
    100,
    observedAt,
  );
  if (submitted.length === 0) return;
  const records = await providerCall(
    provider.getByIds(submitted.map((job) => job.vectorId)),
  );
  const submittedIds = new Set(submitted.map((job) => job.vectorId));
  const visibleIds = new Set(
    records.map((record) => record.id).filter((id) => submittedIds.has(id)),
  );
  await mailbox.confirmSemanticIndexVisibility(
    submitted.map((job) => ({
      vectorId: job.vectorId,
      visible: visibleIds.has(job.vectorId),
    })),
    observedAt,
  );
}

async function retryJobs(
  mailbox: SemanticIndexRuntimeMailbox,
  jobs: SemanticIndexJob[],
  nowMs: number,
  error: unknown,
): Promise<void> {
  const errorCode = providerErrorCode(error);
  await mailbox.retrySemanticIndexJobs(
    jobs.map((job) => ({
      vectorId: job.vectorId,
      leaseToken: job.leaseToken,
      nextAttemptAt:
        nowMs +
        Math.min(
          RETRY_DELAY_MS * 2 ** Math.max(job.attemptCount - 1, 0),
          15 * 60 * 1_000,
        ),
      errorCode,
      failedAt: nowMs,
    })),
  );
}

async function deferJobs(
  mailbox: SemanticIndexRuntimeMailbox,
  jobs: SemanticIndexJob[],
  nowMs: number,
): Promise<void> {
  await mailbox.deferSemanticIndexJobs(
    jobs.map((job) => ({
      vectorId: job.vectorId,
      leaseToken: job.leaseToken,
      nextAttemptAt: nowMs + DEFER_DELAY_MS,
      reasonCode: "cost_guard_paused",
      deferredAt: nowMs,
    })),
  );
}

async function submitJobs(
  mailbox: SemanticIndexRuntimeMailbox,
  jobs: SemanticIndexJob[],
  mutationId: string,
  submittedAt: number,
): Promise<void> {
  await mailbox.submitSemanticIndexJobs(
    jobs.map((job) => ({
      vectorId: job.vectorId,
      leaseToken: job.leaseToken,
    })),
    mutationId,
    submittedAt,
  );
}

/**
 * Advances one bounded, scheduler-driven indexing turn. The local outbox remains
 * authoritative, so provider acknowledgement never implies search readiness.
 */
export async function advanceSemanticIndex(input: {
  mailbox: SemanticIndexRuntimeMailbox;
  provider: SemanticIndexRuntimeProvider;
  namespace: string;
  now?: () => number;
  createLeaseToken?: () => string;
  createReceiptToken?: () => string;
  onObservationError?: (error: unknown) => void;
}): Promise<SemanticIndexReadiness> {
  const now = input.now ?? Date.now;
  const createLeaseToken = input.createLeaseToken ?? crypto.randomUUID;
  const createReceiptToken = input.createReceiptToken ?? crypto.randomUUID;
  await input.mailbox.prepareSemanticIndex();

  try {
    await confirmSubmittedJobs(input.mailbox, input.provider, now());
  } catch (error) {
    // Vectorize mutations are eventually visible. A failed observation leaves
    // submitted jobs durable and the Mailbox truthfully reports building.
    input.onObservationError?.(error);
  }

  const nowMs = now();
  const jobs = await input.mailbox.leaseSemanticIndexJobs(
    createLeaseToken(),
    nowMs,
    LEASE_MS,
    JOB_LIMIT,
  );
  const upserts = jobs.filter(
    (job): job is SemanticIndexJob & { operation: "upsert"; content: string } =>
      job.operation === "upsert" && job.content !== null,
  );
  const deletes = jobs.filter((job) => job.operation === "delete");

	const upsertGroups = [
		{
			feature: "semantic_message_index" as const,
			jobs: upserts.filter((job) => job.vectorId.startsWith("sm1_")),
		},
		{
			feature: "semantic_attachment_index" as const,
			jobs: upserts.filter((job) => job.vectorId.startsWith("sa1_")),
		},
	];
	for (const group of upsertGroups) {
		if (group.jobs.length === 0) continue;
		try {
			const embeddings = validateEmbeddings(
				await providerCall(
					input.provider.embed(
						group.jobs.map((job) => job.content),
						group.feature,
					),
				),
				group.jobs.length,
			);
			const mutation = await providerCall(
				input.provider.upsert(
					group.jobs.map((job, index) => ({
            id: job.vectorId,
            values: embeddings[index]!,
            namespace: input.namespace,
          })),
        ),
      );
			await submitJobs(
				input.mailbox,
				group.jobs,
        mutationReceipt(mutation, createReceiptToken),
        now(),
      );
		} catch (error) {
			if (error instanceof SemanticIndexDeferredError) {
				await deferJobs(input.mailbox, group.jobs, nowMs);
			} else {
				await retryJobs(input.mailbox, group.jobs, nowMs, error);
			}
		}
	}
	const unknownUpserts = upserts.filter(
		(job) => !job.vectorId.startsWith("sm1_") && !job.vectorId.startsWith("sa1_"),
	);
	if (unknownUpserts.length > 0) {
		await retryJobs(
			input.mailbox,
			unknownUpserts,
			nowMs,
			new Error("Semantic vector source type is invalid"),
		);
	}

  if (deletes.length > 0) {
    try {
      const mutation = await providerCall(
        input.provider.deleteByIds(deletes.map((job) => job.vectorId)),
      );
      await submitJobs(
        input.mailbox,
        deletes,
        mutationReceipt(mutation, createReceiptToken),
        now(),
      );
    } catch (error) {
      await retryJobs(input.mailbox, deletes, nowMs, error);
    }
  }

  return input.mailbox.readSemanticIndexReadiness();
}

/**
 * Advances the exact composed work owned by one Mailbox alarm turn. Attachment
 * extraction runs first so a ready extraction can enter the same turn's
 * authoritative projection and vector outbox.
 */
export async function advanceSemanticMailboxIndex(input: {
	mailbox: SemanticMailboxIndexRuntime;
	bucket: SemanticAttachmentRuntimeBucket;
	provider: SemanticIndexRuntimeProvider;
	namespace: string;
	now?: () => number;
	createLeaseToken?: () => string;
	createReceiptToken?: () => string;
	onObservationError?: (error: unknown) => void;
}): Promise<SemanticIndexReadiness> {
	await advanceSemanticAttachmentExtraction({
		mailbox: input.mailbox,
		bucket: input.bucket,
		now: input.now,
		createLeaseToken: input.createLeaseToken,
	});
	return advanceSemanticIndex({
		mailbox: input.mailbox,
		provider: input.provider,
		namespace: input.namespace,
		now: input.now,
		createLeaseToken: input.createLeaseToken,
		createReceiptToken: input.createReceiptToken,
		onObservationError: input.onObservationError,
	});
}
