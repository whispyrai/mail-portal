import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { globalTodayBriefKeys, markGlobalTodayBriefStale } from "./global-today-brief.ts";

const source = readFileSync(new URL("./global-today-brief.ts", import.meta.url), "utf8");

test("aggregate brief does not continuously regenerate and only preparation polls", () => {
	assert.match(source, /staleTime: Number\.POSITIVE_INFINITY/);
	assert.match(source, /refetchOnWindowFocus: false/);
	assert.match(source, /refetchOnReconnect: false/);
	assert.match(source, /state\.state\.data\?\.state === "preparing" \? 3_000 : false/);
	assert.match(source, /refresh: true/);
});

test("observed deterministic changes discard generated guidance locally", () => {
	const client = new QueryClient();
	const key = globalTodayBriefKeys.detail("Africa/Cairo");
	client.setQueryData(key, {
		state: "generated",
		fingerprint: "fingerprint",
		generatedAt: "2026-07-12T10:00:00.000Z",
		counts: { privateRemindersDue: 1, unreadConversations: 2 },
		omittedCount: 3,
		items: [],
	});
	markGlobalTodayBriefStale(client, "Africa/Cairo");
	assert.deepEqual(client.getQueryData(key), {
		state: "stale",
		counts: { privateRemindersDue: 1, unreadConversations: 2 },
		omittedCount: 3,
	});
});

test("observed deterministic changes also invalidate a previous no-attention conclusion", () => {
	const client = new QueryClient();
	const key = globalTodayBriefKeys.detail("UTC");
	client.setQueryData(key, {
		state: "no_attention",
		counts: { privateRemindersDue: 0, unreadConversations: 0 },
		omittedCount: 0,
	});
	markGlobalTodayBriefStale(client, "UTC");
	assert.deepEqual(client.getQueryData(key), {
		state: "stale",
		counts: { privateRemindersDue: 0, unreadConversations: 0 },
		omittedCount: 0,
	});
});
