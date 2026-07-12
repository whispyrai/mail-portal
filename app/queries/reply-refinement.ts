import { useMutation } from "@tanstack/react-query";
import type { ReplyRefinementRequest } from "../../shared/reply-refinement.ts";
import {
	fetchReplyRefinement,
	type ReplyRefinementResponse,
} from "../services/reply-refinement.ts";

export type ReplyRefinementVariables = {
	mailboxId: string;
	sourceEmailId: string;
	request: ReplyRefinementRequest;
	signal: AbortSignal;
	requestToken: number;
};

type ReplyRefinementFetch = (
	mailboxId: string,
	sourceEmailId: string,
	request: ReplyRefinementRequest,
	signal: AbortSignal,
) => Promise<ReplyRefinementResponse>;

export function buildReplyRefinementMutationOptions(
	requestReplyRefinement: ReplyRefinementFetch = fetchReplyRefinement,
) {
	return {
		mutationKey: ["reply-refinement"] as const,
		mutationFn: (variables: ReplyRefinementVariables) =>
			requestReplyRefinement(
				variables.mailboxId,
				variables.sourceEmailId,
				variables.request,
				variables.signal,
			),
		retry: false,
	};
}

export function useReplyRefinement() {
	return useMutation(buildReplyRefinementMutationOptions());
}
