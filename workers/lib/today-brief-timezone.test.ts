import assert from "node:assert/strict";
import test from "node:test";
import { resolveTodayBriefDay } from "./today-brief-timezone.ts";

test("resolves the caller's local calendar day instead of the Worker day", () => {
	const day = resolveTodayBriefDay(
		"Africa/Cairo",
		Date.parse("2026-07-11T22:30:00.000Z"),
	);
	assert.deepEqual(day, {
		timeZone: "Africa/Cairo",
		localDate: "2026-07-12",
		startAt: "2026-07-11T21:00:00.000Z",
		endAt: "2026-07-12T21:00:00.000Z",
	});
});

test("handles short and long daylight-saving calendar days", () => {
	const spring = resolveTodayBriefDay(
		"America/New_York",
		Date.parse("2026-03-08T12:00:00.000Z"),
	);
	assert.equal(spring.localDate, "2026-03-08");
	assert.equal(
		Date.parse(spring.endAt) - Date.parse(spring.startAt),
		23 * 60 * 60 * 1_000,
	);

	const fall = resolveTodayBriefDay(
		"America/New_York",
		Date.parse("2026-11-01T12:00:00.000Z"),
	);
	assert.equal(fall.localDate, "2026-11-01");
	assert.equal(
		Date.parse(fall.endAt) - Date.parse(fall.startAt),
		25 * 60 * 60 * 1_000,
	);
});

test("rejects invalid or oversized time zone identifiers", () => {
	assert.throws(() => resolveTodayBriefDay("Mars/Olympus_Mons"), /valid time zone/);
	assert.throws(() => resolveTodayBriefDay("x".repeat(101)), /valid time zone/);
});
