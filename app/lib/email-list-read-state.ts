export type EmailListReadContent = "loading" | "initial-error" | "resolved";

export interface EmailListReadState {
	content: EmailListReadContent;
	showRefreshError: boolean;
}

export function resolveEmailListReadState({
	hasResolvedData,
	isError,
}: {
	hasResolvedData: boolean;
	isError: boolean;
}): EmailListReadState {
	if (!hasResolvedData) {
		return {
			content: isError ? "initial-error" : "loading",
			showRefreshError: false,
		};
	}

	return {
		content: "resolved",
		showRefreshError: isError,
	};
}

export function resolveEmailListRefetchInterval({
	isError,
	interval,
}: {
	isError: boolean;
	interval: number | undefined;
}): number | false | undefined {
	return isError ? false : interval;
}
