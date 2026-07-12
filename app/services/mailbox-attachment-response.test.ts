import assert from "node:assert/strict";
import test from "node:test";
import {
	parseMailboxAttachmentItem,
	parseMailboxAttachmentPage,
} from "./mailbox-attachment-response.ts";

function item(overrides: Record<string, unknown> = {}) {
	return {
		id: "attachment-1",
		emailId: "email-1",
		filename: "report.pdf",
		mimetype: "application/pdf",
		size: 1024,
		kind: "pdf",
		message: {
			subject: "Quarterly report",
			sender: "finance@example.com",
			date: "2026-07-12T10:00:00.000Z",
			folderId: "inbox",
			folderName: "Inbox",
		},
		...overrides,
	};
}

test("accepts an exact bounded attachment item and page", () => {
	assert.equal(parseMailboxAttachmentItem(item()).id, "attachment-1");
	assert.equal(parseMailboxAttachmentPage({ items: [item()], nextCursor: null }).items.length, 1);
	assert.equal(parseMailboxAttachmentItem(item({
		message: { ...(item().message as object), date: "" },
	})).message.date, "");
});

test("rejects extra keys, invalid sizes, unknown kinds, and non-canonical dates", () => {
	assert.throws(() => parseMailboxAttachmentItem(item({ extra: true })), /invalid response/i);
	assert.throws(() => parseMailboxAttachmentItem(item({ size: 1.5 })), /invalid response/i);
	assert.throws(() => parseMailboxAttachmentItem(item({ kind: "executable" })), /invalid response/i);
	assert.throws(() => parseMailboxAttachmentItem(item({
		message: { ...(item().message as object), date: "2026-07-12T10:00:00Z" },
	})), /invalid response/i);
});

test("accepts the server kind when projected metadata truncation hides the original extension", () => {
	const parsed = parseMailboxAttachmentItem(item({
		filename: "x".repeat(255),
		mimetype: "application/octet-stream",
		kind: "pdf",
	}));
	assert.equal(parsed.kind, "pdf");
});

test("rejects duplicate IDs and rows outside the deterministic page order", () => {
	const first = item();
	const later = item({
		id: "attachment-2",
		emailId: "email-2",
		message: { ...(item().message as object), date: "2026-07-11T10:00:00.000Z" },
	});
	assert.throws(
		() => parseMailboxAttachmentPage({ items: [first, first], nextCursor: null }),
		/invalid response/i,
	);
	assert.throws(
		() => parseMailboxAttachmentPage({ items: [later, first], nextCursor: null }),
		/invalid response/i,
	);
});

test("identity is the email and attachment pair for legacy repeated attachment IDs", () => {
	const first = item({ emailId: "email-1", id: "legacy-attachment" });
	const second = item({ emailId: "email-2", id: "legacy-attachment" });
	assert.equal(
		parseMailboxAttachmentPage({ items: [first, second], nextCursor: null }).items.length,
		2,
	);
});

test("rejects oversized fields, oversized pages, and malformed cursors", () => {
	assert.throws(() => parseMailboxAttachmentItem(item({ filename: "x".repeat(256) })), /invalid response/i);
	assert.throws(
		() => parseMailboxAttachmentPage({ items: Array.from({ length: 51 }, (_, index) => item({ id: `a-${index}` })), nextCursor: null }),
		/invalid response/i,
	);
	assert.throws(
		() => parseMailboxAttachmentPage({ items: [], nextCursor: "not a cursor!" }),
		/invalid response/i,
	);
});
