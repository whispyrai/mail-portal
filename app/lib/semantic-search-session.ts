import type { MailboxChange } from "../../shared/mailbox-change-feed.ts";
import type { SemanticSearchResponse } from "../../shared/semantic-search.ts";
import { truncateSemanticSearchText } from "../../shared/semantic-search.ts";

export type SemanticSearchSessionSnapshot = {
  actorEmail: string;
  createdAt: string;
  draftQuery: string;
  submittedQuery: string;
  response: SemanticSearchResponse;
  expandedResultIds: string[];
  scrollTop: number;
};

let snapshot: SemanticSearchSessionSnapshot | null = null;
const listeners = new Set<() => void>();
let invalidationChannel: BroadcastChannel | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function receiveInvalidation(): void {
  if (snapshot === null) return;
  snapshot = null;
  emit();
}

function ensureInvalidationChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return null;
  if (!invalidationChannel) {
    invalidationChannel = new BroadcastChannel(
      "mail-portal:semantic-evidence-invalidation:v1",
    );
    invalidationChannel.addEventListener("message", (event) => {
      if (event.data === "invalidate") receiveInvalidation();
    });
  }
  return invalidationChannel;
}

function cloneSnapshot(
  value: SemanticSearchSessionSnapshot,
): SemanticSearchSessionSnapshot {
  return {
    ...value,
    response: {
      ...value.response,
      results: value.response.results.map((result) => ({ ...result })),
      mailboxes: value.response.mailboxes.map((mailbox) => ({ ...mailbox })),
    },
    expandedResultIds: [...value.expandedResultIds],
  };
}

type SemanticSearchResultIdentity =
  | { mailboxId: string; messageId: string; source: "message" }
  | {
      mailboxId: string;
      messageId: string;
      source: "attachment";
      attachmentId: string;
    };

export function semanticSearchResultIdentity(
  result: SemanticSearchResultIdentity,
): string {
  return result.source === "attachment"
    ? `${result.mailboxId}\u0000attachment\u0000${result.messageId}\u0000${result.attachmentId}`
    : `${result.mailboxId}\u0000message\u0000${result.messageId}`;
}

export function semanticSearchExcerptPreview(excerpt: string): string {
	if (excerpt.length <= 260) return excerpt;
	const bounded = truncateSemanticSearchText(excerpt, 257)
		.replace(/\s+\S*$/u, "")
		.trimEnd();
	return `${bounded}…`;
}

export function readSemanticSearchSession(): SemanticSearchSessionSnapshot | null {
  return snapshot ? cloneSnapshot(snapshot) : null;
}

export function writeSemanticSearchSession(
  next: SemanticSearchSessionSnapshot,
): void {
  snapshot = cloneSnapshot(next);
  emit();
}

export function clearSemanticSearchSession(): void {
  const hadSnapshot = snapshot !== null;
  snapshot = null;
  if (hadSnapshot) emit();
  ensureInvalidationChannel()?.postMessage("invalidate");
}

export function subscribeSemanticSearchSession(
  listener: () => void,
): () => void {
  listeners.add(listener);
  ensureInvalidationChannel();
  return () => listeners.delete(listener);
}

export function getSemanticSearchSessionSnapshot(): SemanticSearchSessionSnapshot | null {
  return snapshot;
}

export function getSemanticSearchServerSnapshot(): null {
  return null;
}

export function semanticSearchSessionContainsMailbox(
  mailboxId: string,
): boolean {
  return (
    snapshot?.response.mailboxes.some(
      (mailbox) => mailbox.mailboxId === mailboxId,
    ) ?? false
  );
}

export function clearSemanticSearchSessionForMailbox(
  mailboxId: string,
): boolean {
  if (!semanticSearchSessionContainsMailbox(mailboxId)) return false;
  clearSemanticSearchSession();
  return true;
}

export function clearSemanticSearchSessionForMailboxChanges(
  mailboxId: string,
  changes: readonly MailboxChange[],
): boolean {
  if (!semanticMailboxChangesAffectEvidence(changes)) return false;
  return clearSemanticSearchSessionForMailbox(mailboxId);
}

export function semanticMailboxChangesAffectEvidence(
  changes: readonly MailboxChange[],
): boolean {
  return changes.some(
    (change) =>
      change.resource === "message" ||
      change.resource === "attachment" ||
      change.resource === "folder",
  );
}
