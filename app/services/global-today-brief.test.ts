import assert from "node:assert/strict";
import test from "node:test";
import { getGlobalTodayBrief } from "./global-today-brief.ts";

test("aggregate Today brief sends only timezone and explicit Refresh intent", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return Response.json({ state: "no_attention", counts: { privateRemindersDue: 0, unreadConversations: 0 }, omittedCount: 0 });
	};
	try {
		await getGlobalTodayBrief({ timeZone: "Africa/Cairo" });
		await getGlobalTodayBrief({ timeZone: "Africa/Cairo", refresh: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(requests[0]?.url, "/api/v1/today/brief");
	assert.equal(requests[0]?.init?.credentials, "same-origin");
	assert.equal(requests[0]?.init?.cache, "no-store");
	assert.equal(requests[0]?.init?.body, JSON.stringify({ timeZone: "Africa/Cairo" }));
	assert.equal(requests[1]?.init?.body, JSON.stringify({ timeZone: "Africa/Cairo", refresh: true }));
});
