import { Button, Loader, Pagination } from "@cloudflare/kumo";
import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
import { formatListDate, getSnippetText } from "~/lib/utils";
import { useSavedView, useSavedViewEmails } from "~/queries/saved-views";
import { SavedViewApiError } from "~/services/saved-views";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

export default function SavedViewResultsRoute() {
  const { mailboxId, viewId } = useParams<{
    mailboxId: string;
    viewId: string;
  }>();
  const [page, setPage] = useState(1);
  const { selectedEmailId, selectEmail, closePanel } = useUIStore();
  const applied = useSavedView(mailboxId, viewId);
  const results = useSavedViewEmails({
    mailboxId,
    viewId,
    searchParams: applied.data?.searchParams,
    page,
    limit: PAGE_SIZE,
  });

  useEffect(() => {
    setPage(1);
    closePanel();
  }, [closePanel, mailboxId, viewId]);

  const view = applied.data?.view;
  const emails = results.data?.emails ?? [];
  const totalCount = results.data?.totalCount ?? 0;
  const forbidden =
    applied.error instanceof SavedViewApiError && applied.error.status === 403;
  const failed = applied.isError || results.isError;
  const loading = applied.isLoading || (applied.isSuccess && results.isLoading);

  const openEmail = (email: Email) => selectEmail(email.id);

  return (
    <MailboxSplitView selectedEmailId={selectedEmailId}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-kumo-line px-4 py-3 md:px-5">
          <BookmarkSimpleIcon size={21} className="shrink-0 text-kumo-subtle" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-kumo-default">
              {view?.name ?? "Saved view"}
            </h1>
            {view && !loading && (
              <p className="text-sm text-kumo-subtle">
                {totalCount} message{totalCount === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              applied.refetch();
              results.refetch();
            }}
          >
            Refresh
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div role="status" className="flex justify-center py-20">
              <Loader size="lg" />
            </div>
          ) : failed ? (
            <div
              role="alert"
              className="mx-auto max-w-lg px-6 py-20 text-center"
            >
              <h2 className="text-base font-semibold text-kumo-default">
                {forbidden
                  ? "Mailbox access required"
                  : "Saved view unavailable"}
              </h2>
              <p className="mt-2 text-sm text-kumo-subtle">
                {forbidden
                  ? "Your access changed. The personal view was preserved, but its mailbox content is no longer available."
                  : "Try refreshing this view."}
              </p>
            </div>
          ) : emails.length === 0 ? (
            <div className="mx-auto max-w-lg px-6 py-20 text-center">
              <BookmarkSimpleIcon
                size={46}
                weight="thin"
                className="mx-auto text-kumo-subtle"
              />
              <h2 className="mt-4 text-base font-semibold text-kumo-default">
                No matching messages
              </h2>
              <p className="mt-2 text-sm text-kumo-subtle">
                {view?.filters.labelId
                  ? "This view includes a label filter. If that label was removed, the view stays empty rather than showing unrelated mail."
                  : "No mail currently matches this view's filters."}
              </p>
            </div>
          ) : (
            <div>
              {emails.map((email) => {
                const selected = selectedEmailId === email.id;
                const snippet = getSnippetText(email.snippet, 120);
                return (
                  <button
                    key={email.id}
                    type="button"
                    onClick={() => openEmail(email)}
                    className={`flex min-h-16 w-full items-center gap-3 border-b border-kumo-line px-4 py-2.5 text-left transition-colors md:px-5 ${selected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
                  >
                    <span className="flex w-2.5 shrink-0 justify-center">
                      {!email.read && (
                        <span className="h-2 w-2 rounded-full bg-kumo-brand" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${email.read ? "text-kumo-strong" : "font-semibold text-kumo-default"}`}
                        >
                          {email.sender}
                        </span>
                        <span className="shrink-0 text-xs text-kumo-subtle">
                          {formatListDate(email.date)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-kumo-default">
                        {email.subject || "(No subject)"}
                      </span>
                      {snippet && (
                        <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
                          {snippet}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {totalCount > PAGE_SIZE && (
          <div className="flex shrink-0 justify-center border-t border-kumo-line py-3">
            <Pagination
              page={page}
              setPage={setPage}
              perPage={PAGE_SIZE}
              totalCount={totalCount}
            />
          </div>
        )}
      </div>
    </MailboxSplitView>
  );
}
