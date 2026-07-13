import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { redirect } from "react-router";
import GlobalMeaningWorkspace from "~/components/global/meaning/GlobalMeaningWorkspace";
import { useBrand } from "~/hooks/useBrand";
import { purgeAllCachedMailState } from "~/lib/global-today-recovery";
import {
  clearSemanticSearchSession,
  getSemanticSearchServerSnapshot,
  getSemanticSearchSessionSnapshot,
  readSemanticSearchSession,
  semanticMailboxChangesAffectEvidence,
  subscribeSemanticSearchSession,
  writeSemanticSearchSession,
} from "~/lib/semantic-search-session";
import {
  exitRevokedMailbox,
  reconcileMailboxChangeFeedOnce,
  resetMailboxChangeFeedBaseline,
  resolveMailboxChangeFeedStorage,
  useMailboxChangeFeeds,
} from "~/queries/mailbox-change-feed";
import api, { ApiError } from "~/services/api";
import { searchSemanticEvidence } from "~/services/semantic-search";
import { parseSemanticSearchRequest } from "../../shared/semantic-search.ts";
import { isSemanticSearchEnabled } from "../../workers/lib/features.ts";
import { resolveBrand } from "../../workers/routes/brand.ts";
import type { Route } from "./+types/global-meaning";

const MEANING_OPERATION_TIMEOUT_MS = 30_000;

export function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const brand = resolveBrand(env.BRAND);
  if (!isSemanticSearchEnabled(env.FEATURES, brand.id))
    throw redirect("/today");
  return null;
}

function useOnlineState() {
  const [online, setOnline] = useState(
    () => typeof window === "undefined" || navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Meaning search could not be completed. Check your connection and try again.";
}

async function resetSemanticMailboxBaselines(
  mailboxIds: readonly string[],
  storage: ReturnType<typeof resolveMailboxChangeFeedStorage>,
  options: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<Map<string, string>> {
  const cursors = new Map<string, string>();
  for (let index = 0; index < mailboxIds.length; index += 4) {
    if (options.signal.aborted || !options.isCurrent()) break;
    const entries = await Promise.all(
      mailboxIds.slice(index, index + 4).map(
        async (mailboxId) =>
          [
            mailboxId,
            await resetMailboxChangeFeedBaseline({
              mailboxId,
              storage,
              signal: options.signal,
              isCurrent: options.isCurrent,
            }),
          ] as const,
      ),
    );
    if (options.signal.aborted || !options.isCurrent()) break;
    for (const [mailboxId, cursor] of entries) cursors.set(mailboxId, cursor);
  }
  return cursors;
}

function MeaningRouteController() {
  const queryClient = useQueryClient();
  const isOnline = useOnlineState();
  const observedSnapshot = useSyncExternalStore(
    subscribeSemanticSearchSession,
    getSemanticSearchSessionSnapshot,
    getSemanticSearchServerSnapshot,
  );
  const requestRef = useRef<{
    sequence: number;
    controller: AbortController;
  } | null>(null);
  const requestSequence = useRef(0);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const priorMailboxIds = useRef(new Set<string>());
  const actorEmailRef = useRef<string | null>(null);
  const scrollTopRef = useRef(0);
  const scrollPersistTimerRef = useRef<number | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [restorationReady, setRestorationReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusSequence, setFocusSequence] = useState(0);

  const response = restorationReady
    ? (observedSnapshot?.response ?? null)
    : null;
  const expandedResultIds = useMemo(
    () =>
      new Set(
        restorationReady ? (observedSnapshot?.expandedResultIds ?? []) : [],
      ),
    [observedSnapshot, restorationReady],
  );

  const handleSessionLost = useCallback(() => {
    clearSemanticSearchSession();
    purgeAllCachedMailState(queryClient);
    window.location.replace("/login");
  }, [queryClient]);
  useMailboxChangeFeeds(
    response?.mailboxes.map((mailbox) => mailbox.mailboxId) ?? [],
    handleSessionLost,
  );
  useEffect(
    () => () => {
      requestRef.current?.controller.abort();
      if (scrollPersistTimerRef.current !== null)
        window.clearTimeout(scrollPersistTimerRef.current);
      const snapshot = getSemanticSearchSessionSnapshot();
      if (snapshot)
        writeSemanticSearchSession({
          ...snapshot,
          scrollTop: scrollTopRef.current,
        });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const restorationController = new AbortController();
    const candidate = readSemanticSearchSession();
    if (!candidate) {
      setRestorationReady(true);
      return;
    }
    const restoreSequence = requestSequence.current;
    const createdAt = Date.parse(candidate.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60_000) {
      clearSemanticSearchSession();
      setRestorationReady(true);
      return;
    }
    void Promise.all([
      api.getCurrentActor({ signal: restorationController.signal }),
      api.listMailboxes({ signal: restorationController.signal }),
    ])
      .then(async ([actor, mailboxes]) => {
        if (cancelled || requestSequence.current !== restoreSequence) return;
        const accessible = new Set(mailboxes.map((mailbox) => mailbox.id));
        const storage = resolveMailboxChangeFeedStorage(
          () => window.localStorage,
        );
        const revokedMailboxIds = candidate.response.mailboxes
          .map((mailbox) => mailbox.mailboxId)
          .filter((mailboxId) => !accessible.has(mailboxId));
        if (actor.email !== candidate.actorEmail) {
          clearSemanticSearchSession();
          purgeAllCachedMailState(queryClient);
          return;
        }
        if (revokedMailboxIds.length > 0) {
          for (const mailboxId of revokedMailboxIds) {
            exitRevokedMailbox({ queryClient, mailboxId, storage });
          }
          clearSemanticSearchSession();
          return;
        }
        for (const mailbox of candidate.response.mailboxes) {
          try {
            await reconcileMailboxChangeFeedOnce({
              mailboxId: mailbox.mailboxId,
              queryClient,
              storage,
              signal: restorationController.signal,
              isCurrent: () =>
                !cancelled &&
                requestSequence.current === restoreSequence &&
                readSemanticSearchSession()?.createdAt === candidate.createdAt,
            });
          } catch (error) {
            if (error instanceof ApiError && error.status === 403) {
              exitRevokedMailbox({
                queryClient,
                mailboxId: mailbox.mailboxId,
                storage,
              });
              clearSemanticSearchSession();
              return;
            }
            throw error;
          }
          if (
            cancelled ||
            requestSequence.current !== restoreSequence ||
            readSemanticSearchSession()?.createdAt !== candidate.createdAt
          )
            return;
        }
        if (requestSequence.current !== restoreSequence) return;
        actorEmailRef.current = actor.email;
        priorMailboxIds.current = new Set(
          candidate.response.mailboxes.map((mailbox) => mailbox.mailboxId),
        );
        scrollTopRef.current = candidate.scrollTop;
        setDraftQuery(candidate.draftQuery);
        setSubmittedQuery(candidate.submittedQuery);
      })
      .catch((restoreError) => {
        if (cancelled || requestSequence.current !== restoreSequence) return;
        clearSemanticSearchSession();
        if (restoreError instanceof ApiError && restoreError.status === 401) {
          handleSessionLost();
        }
      })
      .finally(() => {
        if (!cancelled && requestSequence.current === restoreSequence)
          setRestorationReady(true);
      });
    return () => {
      cancelled = true;
      restorationController.abort();
    };
  }, [handleSessionLost, queryClient]);

  useEffect(() => {
    if (focusSequence === 0) return;
    const frame = requestAnimationFrame(() =>
      resultsHeadingRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusSequence]);

  const submit = useCallback(
    async (query: string) => {
      if (!isOnline) {
        setError("You are offline. Reconnect, then try again.");
        return;
      }
      let normalized: { query: string };
      try {
        normalized = parseSemanticSearchRequest({ query });
      } catch {
        setError(
          "Enter at least two characters within the 500-character search limit.",
        );
        return;
      }
      requestRef.current?.controller.abort();
      const controller = new AbortController();
      const sequence = ++requestSequence.current;
      const isCurrent = () =>
        requestRef.current?.sequence === sequence && !controller.signal.aborted;
      let operationTimedOut = false;
      const operationTimeout = window.setTimeout(() => {
        operationTimedOut = true;
        controller.abort();
      }, MEANING_OPERATION_TIMEOUT_MS);
      requestRef.current = { sequence, controller };
      clearSemanticSearchSession();
      setDraftQuery(normalized.query);
      setSubmittedQuery(normalized.query);
      setError(null);
      setIsLoading(true);
      scrollTopRef.current = 0;
      try {
        const storage = resolveMailboxChangeFeedStorage(
          () => window.localStorage,
        );
        let next: Awaited<ReturnType<typeof searchSemanticEvidence>> | null =
          null;
        let acceptedBaselineMailboxIds = new Set<string>();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const roster = await api.listMailboxes({ signal: controller.signal });
          if (requestRef.current?.sequence !== sequence) return;
          const baselineMailboxIds = new Set(
            roster.map((mailbox) => mailbox.id),
          );
          const baselineCursors = await resetSemanticMailboxBaselines(
            [...baselineMailboxIds],
            storage,
            { signal: controller.signal, isCurrent },
          );
          if (requestRef.current?.sequence !== sequence) return;
          const candidate = await searchSemanticEvidence({
            query: normalized.query,
            signal: controller.signal,
          });
          if (requestRef.current?.sequence !== sequence) return;
          const candidateMailboxIds = candidate.mailboxes.map(
            (mailbox) => mailbox.mailboxId,
          );
          let changedDuringSearch = candidateMailboxIds.some(
            (mailboxId) => !baselineCursors.has(mailboxId),
          );
          if (!changedDuringSearch) {
            for (
              let index = 0;
              index < candidateMailboxIds.length;
              index += 4
            ) {
              const changePages = await Promise.all(
                candidateMailboxIds
                  .slice(index, index + 4)
                  .map((mailboxId) =>
                    reconcileMailboxChangeFeedOnce({
                      mailboxId,
                      queryClient,
                      storage,
                      cursor: baselineCursors.get(mailboxId),
                      signal: controller.signal,
                      isCurrent,
                    }),
                  ),
              );
              if (changePages.some(semanticMailboxChangesAffectEvidence)) {
                changedDuringSearch = true;
              }
            }
          }
          if (!changedDuringSearch) {
            next = candidate;
            acceptedBaselineMailboxIds = baselineMailboxIds;
            break;
          }
        }
        if (!next) {
          throw new ApiError(409, {
            error: "Mail changed while Meaning search was running. Try again.",
          });
        }
        if (requestRef.current?.sequence !== sequence) return;
        const nextMailboxIds = new Set(
          next.mailboxes.map((mailbox) => mailbox.mailboxId),
        );
        const previouslyAccessibleMailboxIds = new Set([
          ...priorMailboxIds.current,
          ...acceptedBaselineMailboxIds,
        ]);
        for (const mailboxId of previouslyAccessibleMailboxIds) {
          if (!nextMailboxIds.has(mailboxId)) {
            exitRevokedMailbox({ queryClient, mailboxId, storage });
          }
        }
        priorMailboxIds.current = nextMailboxIds;
        const actorEmail =
          actorEmailRef.current ??
          queryClient.getQueryData<{ email: string }>(["me"])?.email ??
          (await api.getCurrentActor({ signal: controller.signal })).email;
        if (requestRef.current?.sequence !== sequence) return;
        actorEmailRef.current = actorEmail;
        writeSemanticSearchSession({
          actorEmail,
          createdAt: new Date().toISOString(),
          draftQuery: normalized.query,
          submittedQuery: normalized.query,
          response: next,
          expandedResultIds: [],
          scrollTop: 0,
        });
        setRestorationReady(true);
        setFocusSequence((current) => current + 1);
      } catch (requestError) {
        if (requestRef.current?.sequence !== sequence) return;
        if (controller.signal.aborted) {
          if (operationTimedOut)
            setError("Meaning search took too long. Try again.");
          return;
        }
        if (
          requestError instanceof ApiError &&
          (requestError.status === 401 || requestError.status === 403)
        ) {
          clearSemanticSearchSession();
          purgeAllCachedMailState(queryClient);
          window.location.replace(
            requestError.status === 401 ? "/login" : "/mailboxes",
          );
          return;
        }
        setError(errorMessage(requestError));
      } finally {
        window.clearTimeout(operationTimeout);
        if (requestRef.current?.sequence === sequence) {
          requestRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [isOnline, queryClient],
  );

  return (
    <GlobalMeaningWorkspace
      draftQuery={draftQuery}
      submittedQuery={submittedQuery}
      response={response}
      isLoading={isLoading}
      error={error}
      isOnline={isOnline}
      expandedResultIds={expandedResultIds}
      initialScrollTop={scrollTopRef.current}
      resultsHeadingRef={resultsHeadingRef}
      onDraftQueryChange={(query) => {
        setDraftQuery(query);
        setError(null);
        if (response && observedSnapshot)
          writeSemanticSearchSession({
            ...observedSnapshot,
            draftQuery: query,
          });
      }}
      onSubmit={() => void submit(draftQuery)}
      onRetry={() => void submit(submittedQuery || draftQuery)}
      onExpandedChange={(identity, isExpanded) => {
        if (!response || !observedSnapshot) return;
        const next = new Set(observedSnapshot.expandedResultIds);
        if (isExpanded) next.add(identity);
        else next.delete(identity);
        writeSemanticSearchSession({
          ...observedSnapshot,
          expandedResultIds: [...next],
        });
      }}
      onScrollPositionChange={(scrollTop) => {
        scrollTopRef.current = scrollTop;
        if (!response || !observedSnapshot) return;
        if (scrollPersistTimerRef.current !== null)
          window.clearTimeout(scrollPersistTimerRef.current);
        scrollPersistTimerRef.current = window.setTimeout(() => {
          scrollPersistTimerRef.current = null;
          const snapshot = getSemanticSearchSessionSnapshot();
          if (snapshot)
            writeSemanticSearchSession({
              ...snapshot,
              scrollTop: scrollTopRef.current,
            });
        }, 180);
      }}
    />
  );
}

export default function GlobalMeaningRoute() {
  const { semanticSearchEnabled } = useBrand();
  if (!semanticSearchEnabled) {
    clearSemanticSearchSession();
    return null;
  }
  return <MeaningRouteController />;
}
