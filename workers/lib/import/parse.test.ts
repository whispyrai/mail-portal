// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Pure decisions for the one-time Zoho → portal importer (WISER-241): folder
// mapping, deterministic idempotency id, and original-date normalization. Run:
//   node --experimental-strip-types --test workers/lib/import/parse.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	deriveImportId,
	deriveImportThreadId,
	mapZohoFolder,
	normalizeEmailDate,
} from "./parse.ts";

// ── mapZohoFolder ──────────────────────────────────────────────────

test("mapZohoFolder routes Inbox → inbox (case-insensitive)", () => {
	assert.equal(mapZohoFolder("Inbox"), "inbox");
	assert.equal(mapZohoFolder("inbox"), "inbox");
	assert.equal(mapZohoFolder("INBOX"), "inbox");
});

test("mapZohoFolder routes Sent → sent (case-insensitive)", () => {
	assert.equal(mapZohoFolder("Sent"), "sent");
	assert.equal(mapZohoFolder("  sent  "), "sent");
});

test("mapZohoFolder routes any other meaningful folder → archive", () => {
	assert.equal(mapZohoFolder("Archive"), "archive");
	assert.equal(mapZohoFolder("Drafts"), "archive"); // ticket excludes only Trash/Spam
	assert.equal(mapZohoFolder("Receipts"), "archive"); // custom label
	assert.equal(mapZohoFolder("Notes"), "archive");
});

test("mapZohoFolder drops Trash / Spam and their aliases → null", () => {
	for (const name of ["Trash", "trash", "Deleted", "Bin", "Spam", "Junk", "junk"]) {
		assert.equal(mapZohoFolder(name), null, `${name} should be dropped`);
	}
});

// ── normalizeEmailDate ─────────────────────────────────────────────

test("normalizeEmailDate parses an RFC 2822 Date header to ISO", () => {
	assert.equal(
		normalizeEmailDate("Wed, 15 Apr 2026 15:42:00 +0000"),
		"2026-04-15T15:42:00.000Z",
	);
});

test("normalizeEmailDate passes an ISO string through as ISO", () => {
	assert.equal(normalizeEmailDate("2026-04-15T15:42:00Z"), "2026-04-15T15:42:00.000Z");
});

test("normalizeEmailDate falls back to epoch for empty / unparseable input", () => {
	const epoch = "1970-01-01T00:00:00.000Z";
	assert.equal(normalizeEmailDate(""), epoch);
	assert.equal(normalizeEmailDate("not a date"), epoch);
	assert.equal(normalizeEmailDate(null), epoch);
	assert.equal(normalizeEmailDate(undefined), epoch);
});

// ── deriveImportId ─────────────────────────────────────────────────

test("deriveImportId is deterministic for the same Message-ID", async () => {
	const a = await deriveImportId({ messageId: "<abc123@zoho.example>" });
	const b = await deriveImportId({ messageId: "<abc123@zoho.example>" });
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/); // hex, filesystem/URL-safe
});

test("deriveImportId differs for different Message-IDs", async () => {
	const a = await deriveImportId({ messageId: "<one@zoho.example>" });
	const b = await deriveImportId({ messageId: "<two@zoho.example>" });
	assert.notEqual(a, b);
});

test("deriveImportId falls back to a stable message fingerprint when no Message-ID", async () => {
	const parts = { from: "john@acme.com", date: "2026-04-15T15:42:00Z", subject: "Hi" };
	const a = await deriveImportId(parts);
	const b = await deriveImportId(parts);
	assert.equal(a, b); // stable across runs
	assert.match(a, /^[0-9a-f]{32}$/);

	const c = await deriveImportId({ ...parts, subject: "Different" });
	assert.notEqual(a, c); // subject participates in the fallback key
});

test("deriveImportId distinguishes same-header messages by their content", async () => {
	const parts = {
		from: "john@acme.com",
		to: "hello@wiserchat.ai",
		date: "2026-04-15T15:42:00Z",
		subject: "Hi",
	};
	const first = await deriveImportId({ ...parts, content: "First message" });
	const second = await deriveImportId({ ...parts, content: "Second message" });
	assert.notEqual(first, second);
});

test("deriveImportThreadId groups RFC-referenced messages regardless of import order", async () => {
	const rootId = await deriveImportId({ messageId: "<root@zoho.example>" });
	const firstReplyThreadId = await deriveImportThreadId({
		messageId: "<reply-1@zoho.example>",
		inReplyTo: "<root@zoho.example>",
		references: "<root@zoho.example>",
	});
	const secondReplyThreadId = await deriveImportThreadId({
		messageId: "<reply-2@zoho.example>",
		inReplyTo: "<reply-1@zoho.example>",
		references: "<root@zoho.example> <reply-1@zoho.example>",
	});

	assert.equal(firstReplyThreadId, rootId);
	assert.equal(secondReplyThreadId, rootId);
});

test("deriveImportThreadId uses the imported message id for a thread root", async () => {
	const messageId = "<root@zoho.example>";

	assert.equal(
		await deriveImportThreadId({ messageId }),
		await deriveImportId({ messageId }),
	);
});
