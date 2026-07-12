import {
	useQuery,
	type QueryClient,
} from "@tanstack/react-query";
import { fetchTodayBrief } from "../services/today-brief.ts";

export const todayBriefKeys = {
	all: ["today-brief"] as const,
	mailbox: (mailboxId: string) => ["today-brief", mailboxId] as const,
	detail: (mailboxId: string, timeZone: string) =>
		["today-brief", mailboxId, timeZone] as const,
};

export function useTodayBrief(
	mailboxId: string | undefined,
	timeZone: string,
	deterministicTodayIsReady: boolean,
) {
	return useQuery({
		queryKey: mailboxId
			? todayBriefKeys.detail(mailboxId, timeZone)
			: ["today-brief", "disabled", timeZone],
		queryFn: ({ signal }) =>
			fetchTodayBrief(mailboxId!, { timeZone }, fetch, signal),
		enabled: Boolean(mailboxId && timeZone && deterministicTodayIsReady),
		staleTime: 0,
		refetchInterval: (query) =>
			query.state.data?.state === "preparing" ? 3_000 : false,
		retry: 1,
	});
}

export function invalidateTodayBrief(
	queryClient: QueryClient,
	mailboxId: string,
) {
	return queryClient.invalidateQueries({
		queryKey: todayBriefKeys.mailbox(mailboxId),
	});
}
