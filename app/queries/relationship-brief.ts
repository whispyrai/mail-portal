import {
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
	fetchRelationshipBrief,
	RelationshipBriefApiError,
	type RelationshipBriefRequest,
	type RelationshipBriefResponse,
} from "../services/relationship-brief.ts";

export function relationshipBriefKey(mailboxId: string, personId: string) {
	// Browser query state is scoped to the authenticated document session; the
	// server additionally keys storage by actor. A separate root keeps paid AI
	// out of deterministic People invalidation, while mailboxId as the second
	// key element lets
	// the synchronous revoked-Mailbox purge remove it.
	return ["relationship-brief", mailboxId, personId] as const;
}

export type RelationshipBriefVariables = {
	mailboxId: string;
	personId: string;
	refresh: boolean;
	attemptId: number;
	signal: AbortSignal;
};

type RelationshipBriefRequestFn = (
	mailboxId: string,
	personId: string,
	input: RelationshipBriefRequest,
	signal?: AbortSignal,
) => Promise<RelationshipBriefResponse>;

function requestRelationshipBrief(
	mailboxId: string,
	personId: string,
	input: RelationshipBriefRequest,
	signal?: AbortSignal,
) {
	return fetchRelationshipBrief(mailboxId, personId, input, fetch, signal);
}

export function isCurrentRelationshipBriefRequest(
	variables: RelationshipBriefVariables | undefined,
	mailboxId: string,
	personId: string,
): boolean {
	return variables?.mailboxId === mailboxId && variables.personId === personId;
}

export function buildRelationshipBriefMutationOptions(
	queryClient: QueryClient,
	request: RelationshipBriefRequestFn = requestRelationshipBrief,
	isAttemptActive: (variables: RelationshipBriefVariables) => boolean = () => true,
	onAccessRevoked?: (mailboxId: string, active: boolean) => void,
) {
	return {
		mutationKey: ["relationship-brief", "manual-request"] as const,
		// Once the observing Person surface unmounts, retain no second copy of
		// cited AI output in the mutation cache. The mailbox query cache remains
		// the single display authority and is purged synchronously on revocation.
		gcTime: 0,
		mutationFn: async (variables: RelationshipBriefVariables) => {
			try {
				return await request(
					variables.mailboxId,
					variables.personId,
					{ refresh: variables.refresh },
					variables.signal,
				);
			} catch (error) {
				if (error instanceof RelationshipBriefApiError && error.status === 403) {
					// Do not wait for a refetch or cache invalidation before replacing the
					// active revoked surface. An inactive attempt still purges its origin
					// mailbox, but cannot navigate the currently selected mailbox.
					onAccessRevoked?.(variables.mailboxId, isAttemptActive(variables));
				}
				throw error;
			}
		},
		onSuccess: (
			response: RelationshipBriefResponse,
			variables: RelationshipBriefVariables,
		) => {
			if (!isAttemptActive(variables)) return;
			queryClient.setQueryData(
				relationshipBriefKey(variables.mailboxId, variables.personId),
				response,
			);
		},
	};
}

export function useRelationshipBrief(
	mailboxId: string,
	personId: string,
	onAccessRevoked: (mailboxId: string, active: boolean) => void,
) {
	const queryClient = useQueryClient();
	const nextAttemptId = useRef(0);
	const activeAttempt = useRef<{
		mailboxId: string;
		personId: string;
		attemptId: number;
		controller: AbortController;
	} | null>(null);
	const cached = useQuery<RelationshipBriefResponse>({
		queryKey: relationshipBriefKey(mailboxId, personId),
		queryFn: skipToken,
		staleTime: Infinity,
	});
	const isAttemptActive = useCallback((variables: RelationshipBriefVariables) => {
		const active = activeAttempt.current;
		return Boolean(
			active &&
			active.mailboxId === variables.mailboxId &&
			active.personId === variables.personId &&
			active.attemptId === variables.attemptId &&
			!variables.signal.aborted,
		);
	}, []);
	const mutation = useMutation(
		buildRelationshipBriefMutationOptions(
			queryClient,
			requestRelationshipBrief,
			isAttemptActive,
			onAccessRevoked,
		),
	);

	useEffect(() => {
		return () => {
			const active = activeAttempt.current;
			if (active?.mailboxId === mailboxId && active.personId === personId) {
				active.controller.abort();
				activeAttempt.current = null;
			}
		};
	}, [mailboxId, personId]);

	const current = isCurrentRelationshipBriefRequest(
		mutation.variables,
		mailboxId,
		personId,
	) && Boolean(mutation.variables && !mutation.variables.signal.aborted);

	return {
		data: cached.data,
		request: (refresh: boolean) => {
			activeAttempt.current?.controller.abort();
			const controller = new AbortController();
			nextAttemptId.current += 1;
			const variables: RelationshipBriefVariables = {
				mailboxId,
				personId,
				refresh,
				attemptId: nextAttemptId.current,
				signal: controller.signal,
			};
			activeAttempt.current = { ...variables, controller };
			return mutation.mutateAsync(variables).finally(() => {
				if (activeAttempt.current?.attemptId === variables.attemptId) {
					activeAttempt.current = null;
				}
			});
		},
		isLoading: mutation.isPending && current,
		error: current ? mutation.error : null,
	};
}
