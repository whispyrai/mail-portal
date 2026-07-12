export type AiSearchInterpreterSnapshot = {
	mailboxId: string;
	intent: string;
	timezone: string;
};

export type ActiveAiSearchInterpreterRequest = AiSearchInterpreterSnapshot & {
	requestToken: number;
	controller: AbortController;
};

function snapshotsEqual(
	request: AiSearchInterpreterSnapshot,
	snapshot: AiSearchInterpreterSnapshot,
): boolean {
	return request.mailboxId === snapshot.mailboxId &&
		request.intent === snapshot.intent &&
		request.timezone === snapshot.timezone;
}

export function createAiSearchInterpreterRequestController() {
	let nextRequestToken = 0;
	let active: ActiveAiSearchInterpreterRequest | null = null;
	return {
		begin(
			snapshot: AiSearchInterpreterSnapshot,
		): ActiveAiSearchInterpreterRequest | null {
			if (active) return null;
			active = {
				...snapshot,
				requestToken: ++nextRequestToken,
				controller: new AbortController(),
			};
			return active;
		},
		isCurrent(
			request: ActiveAiSearchInterpreterRequest,
			snapshot: AiSearchInterpreterSnapshot,
		): boolean {
			return active?.requestToken === request.requestToken &&
				!request.controller.signal.aborted &&
				snapshotsEqual(request, snapshot);
		},
		finish(request: ActiveAiSearchInterpreterRequest): boolean {
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
