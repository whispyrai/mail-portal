import assert from "node:assert/strict";
import test from "node:test";
import {
	AttachmentPreparationError,
	classifyAttachmentPreparationFailure,
	completeAttachmentPromotion,
	attachmentSha256,
	attachmentKeyPrefix,
	outboundAttachmentBytesMatch,
	outboundAttachmentByteIdentities,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
	uploadKey,
} from "./attachments.ts";

test("attachment preparation exposes only typed client failures", () => {
	assert.deepEqual(
		classifyAttachmentPreparationFailure(
			new AttachmentPreparationError(
				"attachment_source_unavailable",
				409,
				"Re-attach the file and try again.",
			),
		),
		{
			status: 409,
			code: "attachment_source_unavailable",
			message: "Re-attach the file and try again.",
		},
	);
	assert.deepEqual(
		classifyAttachmentPreparationFailure(
			new Error("private storage endpoint and credential detail"),
		),
		{
			status: 503,
			code: "attachment_preparation_unavailable",
			message: "Attachments could not be prepared right now. Retry this exact send.",
		},
	);
});
import {
	R2_OBJECT_KEY_MAX_BYTES,
	safeAttachmentStorageFilename,
} from "../../shared/attachment-filename.ts";

function bucketFixture(options: { failDelete?: boolean } = {}) {
	const objects = new Map<string, ArrayBuffer>();
	const metadata = new Map<
		string,
		{
			filename: string;
			type: string;
			promotionOwner?: string;
			contentSha256?: string;
		}
	>();
	const deleted: string[][] = [];
	return {
		objects,
		metadata,
		deleted,
		bucket: {
			async get(key: string) {
				const bytes = objects.get(key);
				if (!bytes) return null;
				return {
					customMetadata: metadata.get(key) ?? {
						filename: "proposal.pdf",
						type: "application/pdf",
					},
					httpMetadata: {},
					async arrayBuffer() {
						return bytes.slice(0);
					},
				};
			},
			async put(
				key: string,
				bytes: ArrayBuffer,
				options?: {
					onlyIf?: { etagDoesNotMatch?: string };
					customMetadata?: {
						filename?: string;
						type?: string;
						promotionOwner?: string;
						contentSha256?: string;
					};
				},
			) {
				if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
					return null;
				}
				objects.set(key, bytes.slice(0));
				if (options?.customMetadata) {
					metadata.set(key, {
						filename: options.customMetadata.filename ?? "proposal.pdf",
						type: options.customMetadata.type ?? "application/pdf",
						...options.customMetadata,
					});
				}
				return { etag: "created" };
			},
			async delete(keys: string | string[]) {
				const list = Array.isArray(keys) ? keys : [keys];
				deleted.push(list);
				if (options.failDelete) throw new Error("R2 unavailable");
				for (const key of list) objects.delete(key);
			},
		} as never,
	};
}

test("a conditional put that commits then throws is confirmed by exact owner readback", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-ambiguous");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const normalPut = fixture.bucket.put.bind(fixture.bucket);
	let threwAfterCommit = false;
	const bucket = {
		...fixture.bucket,
		async put(...args: Parameters<typeof normalPut>) {
			const result = await normalPut(...args);
			if (!threwAfterCommit) {
				threwAfterCommit = true;
				throw new Error("R2 response lost");
			}
			return result;
		},
	};
	const promotion = await resolveAndPromoteAttachments(
		bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-ambiguous",
		[{ kind: "upload", uploadId: "upload-ambiguous" }],
		actor,
		{ promotionOwner: "save-ambiguous" },
	);

	assert.equal(promotion.destinationKeys.length, 1);
	assert.equal(fixture.objects.has(promotion.destinationKeys[0]!), true);
});

test("an unconfirmable committed put queues the full owner-scoped destination intent", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-unconfirmable");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const normalGet = fixture.bucket.get.bind(fixture.bucket);
	const normalPut = fixture.bucket.put.bind(fixture.bucket);
	let putThrew = false;
	let intendedKeys: string[] = [];
	const queued: Array<{ keys: string[]; owner?: string }> = [];
	const bucket = {
		...fixture.bucket,
		async get(key: string) {
			if (putThrew && key.startsWith("attachments/")) {
				throw new Error("R2 confirmation read unavailable");
			}
			return normalGet(key);
		},
		async put(...args: Parameters<typeof normalPut>) {
			await normalPut(...args);
			putThrew = true;
			throw new Error("R2 response lost");
		},
	};

	await assert.rejects(
		resolveAndPromoteAttachments(
			bucket,
			{
				async getAttachment() {
					return null;
				},
				async queueAttachmentCleanup(
					_emailId: string,
					keys: string[],
					_actor: unknown,
					owner?: string,
				) {
					queued.push({ keys, owner });
				},
			},
			"team@example.com",
			"draft-unconfirmable",
			[{ kind: "upload", uploadId: "upload-unconfirmable" }],
			actor,
			{
				promotionOwner: "save-unconfirmable",
				async recordDestinationIntent(keys) {
					intendedKeys = keys;
				},
			},
		),
		/R2 confirmation read unavailable/,
	);

	assert.equal(intendedKeys.length, 1);
	assert.deepEqual(queued, [
		{ keys: intendedKeys, owner: "save-unconfirmable" },
	]);
});

const actor = { kind: "user" as const, id: "user-1" };

test("a failed durable destination-intent gate prevents every permanent R2 write", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-alarm-gate");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	let destinationPutCount = 0;
	const normalPut = fixture.bucket.put.bind(fixture.bucket);
	const bucket = {
		...fixture.bucket,
		async put(...args: Parameters<typeof normalPut>) {
			destinationPutCount += 1;
			return normalPut(...args);
		},
	};

	await assert.rejects(
		resolveAndPromoteAttachments(
			bucket,
			{
				async getAttachment() {
					return null;
				},
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"draft-alarm-gate",
			[{ kind: "upload", uploadId: "upload-alarm-gate" }],
			actor,
			{
				promotionOwner: "claim-alarm-gate",
				async recordDestinationIntent() {
					throw new Error("alarm scheduling unavailable");
				},
			},
		),
		/alarm scheduling unavailable/,
	);
	assert.equal(destinationPutCount, 0);
	assert.equal(fixture.objects.has(stagingKey), true);
});

test("staging survives promotion until the durable enqueue succeeds", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-1");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const queued: string[][] = [];
	const stub = {
		async getAttachment() {
			return null;
		},
		async queueAttachmentCleanup(_emailId: string, keys: string[]) {
			queued.push(keys);
		},
	};

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"email-1",
		[{ kind: "upload", uploadId: "upload-1" }],
		actor,
	);

	assert.equal(fixture.objects.has(stagingKey), true);
	const manifest = outboundAttachmentByteIdentities(promotion.storedMetadata);
	assert.equal(manifest.length, 1);
	assert.equal(manifest[0]?.byteLength, 3);
	assert.match(manifest[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
	assert.equal(
		fixture.metadata.get(promotion.destinationKeys[0]!)?.contentSha256,
		manifest[0]?.sha256,
	);
	assert.equal(fixture.objects.has(promotion.destinationKeys[0]!), true);
	assert.deepEqual(fixture.deleted, []);

	await completeAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);
	assert.equal(fixture.objects.has(stagingKey), false);
	assert.deepEqual(queued, []);
});

test("same-size replacement bytes cannot satisfy an immutable attachment identity", async () => {
	const original = new TextEncoder().encode("AAAA").buffer;
	const replacement = new TextEncoder().encode("BBBB").buffer;
	const identity = {
		id: "attachment-1",
		byteLength: original.byteLength,
		sha256: (await attachmentSha256(original)).hex,
	};
	assert.equal(await outboundAttachmentBytesMatch(original, identity), true);
	assert.equal(
		await outboundAttachmentBytesMatch(replacement, identity),
		false,
	);
});

test("promotion re-budgets a staging filename for the actual destination prefix", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-long");
	const sourceFilename = safeAttachmentStorageFilename(
		`${"😀".repeat(400)}.pdf`,
		attachmentKeyPrefix(crypto.randomUUID(), crypto.randomUUID()),
	);
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	fixture.metadata.set(stagingKey, {
		filename: sourceFilename,
		type: "application/pdf",
	});

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		`draft_recovered_${crypto.randomUUID()}`,
		[{ kind: "upload", uploadId: "upload-long" }],
		actor,
	);
	const destinationKey = promotion.destinationKeys[0]!;
	const filename = promotion.storedMetadata[0]!.filename;

	assert.ok(
		new TextEncoder().encode(destinationKey).byteLength <=
			R2_OBJECT_KEY_MAX_BYTES,
	);
	assert.notEqual(filename, sourceFilename);
	assert.equal(destinationKey.endsWith(`/${filename}`), true);
	assert.equal(promotion.sesAttachments[0]?.filename, filename);
});

test("failed enqueue removes destination copies but retains staging for retry", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-1");
	fixture.objects.set(stagingKey, new Uint8Array([1]).buffer);
	const stub = {
		async getAttachment() {
			return null;
		},
		async queueAttachmentCleanup() {},
	};
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"email-1",
		[{ kind: "upload", uploadId: "upload-1" }],
		actor,
	);

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);

	assert.equal(fixture.objects.has(stagingKey), true);
	assert.equal(fixture.objects.has(promotion.destinationKeys[0]!), false);
});

test("rollback only removes permanent objects owned by the promotion receipt", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-owned-rollback");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-owned-rollback",
		[{ kind: "upload", uploadId: "upload-owned-rollback" }],
		actor,
		{ promotionOwner: "claim-a" },
	);

	assert.equal(promotion.promotionOwner, "claim-a");
	const destinationKey = promotion.destinationKeys[0]!;
	fixture.metadata.set(destinationKey, {
		filename: promotion.storedMetadata[0]!.filename,
		type: promotion.storedMetadata[0]!.mimetype,
		promotionOwner: "claim-b",
	});

	await rollbackAttachmentPromotion(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"draft-owned-rollback",
		promotion,
		actor,
	);

	assert.equal(fixture.objects.has(destinationKey), true);
});

test("a reclaimed Draft claim cannot be blocked by an expired generation's late write", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-reclaimed"),
		new Uint8Array([1, 2, 3]).buffer,
	);
	const promote = (claimToken: string) =>
		resolveAndPromoteAttachments(
		fixture.bucket,
			{
				async getAttachment() {
					return null;
				},
				async queueAttachmentCleanup() {},
			},
		"team@example.com",
		"draft-reclaimed",
		[{ kind: "upload", uploadId: "upload-reclaimed" }],
		actor,
		{ identityScope: claimToken, promotionOwner: claimToken },
	);

	const oldPlan = await promote("claim-old");
	await rollbackAttachmentPromotion(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"draft-reclaimed",
		oldPlan,
		actor,
	);
	const lateOldWrite = await promote("claim-old");
	const replacement = await promote("claim-new");

	assert.notDeepEqual(
		lateOldWrite.destinationKeys,
		replacement.destinationKeys,
	);
	assert.equal(fixture.objects.has(lateOldWrite.destinationKeys[0]!), true);
	assert.equal(fixture.objects.has(replacement.destinationKeys[0]!), true);
});

test("lost-response retry cannot roll back the committed attachment winner", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-retry");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const stub = {
		async getAttachment() {
			return null;
		},
		async queueAttachmentCleanup() {},
	};
	const promote = () =>
		resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"draft-1",
		[{ kind: "upload" as const, uploadId: "upload-retry" }],
		actor,
	);

	const committed = await promote();
	const staleRetry = await promote();
	assert.equal(committed.destinationKeys.length, 1);
	assert.equal(staleRetry.destinationKeys.length, 0);

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"draft-1",
		staleRetry,
		actor,
	);
	assert.equal(fixture.objects.has(committed.destinationKeys[0]!), true);
});

test("concurrent identical promotion loser never owns the winner's cleanup", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-concurrent"),
		new Uint8Array([4, 5, 6]).buffer,
	);
	const stub = {
		async getAttachment() {
			return null;
		},
		async queueAttachmentCleanup() {},
	};
	const promotions = await Promise.all(
		[0, 1].map(() =>
		resolveAndPromoteAttachments(
			fixture.bucket,
			stub,
			"team@example.com",
			"draft-1",
			[{ kind: "upload", uploadId: "upload-concurrent" }],
			actor,
		),
		),
	);
	const winner = promotions.find(
		(promotion) => promotion.destinationKeys.length === 1,
	)!;
	const loser = promotions.find(
		(promotion) => promotion.destinationKeys.length === 0,
	)!;
	assert.ok(winner);
	assert.ok(loser);

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"draft-1",
		loser,
		actor,
	);
	assert.equal(fixture.objects.has(winner.destinationKeys[0]!), true);
});

test("failed destination cleanup is durably queued", async () => {
	const fixture = bucketFixture({ failDelete: true });
	const queued: Array<{ emailId: string; keys: string[]; actor: unknown }> = [];
	const stub = {
		async getAttachment() {
			return null;
		},
		async queueAttachmentCleanup(
			emailId: string,
			keys: string[],
			cleanupActor: unknown,
		) {
			queued.push({ emailId, keys, actor: cleanupActor });
		},
	};
	const promotion = {
		sesAttachments: [],
		storedMetadata: [],
		stagingKeys: ["uploads/team/upload-1"],
		destinationKeys: ["attachments/email-1/attachment-1/file.pdf"],
	};

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);

	assert.deepEqual(queued, [
		{
			emailId: "email-1",
			keys: promotion.destinationKeys,
			actor,
		},
	]);
});

test("fresh inline upload promotion carries Content-ID into SES and stored metadata", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-inline"),
		new Uint8Array([10, 11, 12]).buffer,
	);
	fixture.metadata.set(uploadKey("team@example.com", "upload-inline"), {
		filename: "diagram.png",
		type: "image/png",
	});
	fixture.objects.set(
		uploadKey("team@example.com", "upload-ordinary"),
		new Uint8Array([13, 14]).buffer,
	);

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-1",
		[
			{
				kind: "upload",
				uploadId: "upload-inline",
				disposition: "inline",
				contentId: "diagram-1@mail-portal.local",
			},
			{
				kind: "upload",
				uploadId: "upload-ordinary",
				disposition: "attachment",
			},
		],
		actor,
	);

	assert.equal(
		promotion.sesAttachments[0]?.contentId,
		"diagram-1@mail-portal.local",
	);
	assert.equal(
		promotion.storedMetadata[0]?.content_id,
		"diagram-1@mail-portal.local",
	);
	assert.equal(promotion.storedMetadata[0]?.disposition, "inline");
	assert.equal(promotion.sesAttachments[1]?.contentId, undefined);
	assert.equal(promotion.storedMetadata[1]?.content_id, null);
	assert.equal(promotion.storedMetadata[1]?.disposition, "attachment");
});

test("fresh inline upload promotion rejects a resolved non-image MIME", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-pdf");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);

	await assert.rejects(
		resolveAndPromoteAttachments(
			fixture.bucket,
			{
				async getAttachment() {
					return null;
				},
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"draft-pdf",
			[
				{
				kind: "upload",
				uploadId: "upload-pdf",
				disposition: "inline",
				contentId: "pdf@mail-portal.local",
				},
			],
			actor,
		),
		/inline.*image|image.*inline/i,
	);
	assert.equal(fixture.objects.has(stagingKey), true);
	assert.equal(fixture.objects.size, 1);
});

test("existing inline attachment promotion preserves its authoritative Content-ID", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		"attachments/draft-1/inline-1/signature.png",
		new Uint8Array([4, 5, 6]).buffer,
	);
	const stub = {
		async getAttachment() {
			return {
				id: "inline-1",
				email_id: "draft-1",
				filename: "signature.png",
				mimetype: "image/png",
				size: 3,
				content_id: "signature@example.com",
				disposition: "inline",
			};
		},
		async queueAttachmentCleanup() {},
	};

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"outbound-1",
		[
			{
				kind: "existing",
				emailId: "draft-1",
				attachmentId: "inline-1",
				// Existing metadata is authoritative even if a client downcasts it.
				disposition: "attachment",
			},
		],
		actor,
	);

	assert.deepEqual(promotion.sesAttachments, [
		{
			content: "BAUG",
			filename: "signature.png",
			type: "image/png",
			disposition: "inline",
			contentId: "signature@example.com",
		},
	]);
	assert.equal(
		promotion.storedMetadata[0]?.content_id,
		"signature@example.com",
	);
	assert.equal(promotion.storedMetadata[0]?.disposition, "inline");
});

test("existing attachment promotion preserves authoritative MIME until the SES sink", async () => {
	const fixture = bucketFixture();
	const longMime = `image/vnd.${"a".repeat(72)}`;
	fixture.objects.set(
		"attachments/draft-long/inline-long/diagram.png",
		new Uint8Array([4, 5, 6]).buffer,
	);
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return {
					id: "inline-long",
					email_id: "draft-long",
					filename: "diagram.png",
					mimetype: longMime,
					size: 3,
					content_id: null,
					disposition: "attachment",
				};
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"outbound-long",
		[{ kind: "existing", emailId: "draft-long", attachmentId: "inline-long" }],
		actor,
	);
	assert.equal(promotion.storedMetadata[0]?.mimetype, longMime);
	assert.equal(promotion.sesAttachments[0]?.type, longMime);
});

test("existing inline attachment promotion rejects Content-ID beyond the SES boundary", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		"attachments/draft-long/inline-long/diagram.png",
		new Uint8Array([4, 5, 6]).buffer,
	);
	await assert.rejects(
		resolveAndPromoteAttachments(
			fixture.bucket,
			{
				async getAttachment() {
					return {
						id: "inline-long",
						email_id: "draft-long",
						filename: "diagram.png",
						mimetype: "image/png",
						size: 3,
						content_id: `${"a".repeat(67)}@example.com`,
						disposition: "inline",
					};
				},
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"outbound-long",
			[
				{
					kind: "existing",
					emailId: "draft-long",
					attachmentId: "inline-long",
				},
			],
			actor,
		),
		/Content-ID.*SES/i,
	);
	assert.equal(fixture.objects.size, 1);
});

test("existing ordinary metadata cannot carry a legacy Content-ID into promotion", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		"attachments/draft-legacy/ordinary-1/proposal.pdf",
		new Uint8Array([4, 5, 6]).buffer,
	);
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return {
					id: "ordinary-1",
					email_id: "draft-legacy",
					filename: "proposal.pdf",
					mimetype: "application/pdf",
					size: 3,
					content_id: "legacy-ordinary@example.com",
					disposition: "attachment",
				};
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"outbound-legacy",
		[
			{
			kind: "existing",
			emailId: "draft-legacy",
			attachmentId: "ordinary-1",
			},
		],
		actor,
	);

	assert.equal(promotion.sesAttachments[0]?.contentId, undefined);
	assert.equal(promotion.storedMetadata[0]?.content_id, null);
	assert.equal(promotion.storedMetadata[0]?.disposition, "attachment");
});

test("Content-ID survives upload to draft storage and subsequent send promotion", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-chart"),
		new Uint8Array([7, 8, 9]).buffer,
	);
	fixture.metadata.set(uploadKey("team@example.com", "upload-chart"), {
		filename: "chart.png",
		type: "image/png",
	});
	const first = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return null;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-2",
		[
			{
			kind: "upload",
			uploadId: "upload-chart",
			disposition: "inline",
			contentId: "chart@example.com",
			},
		],
		actor,
	);
	const savedInline = first.storedMetadata[0];
	assert.ok(savedInline);
	assert.equal(first.sesAttachments[0]?.contentId, "chart@example.com");
	assert.equal(savedInline.content_id, "chart@example.com");

	const second = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return savedInline;
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"outbound-2",
		[
			{
				kind: "existing",
				emailId: "draft-2",
				attachmentId: savedInline.id,
			},
		],
		actor,
	);

	assert.equal(second.storedMetadata[0]?.content_id, "chart@example.com");
	assert.equal(second.storedMetadata[0]?.disposition, "inline");
	assert.equal(second.sesAttachments[0]?.contentId, "chart@example.com");
});

test("existing attachment references fail closed when the email identity does not match", async () => {
	const fixture = bucketFixture();
	await assert.rejects(
		resolveAndPromoteAttachments(
			fixture.bucket,
			{
				async getAttachment() {
					return {
						email_id: "other-draft",
						filename: "private.pdf",
						mimetype: "application/pdf",
						size: 3,
					};
				},
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"outbound-3",
			[
				{
					kind: "existing",
					emailId: "expected-draft",
					attachmentId: "attachment-1",
				},
			],
			actor,
		),
		/A referenced attachment does not belong to the referenced email/,
	);
});
