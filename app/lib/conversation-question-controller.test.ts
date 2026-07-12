import assert from "node:assert/strict";
import test from "node:test";
import { createConversationQuestionRequestController } from "./conversation-question-controller.ts";

const firstSelection = {
	mailboxId: "team@example.com",
	emailId: "message-1",
};

test("question requests exclude same-tick duplicates and clear only their own flight", () => {
	const requests = createConversationQuestionRequestController();
	const first = requests.begin(firstSelection);
	assert.ok(first);
	assert.equal(requests.begin(firstSelection), null);
	assert.equal(requests.isCurrent(first, firstSelection), true);

	requests.finish(first);
	const second = requests.begin(firstSelection);
	assert.ok(second);
	assert.notEqual(second.requestToken, first.requestToken);
	requests.finish(first);
	assert.equal(requests.isCurrent(second, firstSelection), true);
});

test("cancel aborts the active fetch and makes a late response stale", () => {
	const requests = createConversationQuestionRequestController();
	const request = requests.begin(firstSelection);
	assert.ok(request);
	requests.cancel();
	assert.equal(request.controller.signal.aborted, true);
	assert.equal(requests.isCurrent(request, firstSelection), false);
	assert.ok(requests.begin(firstSelection));
});

test("mailbox or message navigation makes the old response non-current", () => {
	const requests = createConversationQuestionRequestController();
	const request = requests.begin(firstSelection);
	assert.ok(request);
	assert.equal(
		requests.isCurrent(request, {
			mailboxId: "other@example.com",
			emailId: "message-1",
		}),
		false,
	);
	assert.equal(
		requests.isCurrent(request, {
			mailboxId: "team@example.com",
			emailId: "message-2",
		}),
		false,
	);
});
