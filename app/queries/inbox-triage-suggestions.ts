import { useMutation } from "@tanstack/react-query";
import {
	fetchInboxTriageSuggestions,
	type InboxTriageSuggestionRequest,
	type InboxTriageSuggestionsResponse,
} from "../services/inbox-triage-suggestions.ts";

export type InboxTriageSuggestionsVariables = {
	mailboxId: string;
	request: InboxTriageSuggestionRequest;
	signal: AbortSignal;
	requestToken: number;
};

type InboxTriageSuggestionsFetch = (
	mailboxId: string,
	request: InboxTriageSuggestionRequest,
	signal: AbortSignal,
) => Promise<InboxTriageSuggestionsResponse>;

export function buildInboxTriageSuggestionsMutationOptions(
	requestSuggestions: InboxTriageSuggestionsFetch = fetchInboxTriageSuggestions,
) {
	return {
		mutationKey: ["inbox-triage-suggestions"] as const,
		mutationFn: (variables: InboxTriageSuggestionsVariables) =>
			requestSuggestions(
				variables.mailboxId,
				variables.request,
				variables.signal,
			),
		retry: false,
	};
}

export function useInboxTriageSuggestions() {
	return useMutation(buildInboxTriageSuggestionsMutationOptions());
}
