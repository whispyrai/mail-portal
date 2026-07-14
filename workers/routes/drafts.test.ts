import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { draftIdForSaveKey } from "../lib/draft-create-idempotency.ts";
import { handleSaveDraft } from "./drafts.ts";

function draftSaveClaimStub() {
	return {
		async claimDraftSave() {
			return { status: "claimed" as const, stalePromotions: [] };
		},
		async recordDraftSavePromotion() { return true; },
		async abortDraftSave() {
			return { status: "aborted" as const, destinationKeys: [] };
		},
		async getDraftSaveOutcome() { return { status: "missing" as const }; },
		async getCommittedDraftAttachmentScope() { return null; },
		async getDraftCreateReplay() { return { status: "missing" as const }; },
	};
}

function fixture(
	result: Record<string, unknown>,
	claimResult: Record<string, unknown> = {
		status: "claimed",
		stalePromotions: [],
	},
) {
	const writes: Array<Record<string, unknown>> = [];
	const claims: Array<Record<string, unknown>> = [];
	const stub = {
		...draftSaveClaimStub(),
		async claimDraftSave(input: Record<string, unknown>) {
			claims.push(input);
			return claimResult;
		},
		async getAttachment() { return null; },
		async getCommittedDraftAttachmentScope() {
			return typeof result.attachmentIdentityScope === "string"
				? result.attachmentIdentityScope
				: null;
		},
		async upsertDraft(input: Record<string, unknown>) {
			writes.push(input);
			return result;
		},
		async getEmail(id: string) {
			return {
				id,
				folder_id: "draft",
				draft_version: result.draftVersion,
				attachments: [],
			};
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);
	return { app, writes, claims };
}

test("an exact first-save retry reuses its claimed Draft identity", async () => {
	const saveKey = "10101010-1010-4010-8010-101010101010";
	const { app, claims } = fixture(
		{ status: "saved", draftVersion: 1, replacedAttachments: [] },
		{ status: "revision_in_progress" },
	);
	const request = () => app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "Recover me", draft_save_key: saveKey }),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal((await request()).status, 409);
	assert.equal((await request()).status, 409);
	assert.equal(claims.length, 2);
	const expectedDraftId = await draftIdForSaveKey("team@example.com", saveKey);
	assert.equal(claims[0]?.draftId, expectedDraftId);
	assert.equal(claims[1]?.draftId, expectedDraftId);
	assert.equal(claims[0]?.fingerprint, claims[1]?.fingerprint);
	assert.match(String(claims[0]?.claimToken), /^[0-9a-f-]{36}$/);
	assert.notEqual(claims[0]?.claimToken, claims[1]?.claimToken);
});

test("a delayed committed save replay reports a newer Draft as superseded", async () => {
	const { app } = fixture(
		{ status: "saved", draftVersion: 2, replacedAttachments: [] },
		{ status: "committed", draftId: "draft-1", committedVersion: 1 },
	);
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Original revision",
				draft_id: "draft-1",
				draft_version: 1,
				draft_save_key: "20202020-2020-4020-8020-202020202020",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "This draft save was superseded by a newer revision.",
		code: "draft_save_superseded",
		draftId: "draft-1",
		currentVersion: 2,
	});
});

test("a competing Draft revision is rejected before attachment storage", async () => {
	const { app, writes } = fixture(
		{ status: "saved", draftVersion: 8, replacedAttachments: [] },
		{ status: "revision_in_progress" },
	);
	let storageCalls = 0;
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Competing edit",
				draft_id: "draft-1",
				draft_version: 7,
				draft_save_key: crypto.randomUUID(),
				attachments: [{
					kind: "upload",
					uploadId: "10101010-1010-4010-8010-101010101010",
				}],
			}),
		},
		{
			BUCKET: {
				async get() { storageCalls++; return null; },
				async put() { storageCalls++; return null; },
				async delete() { storageCalls++; },
			},
		} as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "This draft revision is already being saved. Retry shortly.",
		code: "draft_save_in_progress",
		retryAfterMs: 500,
	});
	assert.equal(storageCalls, 0);
	assert.equal(writes.length, 0);
});

test("draft overwrite passes the expected version to the atomic upsert", async () => {
	const { app, writes, claims } = fixture({
		status: "saved",
		draftVersion: 8,
		replacedAttachments: [],
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/%20TEAM%40EXAMPLE.COM%20/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Revised",
				draft_id: "draft-1",
				draft_version: 7,
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 201);
	assert.equal(writes[0]!.id, "draft-1");
	assert.equal(writes[0]!.expectedVersion, 7);
	assert.equal(writes[0]!.sender, "team@example.com");
	const responseBody = await response.json() as {
		draft_version: number;
		attachment_save_scope: string;
	};
	assert.equal(responseBody.draft_version, 8);
	assert.equal(responseBody.attachment_save_scope, claims[0]?.claimToken);
	assert.equal(writes[0]!.saveClaimToken, claims[0]?.claimToken);
});

test("stale draft overwrite returns conflict and never replaces newer content", async () => {
	const { app } = fixture({ status: "version_conflict", currentVersion: 9 });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Stale edit",
				draft_id: "draft-1",
				draft_version: 7,
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Draft changed in another session. Reload it before saving.",
		currentVersion: 9,
	});
});

test("a concurrent create replay returns the winning attachment claim scope", async () => {
	const winningDraft = {
		id: "winning-draft",
		folder_id: "draft",
		draft_version: 1,
		attachments: [],
	};
	const { app } = fixture({
		status: "creation_replay",
		draftId: winningDraft.id,
		draft: winningDraft,
		attachmentIdentityScope: "winning-claim-token",
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Concurrent first save",
				draft_create_key: "10101010-1010-4010-8010-101010101010",
				draft_save_key: "20202020-2020-4020-8020-202020202020",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		...winningDraft,
		replayed: true,
		attachment_save_scope: "winning-claim-token",
	});
});

test("draft ID without a version is rejected before storage", async () => {
	const { app, writes } = fixture({ status: "saved", draftVersion: 2, replacedAttachments: [] });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "Missing version", draft_id: "draft-1" }),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.equal(writes.length, 0);
});

test("replaying a committed first save returns its authoritative draft without resolving spent uploads", async () => {
	const draft = {
		id: "draft-created-on-first-attempt",
		folder_id: "draft",
		draft_version: 1,
		attachments: [{ id: "stored-1", filename: "brief.pdf" }],
	};
	let upserts = 0;
	let attachmentReads = 0;
	let emailReads = 0;
	const stub = {
		...draftSaveClaimStub(),
		async getDraftCreateReplay(key: string, fingerprint: string) {
			assert.equal(key, "create-once-1");
			assert.ok(fingerprint.length > 0);
			return { status: "replay", draftId: draft.id, draft };
		},
		async getEmail(id: string) {
			emailReads++;
			assert.equal(id, draft.id);
			return draft;
		},
		async getAttachment() {
			attachmentReads++;
			return null;
		},
		async upsertDraft() {
			upserts++;
			throw new Error("must not write an exact replay");
		},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "First attempt already committed",
				draft_create_key: "create-once-1",
				attachments: [{
					kind: "upload",
					uploadId: "10101010-1010-4010-8010-101010101010",
				}],
			}),
		},
		{ BUCKET: { async get() { throw new Error("spent upload must not be read"); } } } as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		...draft,
		replayed: true,
		attachment_save_scope: "create-once-1",
	});
	assert.equal(upserts, 0);
	assert.equal(attachmentReads, 0);
	assert.equal(emailReads, 0);
});

test("a delayed first-save retry cannot claim a newer authoritative draft revision", async () => {
	let upserts = 0;
	const stub = {
		...draftSaveClaimStub(),
		async getDraftCreateReplay() {
			return {
				status: "superseded",
				draftId: "draft-created-on-first-attempt",
				currentVersion: 2,
			};
		},
		async upsertDraft() {
			upserts++;
			throw new Error("must not overwrite or replay the newer revision");
		},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Original first save",
				draft_create_key: "create-once-1",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "The original draft save was superseded by a newer revision.",
		code: "draft_create_superseded",
		draftId: "draft-created-on-first-attempt",
		currentVersion: 2,
	});
	assert.equal(upserts, 0);
});

test("a removed first Draft closes exact replay without creating a replacement", async () => {
	let upserts = 0;
	const stub = {
		...draftSaveClaimStub(),
		async getDraftCreateReplay() {
			return {
				status: "unavailable",
				draftId: "discarded-draft",
				currentVersion: 1,
				reason: "discarded",
			};
		},
		async upsertDraft() {
			upserts++;
			throw new Error("must not recreate a removed Draft");
		},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Already removed",
				draft_create_key: "create-once-removed",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "The original draft is no longer available for replay.",
		code: "draft_create_replay_unavailable",
		draftId: "discarded-draft",
		currentVersion: 1,
	});
	assert.equal(upserts, 0);
});

test("autosaving text reuses a large unchanged draft attachment without copying its bytes", async () => {
	const prior = {
		id: "draft-1",
		folder_id: "draft",
		draft_version: 7,
		attachments: [{
			id: "large-attachment",
			filename: "large.pdf",
			mimetype: "application/pdf",
			size: 25_000_000,
			content_id: null,
			disposition: "attachment",
		}],
	};
	let reads = 0;
	let writes = 0;
	let deletes = 0;
	let storedAttachments: unknown[] = [];
		const stub = {
			...draftSaveClaimStub(),
		async getEmail() {
			return { ...prior, draft_version: storedAttachments.length ? 8 : 7 };
		},
		async getAttachment() {
			reads++;
			throw new Error("unchanged draft attachment must not be resolved");
		},
		async upsertDraft(_input: unknown, attachments: unknown[]) {
			storedAttachments = attachments;
			return {
				status: "saved",
				draftVersion: 8,
				replacedAttachments: prior.attachments,
			};
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Only the text changed",
				draft_id: "draft-1",
				draft_version: 7,
				attachments: [{
					kind: "existing",
					emailId: "draft-1",
					attachmentId: "large-attachment",
				}],
			}),
		},
		{
			BUCKET: {
				async get() { reads++; throw new Error("must not read R2"); },
				async put() { writes++; },
				async delete() { deletes++; },
			},
		} as never,
	);

	assert.equal(response.status, 201);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
	assert.equal(deletes, 0);
	assert.deepEqual(storedAttachments, [{
		id: "large-attachment",
		email_id: "draft-1",
		filename: "large.pdf",
		mimetype: "application/pdf",
		size: 25_000_000,
		content_id: null,
		disposition: "attachment",
	}]);
});

test("repeated zero-copy draft saves preserve inline CID and erase ordinary legacy CID", async () => {
	let currentVersion = 7;
	let currentAttachments = [{
		id: "inline-chart",
		email_id: "draft-inline",
		filename: "chart.png",
		mimetype: "image/png",
		size: 3,
		content_id: "chart-1@mail-portal.local",
		disposition: "inline",
	}, {
		id: "ordinary-proposal",
		email_id: "draft-inline",
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: 4,
		content_id: "legacy-ordinary@mail-portal.local",
		disposition: "attachment",
	}];
	let reads = 0;
	let writes = 0;
	let deletes = 0;
		const stub = {
			...draftSaveClaimStub(),
		async getEmail() {
			return {
				id: "draft-inline",
				folder_id: "draft",
				draft_version: currentVersion,
				attachments: currentAttachments,
			};
		},
		async getAttachment() {
			reads++;
			throw new Error("retained inline attachment must not be resolved");
		},
		async upsertDraft(_input: unknown, attachments: typeof currentAttachments) {
			const replacedAttachments = currentAttachments;
			currentAttachments = attachments;
			currentVersion++;
			return { status: "saved", draftVersion: currentVersion, replacedAttachments };
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

	for (const version of [7, 8]) {
		const response = await app.request(
			"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					body: `Text revision ${version}<img src="cid:chart-1@mail-portal.local">`,
					draft_id: "draft-inline",
					draft_version: version,
					attachments: [{
						kind: "existing",
						emailId: "draft-inline",
						attachmentId: "inline-chart",
						// Stored metadata is authoritative; the client cannot downcast it.
						disposition: "attachment",
					}, {
						kind: "existing",
						emailId: "draft-inline",
						attachmentId: "ordinary-proposal",
						disposition: "inline",
					}],
				}),
			},
			{
				BUCKET: {
					async get() { reads++; throw new Error("must not read R2"); },
					async put() { writes++; },
					async delete() { deletes++; },
				},
			} as never,
		);
		assert.equal(response.status, 201);
	}

	assert.equal(currentVersion, 9);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
	assert.equal(deletes, 0);
	assert.deepEqual(currentAttachments, [{
		id: "inline-chart",
		email_id: "draft-inline",
		filename: "chart.png",
		mimetype: "image/png",
		size: 3,
		content_id: "chart-1@mail-portal.local",
		disposition: "inline",
	}, {
		id: "ordinary-proposal",
		email_id: "draft-inline",
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: 4,
		content_id: null,
		disposition: "attachment",
	}]);
});

test("draft API rejects a broken body-to-CID mapping before storage and rolls back only the new copy", async () => {
	const uploadId = "20202020-2020-4020-8020-202020202020";
	const stagingKey = `uploads/team@example.com/${uploadId}`;
	const objects = new Map<string, ArrayBuffer>([
		[stagingKey, new Uint8Array([1, 2, 3]).buffer],
	]);
	const promotionOwners = new Map<string, string>();
	let upserts = 0;
	const stub = {
		...draftSaveClaimStub(),
		async getAttachment() { return null; },
		async upsertDraft() {
			upserts++;
			return { status: "saved", draftVersion: 1, replacedAttachments: [] };
		},
		async getEmail() {
			return { id: "unexpected", folder_id: "draft", draft_version: 1, attachments: [] };
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: '<p>Broken</p><img src="cid:missing@mail-portal.local" data-mail-inline-image="v1">',
				attachments: [{
					kind: "upload",
					uploadId,
					disposition: "inline",
					contentId: "actual@mail-portal.local",
				}],
			}),
		},
		{
			BUCKET: {
				async get(key: string) {
					const bytes = objects.get(key);
					return bytes ? {
						customMetadata: {
							filename: "chart.png",
							type: "image/png",
							...(promotionOwners.has(key)
								? { promotionOwner: promotionOwners.get(key) }
								: {}),
						},
						httpMetadata: {},
						async arrayBuffer() { return bytes.slice(0); },
					} : null;
				},
					async put(
						key: string,
						bytes: ArrayBuffer,
						options?: {
							onlyIf?: { etagDoesNotMatch?: string };
							customMetadata?: { promotionOwner?: string };
						},
					) {
						if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
							return null;
						}
						objects.set(key, bytes.slice(0));
						if (options?.customMetadata?.promotionOwner) {
							promotionOwners.set(key, options.customMetadata.promotionOwner);
						}
						return { etag: "created" };
					},
				async delete(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
				},
			},
		} as never,
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "An inline image in the message is missing its attachment (missing@mail-portal.local).",
		code: "inline_image_missing_attachment",
	});
	assert.equal(upserts, 0);
	assert.equal(objects.has(stagingKey), true);
	assert.equal(objects.size, 1);
});
