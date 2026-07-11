import assert from "node:assert/strict";
import test from "node:test";
import { finalizeCommittedSnooze } from "./snooze-liveness.ts";

test("committed Snooze survives alarm failure and a later self-heal can retry", async () => {
	let attempts = 0;
	const errors: string[] = [];
	const ensureAlarm = async () => {
		attempts++;
		if (attempts === 1) throw new Error("alarm unavailable");
	};
	await finalizeCommittedSnooze({
		ensureAlarm,
		logFailure: (error) => errors.push((error as Error).message),
	});
	assert.equal(attempts, 1);
	assert.deepEqual(errors, ["alarm unavailable"]);
	await finalizeCommittedSnooze({ ensureAlarm, logFailure: () => assert.fail() });
	assert.equal(attempts, 2);
});
