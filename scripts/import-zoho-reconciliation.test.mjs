import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveMessageIdImportPortalId,
	deriveRawImportPortalId,
	ImportIdentityCollisionError,
	ImportReconciliation,
	localImportIdentity,
	mapLocalZohoFolder,
} from "./import-zoho-reconciliation.mjs";
import { mapZohoFolder } from "../workers/lib/import/parse.ts";

const mailbox = "team@example.com";
const rawSha256 = "1".repeat(64);
const rawIdentity = localImportIdentity(mailbox, rawSha256, null);
const messageIdentity = localImportIdentity(mailbox, "2".repeat(64), "<message@example.com>");

test("the driver independently derives exact mailbox-scoped identities", () => {
	assert.equal(
		deriveRawImportPortalId(" TEAM@EXAMPLE.COM ", rawSha256),
		"00ad8dc36cd7099f7156ee7293c31972",
	);
	assert.equal(
		messageIdentity.portalId,
		deriveMessageIdImportPortalId(mailbox, "<message@example.com>"),
	);
});

test("valid imported, duplicate, excluded, and in-progress contracts reconcile", () => {
	const reconciliation = new ImportReconciliation(4, mailbox);
	reconciliation.record(rawIdentity, {
		httpStatus: 201,
		status: "imported",
		id: rawIdentity.portalId,
		identitySource: "raw-sha256",
		rawSha256,
		folder: "archive",
	}, "archive");
	reconciliation.record(rawIdentity, {
		httpStatus: 200,
		status: "skipped",
		reason: "duplicate",
		id: rawIdentity.portalId,
		identitySource: "raw-sha256",
		rawSha256,
		folder: "archive",
	}, "archive");
	reconciliation.record(null, {
		httpStatus: 200,
		status: "skipped",
		reason: "excluded-folder",
	}, null);
	reconciliation.record(messageIdentity, {
		httpStatus: 409,
		status: "skipped",
		reason: "in_progress",
		id: messageIdentity.portalId,
		identitySource: "message-id",
	}, "inbox");
	assert.deepEqual(reconciliation.summary(), {
		sourceTotal: 4,
		resultTotal: 4,
		unprocessed: 0,
		imported: 1,
		duplicate: 1,
		excluded: 1,
		error: 1,
		identityCollisions: 0,
	});
});

test("local no-Message-ID identity rejects a spoofed server Message-ID identity", () => {
	const reconciliation = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => reconciliation.record(rawIdentity, {
			httpStatus: 201,
			status: "imported",
			id: rawIdentity.portalId,
			identitySource: "message-id",
			folder: "archive",
		}, "archive"),
		/contradicted local exact identity/i,
	);
	assert.equal(reconciliation.summary().error, 1);
});

test("no-Message-ID success requires echoed persistent digest and exact derived id", () => {
	for (const result of [
		{
			httpStatus: 201,
			status: "imported",
			folder: "archive",
			id: "f".repeat(32),
			identitySource: "raw-sha256",
			rawSha256,
		},
		{
			httpStatus: 201,
			status: "imported",
			folder: "archive",
			id: rawIdentity.portalId,
			identitySource: "raw-sha256",
			rawSha256: "3".repeat(64),
		},
	]) {
		const reconciliation = new ImportReconciliation(1, mailbox);
		assert.throws(
			() => reconciliation.record(rawIdentity, result, "archive"),
			/identity evidence/i,
		);
		assert.equal(reconciliation.summary().error, 1);
	}
});

test("Message-ID results require the locally derived id", () => {
	const reconciliation = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => reconciliation.record(messageIdentity, {
			httpStatus: 200,
			status: "skipped",
			reason: "duplicate",
			id: "a".repeat(32),
			identitySource: "message-id",
			folder: "archive",
		}, "archive"),
		/local exact identity/i,
	);
});

test("identity conflict is a hard persistent collision verdict", () => {
	const reconciliation = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => reconciliation.record(rawIdentity, {
			httpStatus: 409,
			status: "skipped",
			reason: "identity_conflict",
			id: rawIdentity.portalId,
			identitySource: "raw-sha256",
		}, "archive"),
		ImportIdentityCollisionError,
	);
	assert.equal(reconciliation.summary().identityCollisions, 1);
	assert.equal(reconciliation.summary().error, 1);
});

test("HTTP and result status must match the exact endpoint contract", () => {
	const mismatches = [
		{ httpStatus: 200, status: "imported", id: messageIdentity.portalId, identitySource: "message-id" },
		{ httpStatus: 201, status: "skipped", reason: "duplicate", id: messageIdentity.portalId, identitySource: "message-id" },
		{ httpStatus: 201, status: "skipped", reason: "excluded-folder" },
		{ httpStatus: 200, status: "skipped", reason: "in_progress" },
		{ httpStatus: 200, status: "skipped", reason: "identity_conflict" },
		{ httpStatus: 500, status: "imported", id: messageIdentity.portalId, identitySource: "message-id" },
		{ httpStatus: 500, status: "skipped", reason: "duplicate", id: messageIdentity.portalId, identitySource: "message-id" },
		{ httpStatus: 204, status: "success" },
	];
	const reconciliation = new ImportReconciliation(mismatches.length, mailbox);
	for (const result of mismatches) reconciliation.record(messageIdentity, result, "archive");
	assert.equal(reconciliation.summary().error, mismatches.length);
	assert.equal(reconciliation.summary().resultTotal, mismatches.length);
});

test("the driver owns the exact Zoho folder mapping", () => {
	for (const alias of ["Trash", "deleted", "BIN", "spam", " Junk "]) {
		assert.equal(mapLocalZohoFolder(alias), null);
	}
	assert.equal(mapLocalZohoFolder("Inbox"), "inbox");
	assert.equal(mapLocalZohoFolder("Sent"), "sent");
	assert.equal(mapLocalZohoFolder("Receipts"), "archive");
	assert.equal(mapLocalZohoFolder("Trash/2024"), null);
	assert.equal(mapLocalZohoFolder("Projects/Spam/Recovered"), null);
	assert.equal(mapLocalZohoFolder("Projects/2024"), "archive");
	assert.equal(mapLocalZohoFolder("Projects/Inbox"), "archive");
	assert.equal(mapLocalZohoFolder("Exports/Sent"), "archive");
});

test("local and server folder contracts classify exact and nested paths identically", () => {
	const cases = new Map([
		["Inbox", "inbox"],
		[" inbox ", "inbox"],
		["InBoX", "inbox"],
		["Sent", "sent"],
		[" sent ", "sent"],
		["SeNt", "sent"],
		["Projects/Inbox", "archive"],
		[" projects / INBOX ", "archive"],
		["Exports/Sent", "archive"],
		[" exports / sEnT ", "archive"],
		["Inbox/2024", "archive"],
		["Sent/2024", "archive"],
		["Trash/Inbox", null],
		["Projects/JuNk/Sent", null],
	]);
	for (const [path, expected] of cases) {
		assert.equal(mapLocalZohoFolder(path), expected, path);
		assert.equal(mapZohoFolder(path), expected, `server: ${path}`);
		assert.equal(mapLocalZohoFolder(path), mapZohoFolder(path), `equivalence: ${path}`);
	}
});

test("folder lies cannot turn included mail into excluded mail or move stored mail", () => {
	const excludedLie = new ImportReconciliation(1, mailbox);
	excludedLie.record(messageIdentity, {
		httpStatus: 200,
		status: "skipped",
		reason: "excluded-folder",
	}, "inbox");
	assert.equal(excludedLie.summary().error, 1);
	assert.equal(excludedLie.summary().excluded, 0);

	const importedLie = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => importedLie.record(messageIdentity, {
			httpStatus: 201,
			status: "imported",
			id: messageIdentity.portalId,
			identitySource: "message-id",
			folder: "sent",
		}, "inbox"),
		/local folder mapping/i,
	);
	assert.equal(importedLie.summary().error, 1);

	const duplicateMoved = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => duplicateMoved.record(messageIdentity, {
			httpStatus: 200,
			status: "skipped",
			reason: "duplicate",
			id: messageIdentity.portalId,
			identitySource: "message-id",
			folder: "inbox",
		}, "sent"),
		/local folder mapping/i,
	);
	assert.equal(duplicateMoved.summary().error, 1);

	const droppedImport = new ImportReconciliation(1, mailbox);
	assert.throws(
		() => droppedImport.record(messageIdentity, {
			httpStatus: 200,
			status: "skipped",
			reason: "duplicate",
			id: messageIdentity.portalId,
			identitySource: "message-id",
			folder: "archive",
		}, null),
		/local folder mapping/i,
	);
});
