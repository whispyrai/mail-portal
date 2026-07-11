export async function finalizeCommittedOutboundMutation(input: {
	ensureAlarm: () => Promise<void>;
	recordActivity: () => void;
	logActivityFailure?: (error: unknown) => void;
}): Promise<void> {
	await input.ensureAlarm();
	try {
		input.recordActivity();
	} catch (error) {
		if (input.logActivityFailure) input.logActivityFailure(error);
		else console.error(
			"[outbound] activity logging failed after durable mutation",
			error,
		);
	}
}
