import assert from "node:assert/strict";
import test from "node:test";
import {
	MailboxMessageLocationContractError,
	validateMailboxMessageLocation,
} from "../../shared/mailbox-message-location.ts";

test("Message location accepts only the exact content-free coordinate", () => {
	assert.deepEqual(validateMailboxMessageLocation({
		emailId: "message-1",
		folderId: "folder_invoices",
	}, "message-1"), {
		emailId: "message-1",
		folderId: "folder_invoices",
	});
	for (const value of [
		{ emailId: "other", folderId: "inbox" },
		{ emailId: "message-1", folderId: "inbox", subject: "secret" },
		{ emailId: "message-1", folderId: "inbox\u202e" },
	]) assert.throws(
		() => validateMailboxMessageLocation(value, "message-1"),
		MailboxMessageLocationContractError,
	);
});
