import assert from "node:assert/strict";
import test from "node:test";
import { createReplyRefinementRequestController } from "./reply-refinement-controller.ts";

const firstSnapshot = {
	mailboxId: "team@example.com",
	sourceEmailId: "message-1",
	mode: "reply-all" as const,
	subject: "Re: Launch",
	body: "<p>Friday works.</p>",
};

test("reply refinements exclude same-tick duplicates and clear only their own flight", () => {
	const requests = createReplyRefinementRequestController();
	const first = requests.begin(firstSnapshot);
	assert.ok(first);
	assert.equal(requests.begin(firstSnapshot), null);
	assert.equal(requests.isCurrent(first, firstSnapshot), true);

	assert.equal(requests.finish(first), true);
	const second = requests.begin(firstSnapshot);
	assert.ok(second);
	assert.notEqual(second.requestToken, first.requestToken);
	assert.equal(requests.finish(first), false);
	assert.equal(requests.isCurrent(second, firstSnapshot), true);
});

test("cancel aborts the active fetch and makes a late reply stale", () => {
	const requests = createReplyRefinementRequestController();
	const request = requests.begin(firstSnapshot);
	assert.ok(request);
	requests.cancel();
	assert.equal(request.controller.signal.aborted, true);
	assert.equal(requests.isCurrent(request, firstSnapshot), false);
	assert.ok(requests.begin(firstSnapshot));
});

test("every pinned reply snapshot field rejects an old response", () => {
	for (const changedSnapshot of [
		{ ...firstSnapshot, mailboxId: "other@example.com" },
		{ ...firstSnapshot, sourceEmailId: "message-2" },
		{ ...firstSnapshot, mode: "reply" as const },
		{ ...firstSnapshot, subject: "Re: Changed locally" },
		{ ...firstSnapshot, body: "<p>Edited while waiting.</p>" },
	]) {
		const requests = createReplyRefinementRequestController();
		const request = requests.begin(firstSnapshot);
		assert.ok(request);
		assert.equal(requests.isCurrent(request, changedSnapshot), false);
	}
});
