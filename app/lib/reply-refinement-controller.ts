import type { ReplyRefinementMode } from "../../shared/reply-refinement.ts";

export type ReplyRefinementSnapshot = {
	mailboxId: string;
	sourceEmailId: string;
	mode: ReplyRefinementMode;
	subject: string;
	body: string;
};

export type ActiveReplyRefinementRequest = ReplyRefinementSnapshot & {
	requestToken: number;
	controller: AbortController;
};

function matchesSnapshot(
	request: ActiveReplyRefinementRequest,
	snapshot: ReplyRefinementSnapshot,
): boolean {
	return (
		request.mailboxId === snapshot.mailboxId &&
		request.sourceEmailId === snapshot.sourceEmailId &&
		request.mode === snapshot.mode &&
		request.subject === snapshot.subject &&
		request.body === snapshot.body
	);
}

export function createReplyRefinementRequestController() {
	let nextRequestToken = 0;
	let active: ActiveReplyRefinementRequest | null = null;

	return {
		begin(
			snapshot: ReplyRefinementSnapshot,
		): ActiveReplyRefinementRequest | null {
			if (active) return null;
			active = {
				...snapshot,
				requestToken: ++nextRequestToken,
				controller: new AbortController(),
			};
			return active;
		},
		isCurrent(
			request: ActiveReplyRefinementRequest,
			snapshot: ReplyRefinementSnapshot,
		): boolean {
			return (
				active?.requestToken === request.requestToken &&
				matchesSnapshot(request, snapshot) &&
				!request.controller.signal.aborted
			);
		},
		finish(request: ActiveReplyRefinementRequest): boolean {
			if (active?.requestToken !== request.requestToken) return false;
			active = null;
			return true;
		},
		cancel(): void {
			active?.controller.abort();
			active = null;
		},
	};
}
