import assert from "node:assert/strict";
import test from "node:test";
import {
	MIN_SCHEDULE_LEAD_MS,
	SEND_UNDO_WINDOW_MS,
	outboundScheduleHorizon,
	validateOutboundSchedule,
} from "../../shared/outbound-schedule.ts";

const NOW = new Date("2026-07-11T12:00:00.000Z");

test("immediate mail keeps the normal undo window", () => {
	assert.deepEqual(validateOutboundSchedule(undefined, NOW), {
		ok: true,
		requestedAt: NOW.toISOString(),
		undoUntil: new Date(NOW.getTime() + SEND_UNDO_WINDOW_MS).toISOString(),
	});
});

test("scheduled mail must retain a one-minute lead at authoritative enqueue time", () => {
	const valid = new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS).toISOString();
	assert.deepEqual(validateOutboundSchedule(valid, NOW), {
		ok: true,
		requestedAt: NOW.toISOString(),
		undoUntil: NOW.toISOString(),
		scheduledFor: valid,
	});

	for (const stale of [
		"2000-01-01T00:00:00.000Z",
		new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS - 1).toISOString(),
	]) {
		const result = validateOutboundSchedule(stale, NOW);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /at least one minute/i);
	}
});

test("scheduled mail cannot exceed one calendar year", () => {
	const horizon = outboundScheduleHorizon(NOW);
	assert.equal(validateOutboundSchedule(horizon.toISOString(), NOW).ok, true);
	const distant = validateOutboundSchedule(
		new Date(horizon.getTime() + 1).toISOString(),
		NOW,
	);
	assert.equal(distant.ok, false);
	if (!distant.ok) assert.match(distant.error, /one year/i);
});
