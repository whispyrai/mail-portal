import assert from "node:assert/strict";
import test from "node:test";
import {
	finalizeCommittedOutboundMutation,
	runOutboundAlarmLane,
} from "./outbound-liveness.ts";

test("a committed outbound mutation rearms delivery before noncritical activity", async () => {
	const calls: string[] = [];
	await finalizeCommittedOutboundMutation({
		async ensureAlarm() {
			calls.push("alarm");
		},
		recordActivity() {
			calls.push("activity");
		},
	});
	assert.deepEqual(calls, ["alarm", "activity"]);
});

test("activity logging failure cannot strand an already rearmed delivery", async () => {
	let alarmed = false;
	await finalizeCommittedOutboundMutation({
		async ensureAlarm() {
			alarmed = true;
		},
		recordActivity() {
			throw new Error("activity unavailable");
		},
		logActivityFailure() {},
	});
	assert.equal(alarmed, true);
});

test("alarm failure remains visible so a reconciliation read can retry it", async () => {
	await assert.rejects(
		finalizeCommittedOutboundMutation({
			async ensureAlarm() {
				throw new Error("alarm unavailable");
			},
			recordActivity() {},
		}),
		/alarm unavailable/,
	);
});

test("an outbound alarm processing failure is isolated after durable rearm", async () => {
	const stages: string[] = [];
	let rearmed = 0;
	await runOutboundAlarmLane({
		async process() {
			throw new Error("provider unavailable");
		},
		async ensureAlarm() {
			rearmed += 1;
		},
		logFailure(observation) {
			stages.push(observation.stage);
		},
	});
	assert.equal(rearmed, 1);
	assert.deepEqual(stages, ["process"]);
});

test("outbound alarm rearm failure stays visible to Cloudflare", async () => {
	const stages: string[] = [];
	await assert.rejects(
		runOutboundAlarmLane({
			async process() {},
			async ensureAlarm() {
				throw new Error("alarm unavailable");
			},
			logFailure(observation) {
				stages.push(observation.stage);
			},
		}),
		/alarm unavailable/,
	);
	assert.deepEqual(stages, ["rearm"]);
});

test("outbound alarm rearm failure wins after a processing failure", async () => {
	const stages: string[] = [];
	await assert.rejects(
		runOutboundAlarmLane({
			async process() {
				throw new Error("process unavailable");
			},
			async ensureAlarm() {
				throw new Error("rearm unavailable");
			},
			logFailure(observation) {
				stages.push(observation.stage);
			},
		}),
		/rearm unavailable/,
	);
	assert.deepEqual(stages, ["process", "rearm"]);
});

test("a successful outbound alarm pass rearms exactly once", async () => {
	let processed = 0;
	let rearmed = 0;
	await runOutboundAlarmLane({
		async process() {
			processed += 1;
		},
		async ensureAlarm() {
			rearmed += 1;
		},
		logFailure() {
			assert.fail("successful lane must not log a failure");
		},
	});
	assert.equal(processed, 1);
	assert.equal(rearmed, 1);
});
