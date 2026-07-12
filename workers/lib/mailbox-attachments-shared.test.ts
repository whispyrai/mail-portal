import assert from "node:assert/strict";
import test from "node:test";
import {
	MailboxAttachmentQueryError,
	classifyMailboxAttachment,
	decodeMailboxAttachmentCursor,
	encodeMailboxAttachmentCursor,
	isMailboxAttachmentPreviewable,
	normalizeMailboxAttachmentListQuery,
	validateNormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";

test("attachment list query normalizes exact filters and a strict bounded limit", () => {
	assert.deepEqual(
		normalizeMailboxAttachmentListQuery(
			new URLSearchParams("limit=50&q=%20Quarterly%20Report%20&kind=presentation&folder=archive"),
		),
		{
			limit: 50,
			q: "Quarterly Report",
			kind: "presentation",
			folder: "archive",
			cursor: null,
		},
	);
	for (const query of ["limit=", "limit=0", "limit=51", "limit=2.5", "kind=video", "limit=2&limit=3", "cursor="]) {
		assert.throws(
			() => normalizeMailboxAttachmentListQuery(new URLSearchParams(query)),
			MailboxAttachmentQueryError,
		);
	}
});

test("attachment filename search enforces the escaped UTF-8 LIKE pattern boundary", () => {
	assert.equal(
		normalizeMailboxAttachmentListQuery(new URLSearchParams(`q=${encodeURIComponent("%_\\")}`)).q,
		"%_\\",
	);
	assert.throws(
		() => normalizeMailboxAttachmentListQuery(new URLSearchParams(`q=${"é".repeat(25)}`)),
		(error: unknown) =>
			error instanceof MailboxAttachmentQueryError && error.code === "QUERY_TOO_LARGE",
	);
});

test("attachment classifier resolves sender-controlled MIME and extension ambiguity deterministically", () => {
	assert.equal(classifyMailboxAttachment("photo.pdf", "image/png"), "image");
	assert.equal(classifyMailboxAttachment("proposal.pdf", "application/octet-stream"), "pdf");
	assert.equal(classifyMailboxAttachment("forecast.xlsx", ""), "spreadsheet");
	assert.equal(classifyMailboxAttachment("deck.pptx", "application/zip"), "archive");
	assert.equal(classifyMailboxAttachment("script.js", "text/javascript"), "other");
});

test("attachment preview admission rejects active and MIME-mismatched formats", () => {
	assert.equal(isMailboxAttachmentPreviewable("scan.pdf", "application/pdf"), true);
	assert.equal(isMailboxAttachmentPreviewable("photo.JPG", "image/jpeg"), true);
	assert.equal(isMailboxAttachmentPreviewable("photo.svg", "image/svg+xml"), false);
	assert.equal(isMailboxAttachmentPreviewable("page.html", "image/png"), false);
	assert.equal(isMailboxAttachmentPreviewable("photo.png", "text/html"), false);
});

test("attachment cursor is canonical, filter-bound, and rejects malformed or mismatched values", () => {
	const filters = { q: "proposal", kind: "pdf" as const, folder: "sent" };
	const cursor = encodeMailboxAttachmentCursor(
		{
			date: "2026-07-12T10:00:00.000Z",
			emailId: "mail-1",
			attachmentId: "attachment-2",
		},
		filters,
	);
	assert.deepEqual(decodeMailboxAttachmentCursor(cursor, filters), {
		date: "2026-07-12T10:00:00.000Z",
		emailId: "mail-1",
		attachmentId: "attachment-2",
	});
	assert.throws(
		() => decodeMailboxAttachmentCursor(cursor, { ...filters, folder: "inbox" }),
		MailboxAttachmentQueryError,
	);
	for (const invalid of ["", "%%%", `${cursor}=`, "a".repeat(2049)]) {
		assert.throws(
			() => decodeMailboxAttachmentCursor(invalid, filters),
			MailboxAttachmentQueryError,
		);
	}
});

test("Durable Object attachment options fail closed when normalized input is forged", () => {
	assert.deepEqual(
		validateNormalizedMailboxAttachmentListOptions({
			limit: 25,
			q: null,
			kind: "pdf",
			folder: "sent",
			cursor: null,
		}),
		{ limit: 25, q: null, kind: "pdf", folder: "sent", cursor: null },
	);
	for (const forged of [
		{ limit: 500, q: null, kind: null, folder: null, cursor: null },
		{ limit: 25, q: " padded ", kind: null, folder: null, cursor: null },
		{ limit: 25, q: null, kind: "video", folder: null, cursor: null },
		{ limit: 25, q: null, kind: null, folder: null, cursor: { date: "", emailId: "", attachmentId: "a" } },
		{ limit: 25, q: null, kind: null, folder: null, cursor: { date: "x".repeat(65), emailId: "mail", attachmentId: "a" } },
	]) {
		assert.throws(
			() => validateNormalizedMailboxAttachmentListOptions(forged),
			MailboxAttachmentQueryError,
		);
	}
});
