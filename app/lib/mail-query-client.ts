import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../services/api.ts";

export function createMailQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
			mutations: {
				// TanStack's default "online" mode pauses offline mutations and replays
				// them later. Mail writes must instead fail immediately and never queue.
				networkMode: "always",
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}
