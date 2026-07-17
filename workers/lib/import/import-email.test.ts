// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveImportId, sha256RawEmail } from "./parse.ts";
import { importParsedEmail } from "./import-email.ts";

type CreatedEmail = {
	folder: string;
	email: Record<string, unknown>;
	attachments: Array<Record<string, unknown>>;
};

function objectMetadata(value: ArrayBuffer | string) {
	return {
		size: typeof value === "string"
			? new TextEncoder().encode(value).byteLength
			: value.byteLength,
	};
}

function withImportClaims<
	T extends { getEmail(id: string): Promise<{ id: string; folder_id?: string } | null> },
>(mailbox: T) {
	let active: { emailId: string; token: string } | null = null;
	let sealedFingerprint: string | null = null;
	const rawEvidence = new Map<string, string>();
	const customHasEmailOrThreadIdentity = (mailbox as T & {
		hasEmailOrThreadIdentity?: (value: string) => Promise<boolean>;
	}).hasEmailOrThreadIdentity;
	return Object.assign(mailbox, {
		async claimImportedEmail(
			emailId: string,
			legacyId: string,
			token: string,
			identitySource: "message-id" | "raw-sha256",
			rawSha256: string | null,
		) {
			const evidence = rawEvidence.get(emailId);
			if (evidence && (identitySource !== "raw-sha256" || evidence !== rawSha256)) {
				return { status: "identity_conflict" as const, id: emailId };
			}
			const existing = await mailbox.getEmail(emailId) ?? await mailbox.getEmail(legacyId);
			if (existing) {
				if (identitySource === "raw-sha256" && evidence !== rawSha256) {
					return { status: "identity_conflict" as const, id: existing.id };
				}
				return identitySource === "raw-sha256"
					? {
							status: "existing" as const,
							id: existing.id,
							folder: existing.folder_id ?? "archive",
							rawSha256: evidence,
						}
					: {
							status: "existing" as const,
							id: existing.id,
							folder: existing.folder_id ?? "archive",
						};
			}
			if (active) return { status: "busy" as const };
			active = { emailId, token };
			if (identitySource === "raw-sha256" && rawSha256) rawEvidence.set(emailId, rawSha256);
			return { status: "claimed" as const };
		},
		async releaseImportedEmailClaim(emailId: string, token: string) {
			if (sealedFingerprint) return false;
			if (active?.emailId === emailId && active.token === token) active = null;
			return true;
		},
		async renewImportedEmailClaim(emailId: string, token: string) {
			return active?.emailId === emailId && active.token === token;
		},
		async hasEmailOrThreadIdentity(identity: string) {
			return customHasEmailOrThreadIdentity
				? customHasEmailOrThreadIdentity(identity)
				: Boolean(await mailbox.getEmail(identity));
		},
		async beginImportedEmailPromotionIntent() {},
		async appendImportedEmailPromotionIntent() {},
		async sealImportedEmailPromotionIntent() {
			sealedFingerprint = "a".repeat(64);
			return { proofFingerprint: sealedFingerprint };
		},
		async finalizeImportedEmailPromotionIntent(emailId: string, token: string) {
			sealedFingerprint = null;
			if (active?.emailId === emailId && active.token === token) active = null;
			return { status: "finalized" as const };
		},
		async createImportedEmail(
			folder: string,
			email: Record<string, unknown>,
			attachments: Array<Record<string, unknown>>,
			mailboxAddress: string | undefined,
		) {
			const createEmail = mailbox as T & {
				createEmail(
					folder: string,
					email: Record<string, unknown>,
					attachments: Array<Record<string, unknown>>,
					actor?: undefined,
					mailboxAddress?: string,
				): Promise<unknown>;
			};
			return (await createEmail.createEmail(
				folder,
				email,
				attachments,
				undefined,
				mailboxAddress,
			)) ?? { status: "stored" };
		},
	});
}

test("importParsedEmail preserves metadata, attachments, threads, and idempotency", async () => {
	const createdEmails: CreatedEmail[] = [];
	const storedAttachmentKeys: string[] = [];
	const storedEmailIds = new Set<string>();
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() {
			return null;
		},
		async createEmail(
			folder: string,
			email: Record<string, unknown>,
			attachments: Array<Record<string, unknown>>,
		) {
			createdEmails.push({ folder, email, attachments });
			if (typeof email.id === "string") storedEmailIds.add(email.id);
		},
	});
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			storedAttachmentKeys.push(key);
			return objectMetadata(value);
		},
		async delete() {},
	};
	const parsed = {
		messageId: "<reply@zoho.example>",
		inReplyTo: "<root@zoho.example>",
		references: "<root@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Re: Contract",
		from: { name: "Sender", address: "sender@example.com" },
		to: [{ name: "Hello", address: "hello@wiserchat.ai" }],
		cc: [{ name: "Copy", address: "copy@example.com" }],
		bcc: [],
		text: "Attached.",
		headers: [{ key: "message-id", value: "<reply@zoho.example>" }],
		headerLines: [],
		attachments: [
			{
				filename: "contract?.pdf",
				mimeType: "application/pdf",
				content: new Uint8Array([1, 2, 3]).buffer,
				disposition: "attachment",
			},
		],
	};

	const imported = await importParsedEmail({ bucket, mailbox }, parsed, "archive", "team@example.com");
	const duplicate = await importParsedEmail({ bucket, mailbox }, parsed, "archive", "TEAM@EXAMPLE.COM");
	const expectedThreadId = await deriveImportId({ messageId: "<root@zoho.example>" }, "team@example.com");

	assert.deepEqual(imported, {
		status: "imported",
		id: await deriveImportId({ messageId: "<reply@zoho.example>" }, "team@example.com"),
		folder: "archive",
		identitySource: "message-id",
	});
	assert.deepEqual(duplicate, {
		status: "skipped",
		reason: "duplicate",
		id: imported.id,
		folder: "archive",
		identitySource: "message-id",
	});
	assert.equal(createdEmails.length, 1);
	assert.equal(createdEmails[0]?.folder, "archive");
	assert.equal(createdEmails[0]?.email.date, "2026-04-15T15:42:00.000Z");
	assert.equal(createdEmails[0]?.email.read, true);
	assert.equal(createdEmails[0]?.email.recipient_memory_origin, "admin_import");
	assert.equal(createdEmails[0]?.email.sender_name, "Sender");
	assert.equal(createdEmails[0]?.email.thread_id, expectedThreadId);
	assert.equal(createdEmails[0]?.attachments[0]?.filename, "contract_.pdf");
	assert.equal(createdEmails[0]?.attachments[0]?.email_id, imported.id);
	assert.equal(storedAttachmentKeys.length, 1);
	assert.match(storedAttachmentKeys[0] ?? "", new RegExp(`^attachments/${imported.id}/`));
});

test("no-Message-ID imports preserve distinct exact source messages", async () => {
	const storedEmailIds = new Set<string>();
	const createdIds: string[] = [];
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() { return null; },
		async createEmail(
			_folder: string,
			email: Record<string, unknown>,
		) {
			const id = String(email.id);
			storedEmailIds.add(id);
			createdIds.push(id);
		},
	});
	const objects = new Map<string, ArrayBuffer | string>();
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			objects.set(key, value);
			return objectMetadata(value);
		},
		async delete(key: string) { objects.delete(key); },
	};
	const parsed = {
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Same parsed message",
		from: { address: "sender@example.com" },
		to: [{ address: "hello@wiserchat.ai" }],
		text: "Same parsed body",
		headers: [],
		headerLines: [],
	};
	const firstRaw = new TextEncoder().encode("same headers and body\nattachment=one").buffer;
	const secondRaw = new TextEncoder().encode("same headers and body\nattachment=two").buffer;
	const first = await importParsedEmail(
		{ bucket, mailbox },
		{
			...parsed,
			attachments: [{
				filename: "proof.bin",
				mimeType: "application/octet-stream",
				content: new Uint8Array([1]).buffer,
			}],
		},
		"archive",
		"team@example.com",
		await sha256RawEmail(firstRaw),
	);
	const second = await importParsedEmail(
		{ bucket, mailbox },
		{
			...parsed,
			attachments: [{
				filename: "proof.bin",
				mimeType: "application/octet-stream",
				content: new Uint8Array([2]).buffer,
			}],
		},
		"archive",
		"team@example.com",
		await sha256RawEmail(secondRaw),
	);

	assert.equal(first.status, "imported");
	assert.equal(second.status, "imported");
	assert.notEqual(first.id, second.id);
	assert.deepEqual(createdIds, [first.id, second.id]);
});

test("byte-identical no-Message-ID imports are idempotent", async () => {
	const storedEmailIds = new Set<string>();
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() { return null; },
		async createEmail(_folder: string, email: Record<string, unknown>) {
			storedEmailIds.add(String(email.id));
		},
	});
	const bucket = {
		async put(_key: string, value: ArrayBuffer | string) {
			return objectMetadata(value);
		},
		async delete() {},
	};
	const parsed = {
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "No Message-ID",
		from: { address: "sender@example.com" },
		to: [{ address: "hello@wiserchat.ai" }],
		text: "Exact rerun",
		headers: [],
		headerLines: [],
		attachments: [],
	};
	const rawSha256 = await sha256RawEmail(
		new TextEncoder().encode("exact original RFC822 bytes").buffer,
	);
	const first = await importParsedEmail(
		{ bucket, mailbox }, parsed, "archive", "team@example.com", rawSha256,
	);
	const rerun = await importParsedEmail(
		{ bucket, mailbox }, parsed, "archive", "TEAM@EXAMPLE.COM", rawSha256,
	);

	assert.equal(first.status, "imported");
	assert.deepEqual(rerun, {
		status: "skipped",
		reason: "duplicate",
		id: first.id,
		folder: "archive",
		identitySource: "raw-sha256",
		rawSha256,
	});
});

test("a late canonical duplicate reports its durable folder rather than the requested folder", async () => {
	const mailbox = withImportClaims({
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async createEmail() {},
	});
	mailbox.createImportedEmail = async () => ({ status: "duplicate", folder: "inbox" });
	const result = await importParsedEmail({
		bucket: { async put() {}, async delete() {} },
		mailbox,
	}, {
		messageId: "<late-duplicate@example.com>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "duplicate",
		headers: [],
		headerLines: [],
		attachments: [],
	}, "sent", "team@example.com");
	assert.deepEqual(result, {
		status: "skipped",
		reason: "duplicate",
		id: await deriveImportId(
			{ messageId: "<late-duplicate@example.com>" },
			"team@example.com",
		),
		folder: "inbox",
		identitySource: "message-id",
	});
});

test("an early canonical duplicate reports its durable folder rather than the requested folder", async () => {
	const mailbox = withImportClaims({
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async createEmail() {},
	});
	mailbox.claimImportedEmail = async () => ({
		status: "existing",
		id: "legacy-existing",
		folder: "inbox",
	});
	const result = await importParsedEmail({
		bucket: { async put() {}, async delete() {} },
		mailbox,
	}, {
		messageId: "<early-duplicate@example.com>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "duplicate",
		headers: [],
		headerLines: [],
		attachments: [],
	}, "sent", "team@example.com");
	assert.deepEqual(result, {
		status: "skipped",
		reason: "duplicate",
		id: "legacy-existing",
		folder: "inbox",
		identitySource: "message-id",
	});
});

test("a late duplicate without a durable folder fails closed", async () => {
	const mailbox = withImportClaims({
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async createEmail() {},
	});
	mailbox.createImportedEmail = async () => ({ status: "duplicate" });
	await assert.rejects(
		importParsedEmail({
			bucket: { async put() {}, async delete() {} },
			mailbox,
		}, {
			messageId: "<missing-folder@example.com>",
			date: "Wed, 15 Apr 2026 15:42:00 +0000",
			from: { address: "sender@example.com" },
			to: [{ address: "team@example.com" }],
			text: "duplicate",
			headers: [],
			headerLines: [],
			attachments: [],
		}, "sent", "team@example.com"),
		/omitted its authoritative folder/i,
	);
});

test("an unexpected canonical import status fails closed", async () => {
	const mailbox = withImportClaims({
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async createEmail() {},
	});
	mailbox.createImportedEmail = async () => ({ status: "mystery" });
	await assert.rejects(
		importParsedEmail({
			bucket: { async put() {}, async delete() {} },
			mailbox,
		}, {
			messageId: "<unexpected-status@example.com>",
			date: "Wed, 15 Apr 2026 15:42:00 +0000",
			from: { address: "sender@example.com" },
			to: [{ address: "team@example.com" }],
			text: "unexpected",
			headers: [],
			headerLines: [],
			attachments: [],
		}, "archive", "team@example.com"),
		/unexpected status/i,
	);
});

test("importParsedEmail cleans partial objects and retries with isolated attachment ids", async () => {
	const objects = new Map<string, unknown>();
	const storedEmailIds = new Set<string>();
	const attachmentIds: string[] = [];
	let failCreate = true;
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() {
			return null;
		},
		async createEmail(
			_folder: string,
			email: Record<string, unknown>,
			attachments: Array<Record<string, unknown>>,
		) {
			if (failCreate) {
				failCreate = false;
				throw new Error("simulated SQL failure");
			}
			if (typeof email.id === "string") storedEmailIds.add(email.id);
			for (const attachment of attachments) {
				if (typeof attachment.id === "string") attachmentIds.push(attachment.id);
			}
		},
	});
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			objects.set(key, value);
			return objectMetadata(value);
		},
		async delete(key: string) {
			objects.delete(key);
		},
	};
	const parsed = {
		messageId: "<retry@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Retry me",
		from: { address: "sender@example.com" },
		to: [{ address: "hello@wiserchat.ai" }],
		text: "One attachment",
		headers: [],
		headerLines: [],
		attachments: [
			{
				filename: "retry.txt",
				mimeType: "text/plain",
				content: new TextEncoder().encode("retry").buffer,
			},
		],
	};

	await assert.rejects(
		() => importParsedEmail({ bucket, mailbox }, parsed, "inbox", "team@example.com"),
		/simulated SQL failure/,
	);
	assert.equal(objects.size, 0, "failed persistence removes already-written R2 objects");

	const imported = await importParsedEmail({ bucket, mailbox }, parsed, "inbox", "team@example.com");
	assert.equal(attachmentIds.length, 1);
	assert.match(attachmentIds[0] ?? "", new RegExp(`^${imported.id}-[a-f0-9]{32}-0$`));
	assert.deepEqual([...objects.keys()], [
		`attachments/${imported.id}/${attachmentIds[0]}/retry.txt`,
	]);
});

test("a lost create response preserves committed bytes and finalizes the durable promotion", async () => {
	const objects = new Map<string, unknown>();
	const storedEmailIds = new Set<string>();
	let deletes = 0;
	let finalizations = 0;
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() {
			return null;
		},
		async createEmail(
			_folder: string,
			email: Record<string, unknown>,
		) {
			if (typeof email.id === "string") storedEmailIds.add(email.id);
			throw new Error("simulated lost create response");
		},
	});
	const finalize = mailbox.finalizeImportedEmailPromotionIntent.bind(mailbox);
	mailbox.finalizeImportedEmailPromotionIntent = async (...args) => {
		finalizations += 1;
		return finalize(...args);
	};
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			objects.set(key, value);
			return objectMetadata(value);
		},
		async delete(key: string) {
			deletes += 1;
			objects.delete(key);
		},
	};
	const parsed = {
		messageId: "<lost-create-response@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Committed despite response loss",
		from: { address: "sender@example.com" },
		to: [{ address: "hello@wiserchat.ai" }],
		text: "Preserve the committed attachment",
		headers: [],
		headerLines: [],
		attachments: [{
			filename: "committed.txt",
			mimeType: "text/plain",
			content: new TextEncoder().encode("committed").buffer,
		}],
	};

	await assert.rejects(
		() => importParsedEmail({ bucket, mailbox }, parsed, "inbox", "team@example.com"),
		/simulated lost create response/,
	);
	assert.equal(storedEmailIds.size, 1);
	assert.equal(objects.size, 1, "ambiguous commit preserves its authoritative R2 bytes");
	assert.equal(deletes, 0);
	assert.equal(finalizations, 1);
	assert.equal(
		(await importParsedEmail({ bucket, mailbox }, parsed, "inbox", "team@example.com")).reason,
		"duplicate",
	);
});

test("the same imported RFC identity produces mailbox-isolated attachment ids and R2 keys", async () => {
	const keys: string[] = [];
	const attachmentIds: string[] = [];
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			keys.push(key);
			return objectMetadata(value);
		},
		async delete() {},
	};
	function mailbox() {
		return withImportClaims({
			async getEmail() { return null; },
			async resolveCanonicalThreadId() { return null; },
			async createEmail(
				_folder: string,
				_email: Record<string, unknown>,
				attachments: Array<Record<string, unknown>>,
			) {
				for (const attachment of attachments) {
					if (typeof attachment.id === "string") attachmentIds.push(attachment.id);
				}
			},
		});
	}
	const parsed = {
		messageId: "<shared@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Shared identity",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Attachment",
		headers: [],
		headerLines: [],
		attachments: [{
			filename: "proposal.pdf",
			mimeType: "application/pdf",
			content: new Uint8Array([1]).buffer,
		}],
	};
	const first = await importParsedEmail({ bucket, mailbox: mailbox() }, parsed, "inbox", "first@example.com");
	const second = await importParsedEmail({ bucket, mailbox: mailbox() }, parsed, "inbox", "second@example.com");
	assert.notEqual(first.id, second.id);
	assert.notEqual(attachmentIds[0], attachmentIds[1]);
	assert.notEqual(keys[0], keys[1]);
});

test("rerunning an import recognizes an existing legacy unscoped message without duplicating it", async () => {
	const legacyId = "251981b51a09345f0bfa39e604b20c5c";
	let created = false;
	let writes = 0;
	const parsed = {
		messageId: "<legacy@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Legacy",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Already imported",
		headers: [],
		headerLines: [],
		attachments: [{ filename: "legacy.pdf", mimeType: "application/pdf", content: new Uint8Array([1]).buffer }],
	};
	const result = await importParsedEmail({
		bucket: {
			async put() { writes += 1; },
			async delete() {},
		},
		mailbox: withImportClaims({
			async getEmail(id: string) { return id === legacyId ? { id } : null; },
			async resolveCanonicalThreadId() { return null; },
			async createEmail() { created = true; },
		}),
	}, parsed, "archive", "team@example.com");
	assert.deepEqual(result, {
		status: "skipped",
		reason: "duplicate",
		id: legacyId,
		folder: "archive",
		identitySource: "message-id",
	});
	assert.equal(created, false);
	assert.equal(writes, 0);
});

test("a legacy lossy no-Message-ID identity cannot suppress a distinct exact source", async () => {
	const legacyLossyId = "2aeb0093d251d800f487dc2ae69ac52d";
	let createdId: string | null = null;
	const result = await importParsedEmail({
		bucket: { async put() {}, async delete() {} },
		mailbox: withImportClaims({
			async getEmail(id: string) {
				return id === legacyLossyId ? { id } : null;
			},
			async resolveCanonicalThreadId() { return null; },
			async createEmail(_folder: string, email: Record<string, unknown>) {
				createdId = String(email.id);
			},
		}),
	}, {
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Legacy lossy fallback",
		from: { address: "sender@example.com" },
		to: [{ address: "hello@wiserchat.ai" }],
		text: "Same parsed body",
		headers: [],
		headerLines: [],
		attachments: [],
	}, "archive", "team@example.com", "9".repeat(64));

	assert.equal(result.status, "imported");
	assert.equal(createdId, result.id);
	assert.notEqual(result.id, legacyLossyId);
});

test("a newly scoped reply joins an existing legacy thread even when its root row is absent", async () => {
	const legacyRootId = "511166a1d1dde221857fbf5069c3e69c";
	const legacyReplyId = "0bb62379803d1422f173b22c2d7481b";
	let stored: Record<string, unknown> | undefined;
	const parsed = {
		messageId: "<new-reply@zoho.example>",
		inReplyTo: "<legacy-root@zoho.example>",
		references: "<legacy-root@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Re: Legacy root",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Incremental reply",
		headers: [],
		headerLines: [],
		attachments: [],
	};
	const result = await importParsedEmail({
		bucket: { async put() {}, async delete() {} },
		mailbox: withImportClaims({
			async getEmail() { return null; },
			async hasEmailOrThreadIdentity(id: string) { return id === legacyRootId; },
			async resolveCanonicalThreadId() { return null; },
			async createEmail(_folder: string, email: Record<string, unknown>) { stored = email; },
		}),
	}, parsed, "archive", "team@example.com");
	assert.equal(result.status, "imported");
	assert.notEqual(result.id, legacyReplyId, "new writes remain mailbox-scoped");
	assert.equal(stored?.id, result.id);
	assert.equal(stored?.thread_id, legacyRootId);
});

test("an importer that loses its fencing lease writes no canonical attachment bytes", async () => {
	let writes = 0;
	const mailbox = withImportClaims({
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async createEmail() {
			assert.fail("a request without its claim cannot commit mail");
		},
	});
	mailbox.renewImportedEmailClaim = async () => false;
	await assert.rejects(
		() => importParsedEmail({
			bucket: {
				async put() { writes += 1; },
				async delete() {},
			},
			mailbox,
		}, {
			messageId: "<lost-claim@zoho.example>",
			date: "Wed, 15 Apr 2026 15:42:00 +0000",
			subject: "Lost claim",
			from: { address: "sender@example.com" },
			to: [{ address: "team@example.com" }],
			text: "Do not persist",
			headers: [],
			headerLines: [],
			attachments: [{
				filename: "secret.pdf",
				mimeType: "application/pdf",
				content: new Uint8Array([7]).buffer,
			}],
		}, "archive", "team@example.com"),
		/claim was lost/i,
	);
	assert.equal(writes, 0);
});

test("a concurrent duplicate import cannot overwrite the winning attachment bytes", async () => {
	const storedEmailIds = new Set<string>();
	const storedObjects = new Map<string, Uint8Array>();
	let releaseFirstWrite!: () => void;
	let markFirstWriteStarted!: () => void;
	const firstWriteStarted = new Promise<void>((resolve) => {
		markFirstWriteStarted = resolve;
	});
	const firstWriteCanFinish = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	let writes = 0;
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			writes += 1;
			if (writes === 1) {
				markFirstWriteStarted();
				await firstWriteCanFinish;
			}
			storedObjects.set(
				key,
				typeof value === "string"
					? new TextEncoder().encode(value)
					: new Uint8Array(value),
			);
			return objectMetadata(value);
		},
		async delete(key: string) {
			storedObjects.delete(key);
		},
	};
	const mailbox = withImportClaims({
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() { return null; },
		async createEmail(_folder: string, email: Record<string, unknown>) {
			if (typeof email.id === "string") storedEmailIds.add(email.id);
		},
	});
	const base = {
		messageId: "<concurrent@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Concurrent",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Same RFC identity",
		headers: [],
		headerLines: [],
	};
	const winner = importParsedEmail({ bucket, mailbox }, {
		...base,
		attachments: [{
			filename: "winner.pdf",
			mimeType: "application/pdf",
			content: new Uint8Array([1, 2, 3]).buffer,
		}],
	}, "archive", "team@example.com");
	await firstWriteStarted;
	const loser = await importParsedEmail({ bucket, mailbox }, {
		...base,
		attachments: [{
			filename: "loser.pdf",
			mimeType: "application/pdf",
			content: new Uint8Array([9, 9, 9]).buffer,
		}],
	}, "archive", "team@example.com");
	assert.deepEqual(loser, {
		status: "skipped",
		reason: "in_progress",
		id: await deriveImportId({
			messageId: base.messageId,
			from: base.from.address,
			to: base.to[0]!.address,
			date: base.date,
			subject: base.subject,
			content: base.text,
		}, "team@example.com"),
		folder: "archive",
		identitySource: "message-id",
	});
	assert.equal(writes, 1, "the losing request writes no canonical R2 object");
	releaseFirstWrite();
	const imported = await winner;
	assert.equal(imported.status, "imported");
	assert.equal(storedObjects.size, 1);
	const [key, bytes] = [...storedObjects.entries()][0]!;
	assert.match(key, /\/winner\.pdf$/);
	assert.deepEqual([...bytes], [1, 2, 3]);
});

test("an expired in-flight writer cannot overwrite a successor generation", async () => {
	const storedEmailIds = new Set<string>();
	const storedObjects = new Map<string, Uint8Array>();
	let currentClaim: { emailId: string; token: string } | null = null;
	let committedAttachments: Array<Record<string, unknown>> = [];
	let releaseExpiredWrite!: () => void;
	let markExpiredWriteStarted!: () => void;
	const expiredWriteStarted = new Promise<void>((resolve) => {
		markExpiredWriteStarted = resolve;
	});
	const expiredWriteCanFinish = new Promise<void>((resolve) => {
		releaseExpiredWrite = resolve;
	});
	const mailbox = {
		async getEmail(id: string) {
			return storedEmailIds.has(id) ? { id } : null;
		},
		async resolveCanonicalThreadId() { return null; },
		async hasEmailOrThreadIdentity() { return false; },
		async claimImportedEmail(emailId: string, legacyId: string, token: string) {
			const existing = await this.getEmail(emailId) ?? await this.getEmail(legacyId);
			if (existing) {
				return {
					status: "existing" as const,
					id: existing.id,
					folder: "archive",
				};
			}
			if (currentClaim) return { status: "busy" as const };
			currentClaim = { emailId, token };
			return { status: "claimed" as const };
		},
		async renewImportedEmailClaim(emailId: string, token: string) {
			return currentClaim?.emailId === emailId && currentClaim.token === token;
		},
		async releaseImportedEmailClaim(emailId: string, token: string) {
			if (currentClaim?.emailId === emailId && currentClaim.token === token) {
				currentClaim = null;
			}
			return true;
		},
		async beginImportedEmailPromotionIntent() {},
		async appendImportedEmailPromotionIntent() {},
		async sealImportedEmailPromotionIntent() {
			return { proofFingerprint: "b".repeat(64) };
		},
		async finalizeImportedEmailPromotionIntent(emailId: string, token: string) {
			if (currentClaim?.emailId === emailId && currentClaim.token === token) {
				currentClaim = null;
			}
			return { status: "finalized" as const };
		},
		async createImportedEmail(
			folder: string,
			email: Record<string, unknown>,
			attachments: Array<Record<string, unknown>>,
		) {
			await this.createEmail(folder, email, attachments);
			return { status: "stored" };
		},
		async createEmail(
			_folder: string,
			email: Record<string, unknown>,
			attachments: Array<Record<string, unknown>>,
		) {
			if (typeof email.id === "string" && storedEmailIds.has(email.id)) {
				throw new Error("duplicate email");
			}
			if (typeof email.id === "string") storedEmailIds.add(email.id);
			committedAttachments = attachments;
		},
	};
	const bucket = {
		async put(key: string, value: ArrayBuffer | string) {
			const bytes = typeof value === "string"
				? new TextEncoder().encode(value)
				: new Uint8Array(value);
			if (bytes[0] === 1) {
				markExpiredWriteStarted();
				await expiredWriteCanFinish;
			}
			storedObjects.set(key, bytes);
			return objectMetadata(value);
		},
		async delete(key: string) {
			storedObjects.delete(key);
		},
	};
	const base = {
		messageId: "<fenced@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Fenced",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Same identity and filename",
		headers: [],
		headerLines: [],
	};
	const expired = importParsedEmail({ bucket, mailbox }, {
		...base,
		attachments: [{
			filename: "shared.pdf",
			mimeType: "application/pdf",
			content: new Uint8Array([1, 1, 1]).buffer,
		}],
	}, "archive", "team@example.com");
	await expiredWriteStarted;
	currentClaim = null;
	const successor = await importParsedEmail({ bucket, mailbox }, {
		...base,
		attachments: [{
			filename: "shared.pdf",
			mimeType: "application/pdf",
			content: new Uint8Array([9, 9, 9]).buffer,
		}],
	}, "archive", "team@example.com");
	assert.equal(successor.status, "imported");
	releaseExpiredWrite();
	await assert.rejects(expired, /claim was lost|duplicate email/i);
	assert.equal(storedObjects.size, 1);
	const committedId = String(committedAttachments[0]?.id ?? "");
	const [key, bytes] = [...storedObjects.entries()][0]!;
	assert.match(key, new RegExp(`/${committedId}/shared\\.pdf$`));
	assert.deepEqual([...bytes], [9, 9, 9]);
});

test("canonical import promotion rejects missing or wrong R2 size metadata before Mailbox commit", async () => {
	for (const testCase of [
		{ name: "missing metadata", result: {} },
		{ name: "wrong metadata", result: { size: 2 } },
	]) {
		let createCalls = 0;
		const promotedKeys: string[] = [];
		const deletedKeys: string[] = [];
		const mailbox = withImportClaims({
			async getEmail() { return null; },
			async resolveCanonicalThreadId() { return null; },
			async createEmail() { createCalls += 1; },
		});
		await assert.rejects(
			() => importParsedEmail({
				bucket: {
					async put(key: string) {
						promotedKeys.push(key);
						return testCase.result;
					},
					async delete(key: string) {
						deletedKeys.push(key);
					},
				},
				mailbox,
			}, {
				messageId: `<integrity-${testCase.name}@zoho.example>`,
				date: "Wed, 15 Apr 2026 15:42:00 +0000",
				subject: "Integrity",
				from: { address: "sender@example.com" },
				to: [{ address: "team@example.com" }],
				text: "Attachment",
				headers: [],
				headerLines: [],
				attachments: [{
					filename: "proof.bin",
					mimeType: "application/octet-stream",
					content: new Uint8Array([7]).buffer,
				}],
			}, "archive", "team@example.com"),
			(error) =>
				Boolean(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "R2_DERIVED_UPLOAD_INTEGRITY_FAILED",
				),
			testCase.name,
		);
		assert.equal(createCalls, 0, testCase.name);
		assert.equal(promotedKeys.length, 1, testCase.name);
		assert.deepEqual(deletedKeys, promotedKeys, testCase.name);
	}
});

test("promotion is sealed before the first R2 put and sealed failures use the durable finalizer", async () => {
	const events: string[] = [];
	let releaseCalls = 0;
	const fingerprint = "c".repeat(64);
	const mailbox = {
		async getEmail() { return null; },
		async resolveCanonicalThreadId() { return null; },
		async hasEmailOrThreadIdentity() { return false; },
		async claimImportedEmail() { return { status: "claimed" as const }; },
		async renewImportedEmailClaim() { return true; },
		async releaseImportedEmailClaim() {
			releaseCalls += 1;
			return true;
		},
		async beginImportedEmailPromotionIntent() { events.push("begin"); },
		async appendImportedEmailPromotionIntent() { events.push("append"); },
		async sealImportedEmailPromotionIntent() {
			events.push("seal");
			return { proofFingerprint: fingerprint };
		},
		async finalizeImportedEmailPromotionIntent(
			_emailId: string,
			_claimToken: string,
			proofFingerprint: string,
		) {
			assert.equal(proofFingerprint, fingerprint);
			events.push("finalize");
			return { status: "finalized" as const };
		},
		async createImportedEmail() {
			assert.fail("failed R2 promotion cannot commit a Message");
		},
		async createEmail() {
			assert.fail("generic create must not be used by an import");
		},
	};
	await assert.rejects(
		() => importParsedEmail({
			mailbox,
			bucket: {
				async put() {
					events.push("put");
					throw new Error("controlled promotion failure");
				},
				async delete() {
					events.push("delete-failed");
					throw new Error("controlled delete failure");
				},
			},
		}, {
			messageId: "<intent-order@zoho.example>",
			date: "Wed, 15 Apr 2026 15:42:00 +0000",
			subject: "Intent first",
			from: { address: "sender@example.com" },
			to: [{ address: "team@example.com" }],
			text: "Attachment",
			headers: [],
			headerLines: [],
			attachments: [{
				filename: "proof.bin",
				mimeType: "application/octet-stream",
				content: new Uint8Array([7]).buffer,
			}],
		}, "archive", "team@example.com"),
		/controlled promotion failure/,
	);
	assert.deepEqual(events, [
		"begin",
		"append",
		"seal",
		"put",
		"delete-failed",
		"finalize",
	]);
	assert.equal(releaseCalls, 0);
});

test("import finalization budgets both validation and settlement passes", async () => {
	let finalizerCalls = 0;
	const fingerprint = "d".repeat(64);
	const result = await importParsedEmail({
		mailbox: {
			async getEmail() { return null; },
			async resolveCanonicalThreadId() { return null; },
			async hasEmailOrThreadIdentity() { return false; },
			async claimImportedEmail() { return { status: "claimed" as const }; },
			async renewImportedEmailClaim() { return true; },
			async releaseImportedEmailClaim() { return false; },
			async beginImportedEmailPromotionIntent() {},
			async appendImportedEmailPromotionIntent() {},
			async sealImportedEmailPromotionIntent() {
				return { proofFingerprint: fingerprint };
			},
			async finalizeImportedEmailPromotionIntent() {
				finalizerCalls += 1;
				return {
					status: finalizerCalls < 5 ? "pending" as const : "finalized" as const,
				};
			},
			async createImportedEmail() { return { status: "stored" }; },
			async createEmail() { assert.fail("generic create must not be used"); },
		},
		bucket: {
			async put(_key: string, value: ArrayBuffer | string) {
				return objectMetadata(value);
			},
			async delete() {},
		},
	}, {
		messageId: "<two-phase-finalizer@zoho.example>",
		date: "Wed, 15 Apr 2026 15:42:00 +0000",
		subject: "Two phase finalizer",
		from: { address: "sender@example.com" },
		to: [{ address: "team@example.com" }],
		text: "Attachment",
		headers: [],
		headerLines: [],
		attachments: [{
			filename: "proof.bin",
			mimeType: "application/octet-stream",
			content: new Uint8Array([7]).buffer,
		}],
	}, "archive", "team@example.com");

	assert.equal(result.status, "imported");
	assert.equal(finalizerCalls, 5);
});
