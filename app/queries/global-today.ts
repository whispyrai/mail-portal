import { useQuery } from "@tanstack/react-query";
import { getGlobalToday } from "../services/global-today.ts";
import { ApiError } from "../services/api.ts";

export const globalTodayKeys = {
	all: ["global-today"] as const,
	detail: (timeZone: string) => ["global-today", timeZone] as const,
};

export function shouldRetryGlobalToday(failureCount: number, error: unknown) {
	if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
	return failureCount < 1;
}

export function useGlobalToday(timeZone: string) {
	return useQuery({
		queryKey: globalTodayKeys.detail(timeZone),
		queryFn: ({ signal }) => getGlobalToday({ timeZone, signal }),
		enabled: Boolean(timeZone),
		staleTime: 30_000,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		retry: shouldRetryGlobalToday,
	});
}
