import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { SnoozeScope } from "../../shared/snooze";

function useInvalidateSnoozeState() {
	const queryClient = useQueryClient();
	return (mailboxId: string) => {
		queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
		queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] });
		queryClient.invalidateQueries({ queryKey: ["search", mailboxId] });
	};
}

export function useSnooze() {
	const invalidate = useInvalidateSnoozeState();
	return useMutation({
		mutationFn: ({ mailboxId, scope, wakeAt }: {
			mailboxId: string;
			scope: SnoozeScope;
			wakeAt: string;
		}) => api.snooze(mailboxId, scope, wakeAt),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUnsnooze() {
	const invalidate = useInvalidateSnoozeState();
	return useMutation({
		mutationFn: ({ mailboxId, scope }: {
			mailboxId: string;
			scope: SnoozeScope;
		}) => api.unsnooze(mailboxId, scope),
		onSuccess: (_result, { mailboxId }) => invalidate(mailboxId),
	});
}
