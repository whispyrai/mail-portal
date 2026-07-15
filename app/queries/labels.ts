import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { LabelColor, LabelMutationTarget } from "~/types";
import { queryKeys } from "./keys";

function useInvalidateLabels() {
	const queryClient = useQueryClient();
	return (mailboxId: string) => {
		queryClient.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
		queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
		queryClient.invalidateQueries({ queryKey: ["search", mailboxId] });
	};
}

export function useLabels(mailboxId?: string) {
	return useQuery({
		queryKey: mailboxId ? queryKeys.labels.list(mailboxId) : ["labels", "_disabled"],
		queryFn: async () => (await api.listLabels(mailboxId!)).labels,
		enabled: Boolean(mailboxId),
	});
}

export function useCreateLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({
		mutationFn: ({ mailboxId, name, color,
      operationId,
    }: { mailboxId: string; name: string; color: LabelColor;
      operationId: string;
    }) =>
			api.createLabel(mailboxId, { name, color, operationId }),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
    onError: (error, { mailboxId }) => {
      if (
        error instanceof Error &&
        "body" in error &&
        ["creation_superseded", "creation_unavailable"].includes(
          String((error as { body?: { code?: unknown } }).body?.code),
        )
      )
        invalidate(mailboxId);
},
  });
}

export function useUpdateLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({
		mutationFn: ({ mailboxId, labelId, name, color }: { mailboxId: string; labelId: string; name: string; color: LabelColor }) =>
			api.updateLabel(mailboxId, labelId, { name, color }),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDeleteLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({
		mutationFn: ({ mailboxId, labelId }: { mailboxId: string; labelId: string }) =>
			api.deleteLabel(mailboxId, labelId),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMutateLabels() {
	const invalidate = useInvalidateLabels();
	return useMutation({
		mutationFn: ({ mailboxId, labelId, action, targets }: {
			mailboxId: string;
			labelId: string;
			action: "apply" | "remove";
			targets: LabelMutationTarget[];
		}) => api.mutateLabels(mailboxId, { labelId, action, targets }),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
	});
}
