import assert from "node:assert/strict";
import test from "node:test";
import { finalizeCommittedOutboundMutation } from "./outbound-liveness.ts";

test("a committed outbound mutation rearms delivery before noncritical activity", async () => {
	const calls: string[] = [];
	await finalizeCommittedOutboundMutation({
		async ensureAlarm() { calls.push("alarm"); },
		recordActivity() { calls.push("activity"); },
	});
	assert.deepEqual(calls, ["alarm", "activity"]);
});

test("activity logging failure cannot strand an already rearmed delivery", async () => {
	let alarmed = false;
	await finalizeCommittedOutboundMutation({
		async ensureAlarm() { alarmed = true; },
		recordActivity() { throw new Error("activity unavailable"); },
		logActivityFailure() {},
	});
	assert.equal(alarmed, true);
});

test("alarm failure remains visible so a reconciliation read can retry it", async () => {
	await assert.rejects(
		finalizeCommittedOutboundMutation({
			async ensureAlarm() { throw new Error("alarm unavailable"); },
			recordActivity() {},
		}),
		/alarm unavailable/,
	);
});
