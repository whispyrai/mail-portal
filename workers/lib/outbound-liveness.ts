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
		else
			console.error(
			"[outbound] activity logging failed after durable mutation",
			error,
		);
	}
}

export type OutboundAlarmFailureObservation = {
	stage: "process" | "rearm";
	error: unknown;
};

export async function runOutboundAlarmLane(input: {
	process: () => Promise<void>;
	ensureAlarm: () => Promise<void>;
	logFailure: (observation: OutboundAlarmFailureObservation) => void;
}): Promise<void> {
	try {
		await input.process();
	} catch (error) {
		input.logFailure({ stage: "process", error });
	} finally {
		try {
			await input.ensureAlarm();
		} catch (error) {
			input.logFailure({ stage: "rearm", error });
			throw error;
		}
	}
}
