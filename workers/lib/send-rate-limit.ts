export function mailboxSendCutoffs(nowMs = Date.now()): {
	hour: string;
	day: string;
} {
	return {
		hour: new Date(nowMs - 60 * 60_000).toISOString(),
		day: new Date(nowMs - 24 * 60 * 60_000).toISOString(),
	};
}
