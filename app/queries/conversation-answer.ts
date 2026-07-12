import { useMutation } from "@tanstack/react-query";
import {
	fetchConversationAnswer,
	type ConversationAnswerResponse,
} from "../services/conversation-answer.ts";

export type ConversationAnswerVariables = {
	mailboxId: string;
	emailId: string;
	question: string;
	signal: AbortSignal;
	requestToken: number;
};

type ConversationAnswerRequest = (
	mailboxId: string,
	emailId: string,
	question: string,
	signal: AbortSignal,
) => Promise<ConversationAnswerResponse>;

export function isCurrentConversationAnswerRequest(
	request: Pick<
		ConversationAnswerVariables,
		"mailboxId" | "emailId" | "requestToken"
	>,
	mailboxId: string,
	emailId: string,
	requestToken: number,
): boolean {
	return (
		request.mailboxId === mailboxId &&
		request.emailId === emailId &&
		request.requestToken === requestToken
	);
}

export function buildConversationAnswerMutationOptions(
	request: ConversationAnswerRequest = fetchConversationAnswer,
) {
	return {
		mutationKey: ["conversation-answer"] as const,
		mutationFn: (variables: ConversationAnswerVariables) =>
			request(
				variables.mailboxId,
				variables.emailId,
				variables.question,
				variables.signal,
			),
		retry: false,
	};
}

export function useConversationAnswer() {
	return useMutation(buildConversationAnswerMutationOptions());
}
