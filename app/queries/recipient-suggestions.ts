import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
	fetchRecipientSuggestions,
} from "../services/recipient-suggestions.ts";

export const RECIPIENT_SUGGESTION_DEBOUNCE_MS = 175;

export const recipientSuggestionKeys = {
	list: (mailboxId: string, token: string, limit: number) =>
		["recipient-suggestions", mailboxId, token, limit] as const,
};

type RecipientSuggestionRequest = typeof fetchRecipientSuggestions;

export function recipientSuggestionQueryOptions(
	mailboxId: string,
	token: string,
	enabled: boolean,
	limit = 10,
	request: RecipientSuggestionRequest = fetchRecipientSuggestions,
) {
	return {
		queryKey: recipientSuggestionKeys.list(mailboxId, token, limit),
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			request(mailboxId, token, limit, signal),
		enabled: enabled && Boolean(mailboxId),
		staleTime: 0,
		retry: 1,
	};
}

export function useDebouncedRecipientToken(
	token: string,
	focused: boolean,
	scope: string,
) {
	const [state, setState] = useState({ token: "", scope: "", ready: false });
	useEffect(() => {
		if (!focused) {
			setState({ token: "", scope, ready: false });
			return;
		}
		setState((current) => ({ ...current, ready: false }));
		const timeout = window.setTimeout(() => {
			setState({ token, scope, ready: true });
		}, RECIPIENT_SUGGESTION_DEBOUNCE_MS);
		return () => window.clearTimeout(timeout);
	}, [focused, scope, token]);
	return {
		debouncedToken: state.token,
		ready: state.ready && state.token === token && state.scope === scope,
	};
}

export function useRecipientSuggestions(
	mailboxId: string,
	focusedToken: string,
	focused: boolean,
	limit = 10,
	scope = mailboxId,
) {
	const debounce = useDebouncedRecipientToken(focusedToken, focused, scope);
	const query = useQuery(
		recipientSuggestionQueryOptions(
			mailboxId,
			debounce.debouncedToken,
			focused && debounce.ready,
			limit,
		),
	);
	return { ...query, ...debounce };
}
