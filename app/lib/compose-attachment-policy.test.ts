import assert from "node:assert/strict";
import test from "node:test";
import {
	bodyReferencesInlineAttachment,
	evaluateComposeAttachments,
	evaluateStoredDraftAttachments,
	prepareSavedComposeAttachmentReconciliation,
	recoverComposeAttachments,
	reconcileSavedComposeAttachments,
	type ComposeAttachmentRecord,
} from "./compose-attachment-policy.ts";
import {
	attachmentStorageId,
	attachmentStorageKeyPrefix,
	safeAttachmentStorageFilename,
} from "../../shared/attachment-filename.ts";

test("prepared Draft reconciliation applies to the latest attachment state", async () => {
	const savedAtStart: ComposeAttachmentRecord = {
		localId: "saved-at-start",
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: 42,
		status: "ready",
		disposition: "attachment",
		uploadId: "upload-saved",
	};
	const addedDuringSave: ComposeAttachmentRecord = {
		...savedAtStart,
		localId: "added-during-save",
		filename: "notes.pdf",
		uploadId: "upload-new",
	};
	const storedId = await attachmentStorageId(
		"draft-1",
		{ kind: "upload", uploadId: "upload-saved" },
		0,
		"save-1",
	);
	const apply = await prepareSavedComposeAttachmentReconciliation(
		[savedAtStart],
		"draft-1",
		[{
			id: storedId,
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}],
		"save-1",
	);

	const result = apply([savedAtStart, addedDuringSave]);
	assert.equal(result.length, 2);
	assert.deepEqual(result[0]?.existing, {
		emailId: "draft-1",
		attachmentId: storedId,
	});
	assert.equal(result[1], addedDuringSave);
	assert.deepEqual(apply([addedDuringSave]), [addedDuringSave]);
});

test("compose recovery turns only interrupted uploads into explicit retryable errors", () => {
	const originalFile = new File(["proposal"], "proposal.pdf", {
		type: "application/pdf",
	});
	const ready: ComposeAttachmentRecord = {
		localId: "ready",
		filename: "saved.pdf",
		mimetype: "application/pdf",
		size: 4,
		status: "ready",
		disposition: "attachment",
		existing: { emailId: "draft-1", attachmentId: "stored-1" },
	};
	const interrupted: ComposeAttachmentRecord = {
		localId: "uploading",
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: originalFile.size,
		status: "uploading",
		disposition: "inline",
		contentId: "proposal@mail-portal.local",
		file: originalFile,
		uploadId: "unconfirmed-upload",
		existing: { emailId: "draft-1", attachmentId: "unusable" },
	};
	const rejected: ComposeAttachmentRecord = {
		localId: "rejected",
		filename: "unsafe.exe",
		mimetype: "application/octet-stream",
		size: 3,
		status: "rejected",
		disposition: "attachment",
		error: "Unsupported file.",
	};
	const failed: ComposeAttachmentRecord = {
		localId: "failed",
		filename: "failed.pdf",
		mimetype: "application/pdf",
		size: 3,
		status: "error",
		disposition: "attachment",
		error: "Network unavailable.",
		file: originalFile,
	};

	const recovered = recoverComposeAttachments([
		ready,
		interrupted,
		rejected,
		failed,
	]);

	assert.strictEqual(recovered[0], ready);
	assert.strictEqual(recovered[2], rejected);
	assert.strictEqual(recovered[3], failed);
	assert.deepEqual(recovered[1], {
		...interrupted,
		status: "error",
		error: "The upload was interrupted. Retry it or remove the file.",
		uploadId: undefined,
		existing: undefined,
	});
	assert.strictEqual(recovered[1]?.file, originalFile);
	assert.equal(
		recovered.some((attachment) => attachment.status === "uploading"),
		false,
	);
	const policy = evaluateComposeAttachments(recovered);
	assert.equal(policy.ok, false);
	if (!policy.ok) assert.match(policy.error, /interrupted.*Retry/i);
});

test("a completed save promotes only attachments still present and preserves later additions", async () => {
	const current = [
		{
			localId: "kept",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 42,
			status: "ready" as const,
			disposition: "attachment" as const,
			uploadId: "upload-1",
		},
		{
			localId: "added-later",
			filename: "notes.txt",
			mimetype: "text/plain",
			size: 12,
			status: "ready" as const,
			disposition: "attachment" as const,
			uploadId: "upload-2",
		},
	];
	const keptStoredId = await attachmentStorageId(
		"draft-1",
		{ kind: "upload", uploadId: "upload-1" },
		0,
	);
	const removedStoredId = await attachmentStorageId(
		"draft-1",
		{ kind: "upload", uploadId: "upload-removed" },
		0,
	);
	const result = await reconcileSavedComposeAttachments(
		current,
		[
			current[0],
			{
				localId: "removed-during-save",
				filename: "removed.png",
				mimetype: "image/png",
				size: 99,
				status: "ready" as const,
				disposition: "inline" as const,
				uploadId: "upload-removed",
			},
		],
		"draft-1",
		[
			{
				id: keptStoredId,
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				size: 42,
				disposition: "attachment",
			},
			{
				id: removedStoredId,
				filename: "removed.png",
				mimetype: "image/png",
				size: 99,
				disposition: "inline",
			},
		],
	);

	assert.deepEqual(result, [
		{
			localId: "kept",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 42,
			status: "ready",
			disposition: "attachment",
			uploadId: undefined,
			error: undefined,
			contentId: undefined,
			existing: { emailId: "draft-1", attachmentId: keptStoredId },
		},
		current[1],
	]);
});

test("draft reconciliation accepts a server-normalized destination filename", async () => {
	const source: ComposeAttachmentRecord = {
		localId: "long-upload",
		filename: `${"😀".repeat(240)}.pdf`,
		mimetype: "application/pdf",
		size: 42,
		status: "ready",
		disposition: "attachment",
		uploadId: "upload-long",
	};
	const storedId = await attachmentStorageId(
		"draft_recovered_snapshot-1",
		{ kind: "upload", uploadId: "upload-long" },
		0,
		"save-1",
	);
	const normalizedFilename = safeAttachmentStorageFilename(
		source.filename,
		attachmentStorageKeyPrefix(
			"draft_recovered_snapshot-1",
			storedId,
		),
	);

	const result = await reconcileSavedComposeAttachments(
		[source],
		[source],
		"draft_recovered_snapshot-1",
		[{
			id: storedId,
			filename: normalizedFilename,
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}],
		"save-1",
	);

	assert.equal(result[0]?.status, "ready");
	assert.equal(result[0]?.filename, normalizedFilename);
	assert.deepEqual(result[0]?.existing, {
		emailId: "draft_recovered_snapshot-1",
		attachmentId: storedId,
	});
});

test("draft reconciliation preserves duplicate file identity across reversed storage order", async () => {
	const kept: ComposeAttachmentRecord = {
		localId: "kept",
		filename: "kept.pdf",
		mimetype: "application/pdf",
		size: 42,
		status: "ready",
		disposition: "attachment",
		uploadId: "upload-kept",
	};
	const removed: ComposeAttachmentRecord = {
		...kept,
		localId: "removed",
		filename: "kept.pdf",
		uploadId: "upload-removed",
	};
	const keptStoredId = await attachmentStorageId(
		"draft-1",
		{ kind: "upload", uploadId: "upload-kept" },
		0,
	);
	const removedStoredId = await attachmentStorageId(
		"draft-1",
		{ kind: "upload", uploadId: "upload-removed" },
		0,
	);

	const result = await reconcileSavedComposeAttachments(
		[kept],
		[kept, removed],
		"draft-1",
		[{
			id: removedStoredId,
			filename: "kept.pdf",
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}, {
			id: keptStoredId,
			filename: "kept.pdf",
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}],
	);

	assert.equal(result.length, 1);
	assert.equal(result[0]?.filename, "kept.pdf");
	assert.deepEqual(result[0]?.existing, {
		emailId: "draft-1",
		attachmentId: keptStoredId,
	});
});

test("draft reconciliation preserves identity when long filenames normalize identically", async () => {
	const draftId = "draft_recovered_snapshot-1";
	const kept: ComposeAttachmentRecord = {
		localId: "kept-long",
		filename: `${"😀".repeat(400)}-kept.pdf`,
		mimetype: "application/pdf",
		size: 42,
		status: "ready",
		disposition: "attachment",
		uploadId: "upload-kept-long",
	};
	const removed: ComposeAttachmentRecord = {
		...kept,
		localId: "removed-long",
		filename: `${"😀".repeat(400)}-removed.pdf`,
		uploadId: "upload-removed-long",
	};
	const keptStoredId = await attachmentStorageId(
		draftId,
		{ kind: "upload", uploadId: kept.uploadId! },
		0,
	);
	const removedStoredId = await attachmentStorageId(
		draftId,
		{ kind: "upload", uploadId: removed.uploadId! },
		0,
	);
	const keptFilename = safeAttachmentStorageFilename(
		kept.filename,
		attachmentStorageKeyPrefix(draftId, keptStoredId),
	);
	const removedFilename = safeAttachmentStorageFilename(
		removed.filename,
		attachmentStorageKeyPrefix(draftId, removedStoredId),
	);
	assert.equal(keptFilename, removedFilename);

	const result = await reconcileSavedComposeAttachments(
		[kept],
		[kept, removed],
		draftId,
		[{
			id: removedStoredId,
			filename: removedFilename,
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}, {
			id: keptStoredId,
			filename: keptFilename,
			mimetype: "application/pdf",
			size: 42,
			disposition: "attachment",
		}],
	);

	assert.equal(result[0]?.filename, keptFilename);
	assert.equal(result[0]?.existing?.attachmentId, keptStoredId);
});

test("ready uploads and existing draft files become outgoing references without losing inline disposition", () => {
	const result = evaluateComposeAttachments([
		{
			filename: "diagram.png",
			mimetype: "image/png",
			status: "ready",
			uploadId: "upload-1",
			disposition: "inline",
			contentId: "diagram-1@mail-portal.local",
		},
		{
			filename: "signature.png",
			status: "ready",
			existing: { emailId: "draft-1", attachmentId: "inline-1" },
			disposition: "inline",
		},
	]);

	assert.deepEqual(result, {
		ok: true,
		refs: [
			{
				kind: "upload",
				uploadId: "upload-1",
				disposition: "inline",
				contentId: "diagram-1@mail-portal.local",
			},
			{
				kind: "existing",
				emailId: "draft-1",
				attachmentId: "inline-1",
				disposition: "inline",
			},
		],
	});
});

test("save and send validate authored inline nodes against the exact attachment set", () => {
	const attachment = {
		filename: "diagram.png",
		mimetype: "image/png",
		status: "ready" as const,
		uploadId: "upload-1",
		disposition: "inline" as const,
		contentId: "diagram@mail-portal.local",
	};
	const body = '<p>See diagram</p><img src="cid:DIAGRAM@MAIL-PORTAL.LOCAL" data-mail-inline-image="v1">';
	assert.equal(evaluateComposeAttachments([attachment], body).ok, true);
	const missing = evaluateComposeAttachments([], body);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.error, /missing its attachment/);

	assert.equal(
		evaluateStoredDraftAttachments(
			"draft-1",
			[{
				id: "image-1",
				filename: "diagram.png",
				mimetype: "image/png",
				size: 10,
				disposition: "inline",
				content_id: "diagram@mail-portal.local",
			}],
			body,
		).ok,
		true,
	);
});

test("fresh upload references fail closed when Content-ID does not match disposition", () => {
	const missing = evaluateComposeAttachments([
		{
			filename: "inline.png",
			status: "ready",
			uploadId: "upload-inline",
			disposition: "inline",
		},
	]);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.error, /valid Content-ID/i);

	const ordinaryOverride = evaluateComposeAttachments([
		{
			filename: "proposal.pdf",
			status: "ready",
			uploadId: "upload-ordinary",
			disposition: "attachment",
			contentId: "proposal@mail-portal.local",
		},
	]);
	assert.equal(ordinaryOverride.ok, false);
	if (!ordinaryOverride.ok) assert.match(ordinaryOverride.error, /only valid for inline/i);

	const nonImageInline = evaluateComposeAttachments([
		{
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			status: "ready",
			uploadId: "upload-pdf",
			disposition: "inline",
			contentId: "proposal@mail-portal.local",
		},
	]);
	assert.equal(nonImageInline.ok, false);
	if (!nonImageInline.ok) assert.match(nonImageInline.error, /image/i);
});

test("an upload failure blocks draft save and send with file-specific recovery copy", () => {
	assert.deepEqual(
		evaluateComposeAttachments([
			{
				filename: "quarterly-report.pdf",
				status: "error",
				error: "The upload connection was interrupted.",
			},
		]),
		{
			ok: false,
			error:
				'"quarterly-report.pdf" could not be attached: The upload connection was interrupted. Retry the upload or remove the file before saving or sending.',
		},
	);
});

test("a rejected attachment blocks draft save and send with the rejection reason", () => {
	assert.deepEqual(
		evaluateComposeAttachments([
			{
				filename: "unsafe.exe",
				status: "rejected",
				error: "unsafe.exe: .exe files can't be emailed.",
			},
		]),
		{
			ok: false,
			error:
				'"unsafe.exe" was rejected: unsafe.exe: .exe files can\'t be emailed. Remove it or choose a supported file before saving or sending.',
		},
	);
});

test("a ready-looking attachment without exactly one outgoing reference is blocked", () => {
	assert.deepEqual(
		evaluateComposeAttachments([
			{ filename: "missing.pdf", status: "ready" },
		]),
		{
			ok: false,
			error:
				'"missing.pdf" is not attached to an outgoing file. Retry the upload or remove the file before saving or sending.',
		},
	);

	assert.equal(
		evaluateComposeAttachments([
			{
				filename: "ambiguous.pdf",
				status: "ready",
				uploadId: "upload-1",
				existing: { emailId: "draft-1", attachmentId: "attachment-1" },
			},
		]).ok,
		false,
	);
});

test("an attachment still uploading blocks draft save and send", () => {
	assert.deepEqual(
		evaluateComposeAttachments([
			{ filename: "large-deck.pdf", status: "uploading" },
		]),
		{
			ok: false,
			error:
				'Wait for "large-deck.pdf" to finish uploading before saving or sending.',
		},
	);
});

test("one-click draft send preserves every stored attachment including inline parts", () => {
	assert.deepEqual(
		evaluateStoredDraftAttachments("draft-1", [
			{
				id: "file-1",
				filename: "brief.pdf",
				mimetype: "application/pdf",
				size: 42,
				disposition: "attachment",
			},
			{
				id: "image-1",
				filename: "logo.png",
				mimetype: "image/png",
				size: 24,
				content_id: "logo@example.com",
				disposition: "inline",
			},
		]),
		{
			ok: true,
			refs: [
				{
					kind: "existing",
					emailId: "draft-1",
					attachmentId: "file-1",
					disposition: "attachment",
				},
				{
					kind: "existing",
					emailId: "draft-1",
					attachmentId: "image-1",
					disposition: "inline",
				},
			],
		},
	);
});

test("one-click draft send fails closed when a stored attachment has no exact identity", () => {
	assert.deepEqual(
		evaluateStoredDraftAttachments("draft-1", [
			{
				id: "",
				filename: "broken.pdf",
				mimetype: "application/pdf",
				size: 42,
			},
		]),
		{
			ok: false,
			error:
				'"broken.pdf" is not attached to an outgoing file. Retry the upload or remove the file before saving or sending.',
		},
	);
});

test("inline attachment usage matches Content-ID body references safely", () => {
	assert.equal(
		bodyReferencesInlineAttachment(
			'<p>Logo</p><img src="CID:Signature@Example.com">',
			"<signature@example.com>",
		),
		true,
	);
	assert.equal(
		bodyReferencesInlineAttachment(
			'<p>No embedded image remains</p>',
			"signature@example.com",
		),
		false,
	);
	assert.equal(bodyReferencesInlineAttachment("<p>Body</p>", undefined), false);
});
