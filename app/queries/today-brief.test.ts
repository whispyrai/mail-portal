import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
	invalidateTodayBrief,
	todayBriefKeys,
} from "./today-brief.ts";

const querySource = readFileSync(new URL("./today-brief.ts", import.meta.url), "utf8");

test("Today brief cache identity isolates mailbox and local timezone", () => {
	assert.notDeepEqual(
		todayBriefKeys.detail("sales@example.com", "Africa/Cairo"),
		todayBriefKeys.detail("support@example.com", "Africa/Cairo"),
	);
	assert.notDeepEqual(
		todayBriefKeys.detail("sales@example.com", "Africa/Cairo"),
		todayBriefKeys.detail("sales@example.com", "Europe/London"),
	);
});

test("only an in-progress distributed brief polls automatically", () => {
	assert.match(querySource, /query\.state\.data\?\.state === "preparing" \? 3_000 : false/);
});

test("Reminder changes invalidate every local-day brief for only the origin mailbox", async () => {
	const queryClient = new QueryClient();
	const cairo = todayBriefKeys.detail("sales@example.com", "Africa/Cairo");
	const london = todayBriefKeys.detail("sales@example.com", "Europe/London");
	const other = todayBriefKeys.detail("support@example.com", "Africa/Cairo");
	queryClient.setQueryData(cairo, { state: "no_attention" });
	queryClient.setQueryData(london, { state: "no_attention" });
	queryClient.setQueryData(other, { state: "no_attention" });

	await invalidateTodayBrief(queryClient, "sales@example.com");

	assert.equal(queryClient.getQueryState(cairo)?.isInvalidated, true);
	assert.equal(queryClient.getQueryState(london)?.isInvalidated, true);
	assert.equal(queryClient.getQueryState(other)?.isInvalidated, false);
});
