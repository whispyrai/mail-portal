import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { savedViewsApi } from "~/services/saved-views";
import type { Email } from "~/types";
import type { SavedViewDefinition } from "../../shared/saved-views.ts";

const savedViewKeys = {
  list: (mailboxId: string) => ["saved-views", mailboxId] as const,
  use: (mailboxId: string, viewId: string) =>
    ["saved-views", mailboxId, "use", viewId] as const,
  results: (
    mailboxId: string,
    viewId: string,
    paramsKey: string,
    page: number,
  ) => ["saved-view-results", mailboxId, viewId, paramsKey, page] as const,
};

export function useSavedViews(mailboxId: string | undefined) {
  return useQuery({
    queryKey: mailboxId
      ? savedViewKeys.list(mailboxId)
      : ["saved-views", "disabled"],
    queryFn: async () => (await savedViewsApi.list(mailboxId!)).views,
    enabled: Boolean(mailboxId),
  });
}

export function useSavedView(
  mailboxId: string | undefined,
  viewId: string | undefined,
) {
  return useQuery({
    queryKey:
      mailboxId && viewId
        ? savedViewKeys.use(mailboxId, viewId)
        : ["saved-views", "disabled-use"],
    queryFn: () => savedViewsApi.use(mailboxId!, viewId!),
    enabled: Boolean(mailboxId && viewId),
    staleTime: 0,
  });
}

function useInvalidateSavedViews() {
  const queryClient = useQueryClient();
  return (mailboxId: string) =>
    queryClient.invalidateQueries({ queryKey: savedViewKeys.list(mailboxId) });
}

export function useCreateSavedView() {
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: ({
      mailboxId,
      definition,
    }: {
      mailboxId: string;
      definition: SavedViewDefinition;
    }) => savedViewsApi.create(mailboxId, definition),
    onSuccess: (_view, { mailboxId }) => invalidate(mailboxId),
  });
}

export function useUpdateSavedView() {
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: ({
      mailboxId,
      viewId,
      definition,
    }: {
      mailboxId: string;
      viewId: string;
      definition: SavedViewDefinition;
    }) => savedViewsApi.update(mailboxId, viewId, definition),
    onSuccess: (_view, { mailboxId }) => invalidate(mailboxId),
  });
}

export function useDeleteSavedView() {
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: ({
      mailboxId,
      viewId,
    }: {
      mailboxId: string;
      viewId: string;
    }) => savedViewsApi.delete(mailboxId, viewId),
    onSuccess: (_view, { mailboxId }) => invalidate(mailboxId),
  });
}

export function useSavedViewEmails(input: {
  mailboxId: string | undefined;
  viewId: string | undefined;
  searchParams: Record<string, string> | undefined;
  page: number;
  limit: number;
}) {
  const paramsKey = JSON.stringify(input.searchParams ?? {});
  return useQuery<{ emails: Email[]; totalCount: number }>({
    queryKey:
      input.mailboxId && input.viewId
        ? savedViewKeys.results(
            input.mailboxId,
            input.viewId,
            paramsKey,
            input.page,
          )
        : ["saved-view-results", "disabled"],
    queryFn: async () => {
      const data = await api.searchEmails(input.mailboxId!, {
        ...input.searchParams,
        page: String(input.page),
        limit: String(input.limit),
      });
      if (data && typeof data === "object" && "emails" in data) {
        return {
          emails: (data as { emails: Email[] }).emails ?? [],
          totalCount: (data as { totalCount?: number }).totalCount ?? 0,
        };
      }
      const emails = Array.isArray(data) ? data : [];
      return { emails, totalCount: emails.length };
    },
    enabled: Boolean(input.mailboxId && input.viewId && input.searchParams),
  });
}
