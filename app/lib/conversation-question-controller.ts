export type ConversationQuestionSelection = {
	mailboxId: string;
	emailId: string;
};

export type ActiveConversationQuestionRequest =
	ConversationQuestionSelection & {
		requestToken: number;
		controller: AbortController;
	};

export function createConversationQuestionRequestController() {
	let nextRequestToken = 0;
	let active: ActiveConversationQuestionRequest | null = null;

	return {
		begin(
			selection: ConversationQuestionSelection,
		): ActiveConversationQuestionRequest | null {
			if (active) return null;
			active = {
				...selection,
				requestToken: ++nextRequestToken,
				controller: new AbortController(),
			};
			return active;
		},
		isCurrent(
			request: ActiveConversationQuestionRequest,
			selection: ConversationQuestionSelection,
		): boolean {
			return (
				active?.requestToken === request.requestToken &&
				request.mailboxId === selection.mailboxId &&
				request.emailId === selection.emailId &&
				!request.controller.signal.aborted
			);
		},
		finish(request: ActiveConversationQuestionRequest): void {
			if (active?.requestToken === request.requestToken) active = null;
		},
		cancel(): void {
			active?.controller.abort();
			active = null;
		},
	};
}
