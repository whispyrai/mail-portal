import {
  SEMANTIC_SEARCH_LIMITS,
  parseSemanticSearchResponse,
  type SemanticSearchMailboxStatus,
  type SemanticSearchResponse,
  type SemanticSearchResult,
} from "../../shared/semantic-search.ts";
import type { MailboxRow } from "../db/users-schema.ts";
import { resolveBrand } from "../routes/brand.ts";
import type { Env } from "../types.ts";
import type {
  SemanticIndexReadiness,
  SemanticResolvedCandidate,
} from "./semantic-index.ts";
import { createSemanticEmbeddingRunner } from "./semantic-provider.ts";
import { semanticMailboxNamespace } from "./semantic-search.ts";
import { mailboxAccess } from "./mailbox-access.ts";

const MAILBOX_CONCURRENCY = 4;
export const SEMANTIC_CANDIDATES_PER_MAILBOX = 12;
export type SemanticSearchTiming = {
  requestMs: number;
  rosterMs: number;
  readinessMs: number;
  embeddingMs: number;
  mailboxMs: number;
};

const DEFAULT_TIMING: SemanticSearchTiming = {
  requestMs: 20_000,
  rosterMs: 3_000,
  readinessMs: 2_000,
  embeddingMs: 8_000,
  mailboxMs: 4_000,
};

class SemanticSearchTimeoutError extends Error {
  constructor() {
    super("Semantic search operation timed out");
    this.name = "SemanticSearchTimeoutError";
  }
}

function withinDeadline<T>(
  work: Promise<T>,
  operationMs: number,
  deadline: number,
): Promise<T> {
  const timeoutMs = Math.max(0, Math.min(operationMs, deadline - Date.now()));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SemanticSearchTimeoutError()),
      timeoutMs,
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

export class SemanticSearchCapacityError extends Error {
  readonly actual: number;

  constructor(actual: number) {
    super("Semantic search Mailbox capacity was exceeded");
    this.name = "SemanticSearchCapacityError";
    this.actual = actual;
  }
}

export type GlobalSemanticSearchDependencies = {
  listAccessibleMailboxes(actorUserId: string): Promise<MailboxRow[]>;
  canAccessMailbox(actorUserId: string, mailboxId: string): Promise<boolean>;
  readReadiness(mailboxId: string): Promise<SemanticIndexReadiness>;
  scheduleAdvance(mailboxId: string): void;
  embedQuery(actorUserId: string, query: string): Promise<number[]>;
  queryIndex(input: {
    mailboxId: string;
    queryVector: number[];
    limit: number;
  }): Promise<Array<{ vectorId: string; score: number }>>;
  resolveCandidates(input: {
    mailboxId: string;
    candidates: Array<{ vectorId: string; score: number }>;
  }): Promise<{
    candidates: SemanticResolvedCandidate[];
    readiness: SemanticIndexReadiness;
  }>;
};

type MailboxOutcome =
  | {
      kind: "complete";
      mailbox: MailboxRow;
      candidates: SemanticResolvedCandidate[];
    }
  | { kind: "building"; mailbox: MailboxRow }
  | { kind: "unavailable"; mailbox: MailboxRow }
  | { kind: "revoked"; mailbox: MailboxRow };

type MailboxReadinessOutcome = {
  mailbox: MailboxRow;
  readiness: SemanticIndexReadiness | null;
};

function orderedRoster(roster: readonly MailboxRow[]): MailboxRow[] {
  return [...roster].sort(
    (left, right) =>
      left.address.localeCompare(right.address) ||
      left.type.localeCompare(right.type),
  );
}

function rosterFingerprint(roster: readonly MailboxRow[]): string {
  return roster
    .map((mailbox) => `${mailbox.type}:${mailbox.address}`)
    .join("\n");
}

async function mapWithUnsettledConcurrency<T, TResult>(
  items: readonly T[],
  limit: number,
  operationMs: number,
  deadline: number,
  fallback: (item: T) => TResult,
  worker: (item: T, expired: () => boolean) => Promise<TResult>,
): Promise<TResult[]> {
  const results = items.map(fallback);
  const active = new Set<Promise<void>>();
  let nextIndex = 0;
  const start = (index: number) => {
    const item = items[index]!;
    let expired = false;
		let released = false;
		let releaseSlot: () => void = () => undefined;
		const slot = new Promise<void>((resolve) => {
			releaseSlot = resolve;
		});
		const release = () => {
			if (released) return;
			released = true;
			expired = true;
			clearTimeout(timeout);
			active.delete(slot);
			releaseSlot();
		};
    const timeout = setTimeout(
			release,
      Math.max(0, Math.min(operationMs, deadline - Date.now())),
    );
		worker(item, () => expired || Date.now() >= deadline)
      .then((result) => {
        if (!expired && Date.now() < deadline) results[index] = result;
      })
      .catch(() => undefined)
			.finally(release);
		active.add(slot);
  };
  while (
    (nextIndex < items.length || active.size > 0) &&
    Date.now() < deadline
  ) {
    while (nextIndex < items.length && active.size < limit) {
      start(nextIndex);
      nextIndex += 1;
    }
    if (active.size === 0) continue;
    await withinDeadline(
      Promise.race(active),
      deadline - Date.now(),
      deadline,
    ).catch(() => undefined);
  }
  return results;
}

function responseState(mailboxes: readonly SemanticSearchMailboxStatus[]) {
  const complete = mailboxes.filter(
    (mailbox) => mailbox.state === "complete",
  ).length;
  const building = mailboxes.filter(
    (mailbox) => mailbox.state === "building",
  ).length;
  if (mailboxes.length === 0 || complete === mailboxes.length)
    return "complete" as const;
  if (complete > 0) return "partial" as const;
  if (building > 0) return "building" as const;
  return "unavailable" as const;
}

function evidenceResult(
  mailbox: MailboxRow,
  candidate: SemanticResolvedCandidate,
): SemanticSearchResult {
  const sender = candidate.sender.trim();
  const recipient = candidate.recipient.trim();
  const counterparty =
    sender.toLowerCase() === mailbox.address.toLowerCase() ? recipient : sender;
	const common = {
		mailboxId: mailbox.address,
		mailboxAddress: mailbox.address,
		messageId: candidate.messageId,
    score: candidate.score,
    subject: candidate.subject,
    counterparty,
    date: candidate.date,
		folderId: candidate.folderId,
		excerpt: candidate.excerpt,
	};
	return candidate.source === "attachment"
		? {
			...common,
			source: "attachment",
			attachmentId: candidate.attachmentId,
			attachmentFilename: candidate.attachmentFilename,
			excerptKind: "extracted_attachment",
		}
		: {
			...common,
			source: "message",
			excerptKind: "authored_mail",
		};
}

async function runAttempt(
  dependencies: GlobalSemanticSearchDependencies,
  actorUserId: string,
  queryVector: () => Promise<number[]>,
  deadline: number,
  timing: SemanticSearchTiming,
): Promise<SemanticSearchResponse & { retryForRosterChange?: boolean }> {
  const retrievalDeadline = deadline - timing.rosterMs;
  const initialRoster = orderedRoster(
    await withinDeadline(
      dependencies.listAccessibleMailboxes(actorUserId),
      timing.rosterMs,
      deadline,
    ),
  );
  if (initialRoster.length > SEMANTIC_SEARCH_LIMITS.mailboxes) {
    throw new SemanticSearchCapacityError(initialRoster.length);
  }

  const initialReadiness = await mapWithUnsettledConcurrency<
    MailboxRow,
    MailboxReadinessOutcome
  >(
    initialRoster,
    MAILBOX_CONCURRENCY,
    timing.readinessMs,
    retrievalDeadline,
    (mailbox) => ({ mailbox, readiness: null }),
    async (mailbox, expired) => {
      const readiness = await dependencies.readReadiness(mailbox.address);
      if (expired()) throw new SemanticSearchTimeoutError();
      return { mailbox, readiness };
    },
  );
  const searchable = initialReadiness.filter(
    (
      item,
    ): item is { mailbox: MailboxRow; readiness: SemanticIndexReadiness } =>
      item.readiness?.state === "complete",
  );
  for (const item of initialReadiness) {
    if (item.readiness?.state === "building")
      dependencies.scheduleAdvance(item.mailbox.address);
  }
  const embeddedQuery =
    searchable.length > 0
      ? await withinDeadline(
          queryVector(),
          timing.embeddingMs,
          retrievalDeadline,
        )
      : null;

  const outcomes = await mapWithUnsettledConcurrency<
    MailboxReadinessOutcome,
    MailboxOutcome
  >(
    initialReadiness,
    MAILBOX_CONCURRENCY,
    timing.mailboxMs,
    retrievalDeadline,
    (item): MailboxOutcome => ({ kind: "unavailable", mailbox: item.mailbox }),
    async (item, expired): Promise<MailboxOutcome> => {
      if (!item.readiness || item.readiness.state === "unavailable") {
        return { kind: "unavailable", mailbox: item.mailbox };
      }
      if (item.readiness.state === "building" || !embeddedQuery) {
        return { kind: "building", mailbox: item.mailbox };
      }
      try {
        const vectorCandidates = await dependencies.queryIndex({
          mailboxId: item.mailbox.address,
          queryVector: embeddedQuery,
          limit: SEMANTIC_CANDIDATES_PER_MAILBOX,
        });
        if (expired()) throw new SemanticSearchTimeoutError();
        const resolved = await dependencies.resolveCandidates({
          mailboxId: item.mailbox.address,
          candidates: vectorCandidates,
        });
        if (expired()) throw new SemanticSearchTimeoutError();
        if (resolved.readiness.state !== "complete") {
          if (resolved.readiness.state === "building") {
            dependencies.scheduleAdvance(item.mailbox.address);
            return { kind: "building", mailbox: item.mailbox };
          }
          return { kind: "unavailable", mailbox: item.mailbox };
        }
        if (
          !(await dependencies.canAccessMailbox(
            actorUserId,
            item.mailbox.address,
          ))
        ) {
          return { kind: "revoked", mailbox: item.mailbox };
        }
        if (expired()) throw new SemanticSearchTimeoutError();
        return {
          kind: "complete",
          mailbox: item.mailbox,
          candidates: resolved.candidates,
        };
      } catch {
        return { kind: "unavailable", mailbox: item.mailbox };
      }
    },
  );

  const finalRoster = orderedRoster(
    await withinDeadline(
      dependencies.listAccessibleMailboxes(actorUserId),
      timing.rosterMs,
      deadline,
    ),
  );
  if (finalRoster.length > SEMANTIC_SEARCH_LIMITS.mailboxes) {
    throw new SemanticSearchCapacityError(finalRoster.length);
  }
  const rosterChanged =
    rosterFingerprint(initialRoster) !== rosterFingerprint(finalRoster);
  const outcomesByMailbox = new Map(
    outcomes.map((outcome) => [outcome.mailbox.address, outcome]),
  );
  const mailboxes: SemanticSearchMailboxStatus[] = finalRoster.map(
    (mailbox) => {
      const outcome = outcomesByMailbox.get(mailbox.address);
      return {
        mailboxId: mailbox.address,
        mailboxAddress: mailbox.address,
        state:
          outcome?.kind === "complete"
            ? "complete"
            : outcome?.kind === "building"
              ? "building"
              : "unavailable",
      };
    },
  );
  const finalAddresses = new Set(finalRoster.map((mailbox) => mailbox.address));
  const results = outcomes
    .filter(
      (outcome): outcome is Extract<MailboxOutcome, { kind: "complete" }> =>
        outcome.kind === "complete" &&
        finalAddresses.has(outcome.mailbox.address),
    )
    .flatMap((outcome) =>
      outcome.candidates.map((candidate) =>
        evidenceResult(outcome.mailbox, candidate),
      ),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.date.localeCompare(left.date) ||
        left.mailboxId.localeCompare(right.mailboxId) ||
        left.messageId.localeCompare(right.messageId),
    )
    .slice(0, SEMANTIC_SEARCH_LIMITS.resultLimit);
  const response: SemanticSearchResponse = {
    state: responseState(mailboxes),
    accessChanged:
      rosterChanged || outcomes.some((outcome) => outcome.kind === "revoked"),
    results,
    mailboxes,
  };
  const validated = parseSemanticSearchResponse(response);
  return rosterChanged
    ? { ...validated, retryForRosterChange: true }
    : validated;
}

export async function searchSemanticEvidence(
  dependencies: GlobalSemanticSearchDependencies,
  input: { actorUserId: string; query: string },
  timing: SemanticSearchTiming = DEFAULT_TIMING,
): Promise<SemanticSearchResponse> {
  const deadline = Date.now() + timing.requestMs;
  let queryVectorWork: Promise<number[]> | null = null;
  const queryVector = () => {
    queryVectorWork ??= dependencies.embedQuery(input.actorUserId, input.query);
    return queryVectorWork;
  };
  const first = await runAttempt(
    dependencies,
    input.actorUserId,
    queryVector,
    deadline,
    timing,
  );
  if (!first.retryForRosterChange) return first;
  const second = await runAttempt(
    dependencies,
    input.actorUserId,
    queryVector,
    deadline,
    timing,
  );
  const { retryForRosterChange: _ignored, ...response } = second;
  return parseSemanticSearchResponse({ ...response, accessChanged: true });
}

/** Production binding adapter. Each DO RPC uses a fresh stub after exceptions. */
export function createGlobalSemanticSearchDependencies(
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
): GlobalSemanticSearchDependencies {
  const access = mailboxAccess(env);
  const index = env.SEMANTIC_INDEX;
  if (!index) throw new Error("Semantic Vectorize binding is unavailable");
  const environment = resolveBrand(env.BRAND).id;
  return {
    listAccessibleMailboxes: (actorUserId) =>
      access.listAccessibleMailboxes(actorUserId),
    canAccessMailbox: (actorUserId, mailboxId) =>
      access.canAccessMailbox(actorUserId, mailboxId),
    readReadiness: (mailboxId) => {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
      return stub.readSemanticIndexReadiness();
    },
    scheduleAdvance: (mailboxId) => {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
      const work = stub
        .scheduleSemanticIndexAdvance(mailboxId)
        .catch((error) => {
          console.error("[semantic-index] scheduling failed", {
            errorCode: error instanceof Error ? error.name : "unknown",
          });
        });
      waitUntil(work);
    },
    embedQuery: async (actorUserId, query) => {
      const vectors = await createSemanticEmbeddingRunner(env, {
        feature: "semantic_query_embedding",
        actorUserId,
      })([query]);
      const vector = vectors[0];
      if (!vector) throw new Error("Semantic query embedding is unavailable");
      return vector;
    },
    queryIndex: async ({ mailboxId, queryVector, limit }) => {
      const namespace = await semanticMailboxNamespace(environment, mailboxId);
      // Vectorize namespace filters before similarity search. Request no values
      // or metadata so only opaque IDs and scores cross this boundary.
      // https://developers.cloudflare.com/vectorize/reference/client-api/
      const matches = await index.query(queryVector, {
        namespace,
        topK: Math.min(
          Math.max(Math.trunc(limit), 1),
          SEMANTIC_CANDIDATES_PER_MAILBOX,
        ),
        returnMetadata: "none",
        returnValues: false,
      });
      return matches.matches
        .filter((match) => Boolean(match.id) && Number.isFinite(match.score))
        .map((match) => ({ vectorId: match.id, score: match.score }));
    },
    resolveCandidates: ({ mailboxId, candidates }) => {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
      return stub.resolveSemanticCandidates(candidates);
    },
  };
}
