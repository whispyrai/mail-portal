import { useMutation } from "@tanstack/react-query";
import type { AiSearchInterpreterRequest } from "../../shared/ai-search-interpreter.ts";
import {
	fetchAiSearchInterpretation,
	type AiSearchInterpreterResponse,
} from "../services/ai-search-interpreter.ts";

export type AiSearchInterpreterVariables = {
	mailboxId: string;
	request: AiSearchInterpreterRequest;
	signal: AbortSignal;
	requestToken: number;
};

type AiSearchInterpreterFetch = (
	mailboxId: string,
	request: AiSearchInterpreterRequest,
	signal: AbortSignal,
) => Promise<AiSearchInterpreterResponse>;

export function buildAiSearchInterpreterMutationOptions(
	interpret: AiSearchInterpreterFetch = fetchAiSearchInterpretation,
) {
	return {
		mutationKey: ["ai-search-interpreter"] as const,
		mutationFn: (variables: AiSearchInterpreterVariables) =>
			interpret(variables.mailboxId, variables.request, variables.signal),
		retry: false,
	};
}

export function useAiSearchInterpreter() {
	return useMutation(buildAiSearchInterpreterMutationOptions());
}
