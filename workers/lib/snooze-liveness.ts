/** Alarm arming follows a committed Snooze mutation and must never change its result. */
export async function finalizeCommittedSnooze(input: {
	ensureAlarm(): Promise<void>;
	logFailure(error: unknown): void;
}): Promise<void> {
	try {
		await input.ensureAlarm();
	} catch (error) {
		input.logFailure(error);
	}
}
