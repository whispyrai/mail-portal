import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	decodeMailboxAttachmentCursor,
	type NormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";
import {
	readMailboxAttachmentDetail,
	readMailboxAttachmentForEmail,
	readMailboxAttachmentPage,
} from "./mailbox-attachments.ts";

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, subject TEXT, sender TEXT, date TEXT,
			body TEXT, recipient TEXT, cc TEXT, bcc TEXT, raw_headers TEXT
		);
			CREATE TABLE attachments (
				id TEXT PRIMARY KEY, email_id TEXT NOT NULL, filename TEXT NOT NULL,
				mimetype TEXT NOT NULL, size INTEGER NOT NULL, content_id TEXT, disposition TEXT,
				r2_key TEXT
		);
		INSERT INTO folders VALUES
			('inbox', 'Inbox'), ('sent', 'Sent'), ('archive', 'Archive'),
			('snoozed', 'Snoozed'), ('trash', 'Trash'), ('spam', 'Spam'),
			('draft', 'Drafts'), ('outbox', 'Outbox'),
			('_cancelled_outbound', 'Cancelled'), ('_retired_outbound', 'Legacy project'),
			('custom', 'Projects');
	`);
	return {
		db,
		sql: {
			exec<T>(query: string, ...bindings: Array<string | number | null>): Iterable<T> {
				return db.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

function options(
	overrides: Partial<NormalizedMailboxAttachmentListOptions> = {},
): NormalizedMailboxAttachmentListOptions {
	return {
		limit: 25,
		q: null,
		kind: null,
		folder: null,
		cursor: null,
		...overrides,
	};
}

function add(
	db: DatabaseSync,
		row: { id: string; folder: string; date: string; filename: string; disposition?: string | null; mime?: string; r2Key?: string | null },
) {
	db.prepare(`INSERT INTO emails
		(id, folder_id, subject, sender, date, body, recipient, cc, bcc, raw_headers)
		VALUES (?, ?, ?, 'sender@example.com', ?, 'SECRET BODY', 'secret-recipient', 'secret-cc', 'secret-bcc', 'secret-headers')`)
		.run(row.id, row.folder, `Subject ${row.id}`, row.date);
	db.prepare(`INSERT INTO attachments
		(id, email_id, filename, mimetype, size, content_id, disposition, r2_key)
		VALUES (?, ?, ?, ?, 42, 'secret-cid', ?, ?)`)
			.run(
				`attachment-${row.id}`,
				row.id,
				row.filename,
				row.mime ?? "application/pdf",
				row.disposition ?? null,
				row.r2Key ?? null,
			);
}

test("mailbox attachment projection includes stable mailbox folders while excluding mutable, internal, and inline rows", () => {
	const { db, sql } = database();
	for (const [index, folder] of [
		"inbox", "sent", "archive", "snoozed", "trash", "spam", "custom",
		"draft", "outbox", "_cancelled_outbound", "_retired_outbound",
	].entries()) {
		add(db, {
			id: folder,
			folder,
			date: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
			filename: `${folder}.pdf`,
		});
	}
	add(db, { id: "inline", folder: "inbox", date: "2026-07-12T10:00:00.000Z", filename: "logo.png", disposition: "inline", mime: "image/png" });

	const page = readMailboxAttachmentPage(sql, options());
	assert.deepEqual(
		page.items.map((item) => item.message.folderId).sort(),
		["_retired_outbound", "archive", "custom", "inbox", "sent", "snoozed", "spam", "trash"],
	);
	assert.equal(page.items[0] ? "body" in page.items[0].message : true, false);
	assert.equal(page.items[0] ? "recipient" in page.items[0].message : true, false);
	assert.equal(page.items.some((item) => "contentId" in item), false);
	db.close();
});

test("mailbox attachment filters are exact and classifier-equivalent", () => {
	const { db, sql } = database();
	add(db, { id: "image", folder: "inbox", date: "2026-07-12T10:00:00.000Z", filename: "misleading.pdf", mime: "image/png" });
	add(db, { id: "pdf", folder: "custom", date: "2026-07-11T10:00:00.000Z", filename: "proposal.pdf", mime: "application/octet-stream" });
	assert.deepEqual(readMailboxAttachmentPage(sql, options({ kind: "image" })).items.map((item) => item.id), ["attachment-image"]);
	assert.deepEqual(readMailboxAttachmentPage(sql, options({ q: "posal", folder: "custom" })).items.map((item) => item.id), ["attachment-pdf"]);
	assert.deepEqual(readMailboxAttachmentPage(sql, options({ folder: "missing" })).items, []);
	assert.deepEqual(readMailboxAttachmentPage(sql, options({ folder: "draft" })).items, []);
	db.close();
});

test("mailbox attachment filename search escapes wildcards and preserves duplicate filenames as distinct rows", () => {
	const { db, sql } = database();
	add(db, { id: "first", folder: "inbox", date: "2026-07-12T10:00:00.000Z", filename: "100%_proposal.pdf" });
	add(db, { id: "second", folder: "sent", date: "2026-07-11T10:00:00.000Z", filename: "100%_proposal.pdf" });
	add(db, { id: "wildcard-only", folder: "inbox", date: "2026-07-10T10:00:00.000Z", filename: "100XXproposal.pdf" });
	const rows = readMailboxAttachmentPage(sql, options({ q: "%_" })).items;
	assert.deepEqual(rows.map((item) => item.emailId), ["first", "second"]);
	assert.equal(rows[0]?.filename, rows[1]?.filename);
	db.close();
});

test("mailbox attachment kind remains equivalent when display metadata is bounded", () => {
	const { db, sql } = database();
	add(db, {
		id: "long",
		folder: "inbox",
		date: "2026-07-12T10:00:00.000Z",
		filename: `${"a".repeat(300)}.pdf`,
		mime: "application/octet-stream",
	});
	const item = readMailboxAttachmentPage(sql, options({ kind: "pdf" })).items[0];
	assert.equal(item?.filename.length, 255);
	assert.equal(item?.kind, "pdf");
	db.close();
});

test("mailbox attachment keyset pagination is stable across equal dates and a deleted cursor row", () => {
	const { db, sql } = database();
	for (const id of ["a", "b", "c", "d"]) {
		add(db, { id, folder: "inbox", date: "2026-07-12T10:00:00.000Z", filename: `${id}.pdf` });
	}
	const first = readMailboxAttachmentPage(sql, options({ limit: 2 }));
	assert.deepEqual(first.items.map((item) => item.emailId), ["a", "b"]);
	assert.ok(first.nextCursor);
	db.prepare("DELETE FROM emails WHERE id = 'b'").run();
	db.prepare("DELETE FROM attachments WHERE email_id = 'b'").run();
	const second = readMailboxAttachmentPage(sql, options({
		limit: 2,
		cursor: decodeMailboxAttachmentCursor(first.nextCursor, {}),
	}));
	assert.deepEqual(second.items.map((item) => item.emailId), ["c", "d"]);
	assert.equal(second.nextCursor, null);
	db.close();
});

test("mailbox attachment detail returns only eligible bounded metadata", () => {
	const { db, sql } = database();
	add(db, { id: "visible", folder: "inbox", date: "2026-07-12T10:00:00.000Z", filename: "proposal.pdf" });
	add(db, { id: "draft", folder: "draft", date: "2026-07-12T10:00:00.000Z", filename: "draft.pdf" });
	assert.equal(readMailboxAttachmentDetail(sql, "attachment-visible")?.emailId, "visible");
	assert.equal(readMailboxAttachmentDetail(sql, "attachment-draft"), null);
	assert.equal(readMailboxAttachmentDetail(sql, "missing"), null);
	db.close();
});

test("exact-pair byte metadata preserves Draft and Outbox reads while hiding internal snapshots", () => {
	const { db, sql } = database();
	add(db, { id: "draft", folder: "draft", date: "2026-07-12T10:00:00.000Z", filename: "draft.pdf", r2Key: "attachments/draft/exact.pdf" });
	add(db, { id: "outbox", folder: "outbox", date: "2026-07-12T10:00:00.000Z", filename: "queued.pdf", r2Key: "attachments/outbox/exact.pdf" });
	add(db, { id: "internal", folder: "_cancelled_outbound", date: "2026-07-12T10:00:00.000Z", filename: "snapshot.pdf" });
	assert.equal(readMailboxAttachmentForEmail(sql, "draft", "attachment-draft")?.filename, "draft.pdf");
	assert.equal(readMailboxAttachmentForEmail(sql, "draft", "attachment-draft")?.r2_key, "attachments/draft/exact.pdf");
	assert.equal(readMailboxAttachmentForEmail(sql, "outbox", "attachment-outbox")?.filename, "queued.pdf");
	assert.equal(readMailboxAttachmentForEmail(sql, "outbox", "attachment-outbox")?.r2_key, "attachments/outbox/exact.pdf");
	assert.equal(readMailboxAttachmentForEmail(sql, "internal", "attachment-internal"), null);
	assert.equal(readMailboxAttachmentForEmail(sql, "wrong", "attachment-draft"), null);
	db.close();
});
