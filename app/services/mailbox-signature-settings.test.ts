import assert from "node:assert/strict";
import test from "node:test";
import { getMailboxSignatureSettings, updateMailboxSignature } from "./mailbox-signature-settings.ts";

test("typed signature client uses narrow encoded settings routes and forwards cancellation", async () => {
	const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response(JSON.stringify({ signature: { enabled: true, text: "Team" }, canManage: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	};
	const signal = new AbortController().signal;
	await getMailboxSignatureSettings("team+sales@example.com", signal, fetcher);
	await updateMailboxSignature("team+sales@example.com", { enabled: false, text: "Off" }, fetcher);
	assert.equal(calls[0]?.input, "/api/v1/mailboxes/team%2Bsales%40example.com/settings");
	assert.equal(calls[0]?.init?.signal, signal);
	assert.equal(calls[1]?.input, "/api/v1/mailboxes/team%2Bsales%40example.com/settings/signature");
	assert.equal(calls[1]?.init?.method, "PATCH");
	assert.equal(calls[1]?.init?.body, JSON.stringify({ enabled: false, text: "Off" }));
});
