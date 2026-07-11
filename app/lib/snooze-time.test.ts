import assert from "node:assert/strict";
import test from "node:test";
import {
	SnoozeTimeError,
	customLocalSnoozeTime,
	snoozePresetTime,
} from "./snooze-time.ts";

test("snooze presets produce future local times with stable business-hour semantics", () => {
	const morning = new Date(2026, 6, 11, 10, 0, 0, 0);
	const laterToday = snoozePresetTime("later_today", morning);
	assert.equal(laterToday.getHours(), 18);
	assert.equal(laterToday.getDate(), 11);

	const evening = new Date(2026, 6, 11, 19, 0, 0, 0);
	const safeTomorrow = snoozePresetTime("later_today", evening);
	assert.equal(safeTomorrow.getDate(), 12);
	assert.equal(safeTomorrow.getHours(), 8);

	const tomorrow = snoozePresetTime("tomorrow", morning);
	assert.equal(tomorrow.getDate(), 12);
	assert.equal(tomorrow.getHours(), 8);

	const monday = snoozePresetTime("next_week", morning);
	assert.equal(monday.getDay(), 1);
	assert.equal(monday.getHours(), 8);
});

test("custom datetime-local values are interpreted locally and bounded", () => {
	const now = new Date(2026, 6, 11, 10, 0, 0, 0);
	const custom = customLocalSnoozeTime("2026-07-11T15:30", now);
	assert.equal(custom.getFullYear(), 2026);
	assert.equal(custom.getMonth(), 6);
	assert.equal(custom.getDate(), 11);
	assert.equal(custom.getHours(), 15);
	assert.equal(custom.getMinutes(), 30);
	for (const value of ["", "invalid", "2026-07-11T10:00", "2027-07-12T10:00"]) {
		assert.throws(() => customLocalSnoozeTime(value, now), SnoozeTimeError);
	}
});
