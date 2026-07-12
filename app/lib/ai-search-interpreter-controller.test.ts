import assert from "node:assert/strict";
import test from "node:test";
import { createAiSearchInterpreterRequestController } from "./ai-search-interpreter-controller.ts";

test("AI search request ownership rejects late input and mailbox responses", () => {
	const requests = createAiSearchInterpreterRequestController();
	const snapshot = {
		mailboxId: "team@example.com",
		intent: "unread renewal mail",
		timezone: "Africa/Cairo",
	};
	const request = requests.begin(snapshot);
	assert.ok(request);
	assert.equal(requests.isCurrent(request, snapshot), true);
	assert.equal(requests.isCurrent(request, { ...snapshot, intent: "new intent" }), false);
	assert.equal(requests.isCurrent(request, { ...snapshot, mailboxId: "other@example.com" }), false);
	requests.cancel();
	assert.equal(request.controller.signal.aborted, true);
	assert.equal(requests.isCurrent(request, snapshot), false);
});
