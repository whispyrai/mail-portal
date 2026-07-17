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
	sha256RawEmail,
	mapZohoFolder,
	normalizeZohoFolderPath,
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

test("mapZohoFolder keeps excluded ancestors sticky across the full relative path", () => {
	for (const path of [
		"Trash/2024",
		"Customers/Spam/Recovered",
		"Deleted/Inbox",
		"Projects/Junk/Sent",
	]) {
		assert.equal(mapZohoFolder(path), null, `${path} should be dropped`);
	}
	assert.equal(mapZohoFolder("Projects/2024"), "archive");
	assert.equal(mapZohoFolder("Projects/Inbox"), "archive");
	assert.equal(mapZohoFolder("Exports/Sent"), "archive");
});

test("only exact single-segment Inbox and Sent paths receive special routing", () => {
	for (const path of ["Inbox", " inbox ", "INBOX", "InBoX"]) {
		assert.equal(mapZohoFolder(path), "inbox", path);
	}
	for (const path of ["Sent", " sent ", "SENT", "SeNt"]) {
		assert.equal(mapZohoFolder(path), "sent", path);
	}
	for (const path of [
		"Projects/Inbox",
		" projects / INBOX ",
		"Exports/Sent",
		" exports / sEnT ",
		"Inbox/2024",
		"Sent/2024",
	]) {
		assert.equal(mapZohoFolder(path), "archive", path);
	}
});

test("folder normalization preserves the meaningful full relative path and rejects ambiguity", () => {
	assert.equal(normalizeZohoFolderPath(" Customers \\ 2024 "), "Customers/2024");
	for (const path of ["", "/Inbox", "Inbox/", "Inbox//2024", ".", "../Inbox"]) {
		assert.throws(() => normalizeZohoFolderPath(path), /folder path is invalid/i);
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
	const a = await deriveImportId({ messageId: "<abc123@zoho.example>" }, "team@example.com");
	const b = await deriveImportId({
		messageId: "<abc123@zoho.example>",
		rawSha256: "f".repeat(64),
	}, "TEAM@EXAMPLE.COM");
	assert.equal(a, b);
	assert.equal(a, "310dcd79d78b3d1e771852d65c58f2c4");
	assert.match(a, /^[0-9a-f]{32}$/); // hex, filesystem/URL-safe
});

test("deriveImportId differs for different Message-IDs", async () => {
	const a = await deriveImportId({ messageId: "<one@zoho.example>" }, "team@example.com");
	const b = await deriveImportId({ messageId: "<two@zoho.example>" }, "team@example.com");
	assert.notEqual(a, b);
});

test("deriveImportId distinguishes no-Message-ID messages by exact raw digest", async () => {
	const first = await deriveImportId({
		rawSha256: "1".repeat(64),
	}, "team@example.com");
	const second = await deriveImportId({
		rawSha256: "2".repeat(64),
	}, "team@example.com");
	assert.notEqual(first, second);
	assert.equal(first, "00ad8dc36cd7099f7156ee7293c31972");
	assert.equal(second, "71bac594e1e9836dd8b08fc1587a2c93");
	assert.match(first, /^[0-9a-f]{32}$/);
	assert.match(second, /^[0-9a-f]{32}$/);
});

test("sha256RawEmail hashes the exact RFC822 bytes", async () => {
	assert.equal(
		await sha256RawEmail(new TextEncoder().encode("abc").buffer),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
});

test("deriveImportId refuses a lossy no-Message-ID fallback", async () => {
	await assert.rejects(
		() => deriveImportId({}, "team@example.com"),
		/valid raw SHA-256/i,
	);
});

test("deriveImportThreadId groups RFC-referenced messages regardless of import order", async () => {
	const rootId = await deriveImportId({ messageId: "<root@zoho.example>" }, "team@example.com");
	const firstReplyThreadId = await deriveImportThreadId({
		messageId: "<reply-1@zoho.example>",
		inReplyTo: "<root@zoho.example>",
		references: "<root@zoho.example>",
	}, "team@example.com");
	const secondReplyThreadId = await deriveImportThreadId({
		messageId: "<reply-2@zoho.example>",
		inReplyTo: "<reply-1@zoho.example>",
		references: "<root@zoho.example> <reply-1@zoho.example>",
	}, "team@example.com");

	assert.equal(firstReplyThreadId, rootId);
	assert.equal(secondReplyThreadId, rootId);
});

test("deriveImportThreadId uses the imported message id for a thread root", async () => {
	const messageId = "<root@zoho.example>";

	assert.equal(
		await deriveImportThreadId({ messageId }, "team@example.com"),
		await deriveImportId({ messageId }, "team@example.com"),
	);
});

test("import message and thread identities are isolated by normalized target mailbox", async () => {
	const parts = { messageId: "<shared@zoho.example>" };
	const first = await deriveImportId(parts, "first@example.com");
	const second = await deriveImportId(parts, "second@example.com");
	assert.notEqual(first, second);
	assert.equal(
		await deriveImportThreadId(parts, " FIRST@EXAMPLE.COM "),
		first,
	);
});
