import assert from "node:assert/strict";
import test from "node:test";
import api from "./api.ts";

test("conversation moves send the stable representative Message anchor", async () => {
	const requests: Array<{ url: string; body: unknown }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({
			url: String(input),
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return new Response(JSON.stringify({ status: "archived", affectedCount: 0 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	try {
		await api.archiveConversation(
			"team@example.com",
			"thread/one",
			"inbox",
			"message-2",
		);
		await api.trashConversation(
			"team@example.com",
			"thread/one",
			"sent",
			"message-2",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(requests, [
		{
			url: "/api/v1/mailboxes/team@example.com/conversations/thread%2Fone/archive",
			body: { folderId: "inbox", representativeEmailId: "message-2" },
		},
		{
			url: "/api/v1/mailboxes/team@example.com/conversations/thread%2Fone/trash",
			body: { folderId: "sent", representativeEmailId: "message-2" },
		},
	]);
});
