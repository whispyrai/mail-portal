import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	evaluateComposeAttachments,
	evaluateStoredDraftAttachments,
	recoverComposeAttachments,
} from "../lib/compose-attachment-policy.ts";
import { composeDraftFingerprint } from "../lib/compose-draft-lifecycle.ts";

const read = (relative: string) =>
	readFileSync(new URL(relative, import.meta.url), "utf8");

test("fresh save, reopened save, and send preserve one CID mapping without preview leakage", () => {
	const body = '<p>Chart</p><img src="cid:chart@mail-portal.local" data-mail-inline-image="v1">';
	const fresh = {
		localId: "local-1",
		filename: "chart.png",
		mimetype: "image/png",
		size: 8,
		status: "ready" as const,
		disposition: "inline" as const,
		contentId: "chart@mail-portal.local",
		uploadId: "upload-1",
		previewUrl: "must-never-persist",
	};
	assert.deepEqual(evaluateComposeAttachments([fresh], body), {
		ok: true,
		refs: [{
			kind: "upload",
			uploadId: "upload-1",
			disposition: "inline",
			contentId: "chart@mail-portal.local",
		}],
	});
	const stored = [{
		id: "stored-1",
		filename: "chart.png",
		mimetype: "image/png",
		size: 8,
		disposition: "inline",
		content_id: "chart@mail-portal.local",
	}];
	assert.deepEqual(evaluateStoredDraftAttachments("draft-1", stored, body), {
		ok: true,
		refs: [{
			kind: "existing",
			emailId: "draft-1",
			attachmentId: "stored-1",
			disposition: "inline",
		}],
	});
	assert.doesNotMatch(
		composeDraftFingerprint({
			to: "team@example.com",
			cc: "",
			bcc: "",
			subject: "Chart",
			body,
			attachments: [fresh],
		}),
		/must-never-persist/,
	);
});

test("interrupted inline upload recovery keeps its CID and body node retryable", () => {
	const body = '<p>Chart</p><img src="cid:retry@mail-portal.local" data-mail-inline-image="v1">';
	const file = new File(["retry"], "retry.png", { type: "image/png" });
	const recovered = recoverComposeAttachments([{
		localId: "local-retry",
		filename: file.name,
		mimetype: file.type,
		size: file.size,
		status: "uploading",
		disposition: "inline",
		contentId: "retry@mail-portal.local",
		file,
	}]);

	assert.equal(recovered[0]?.status, "error");
	assert.equal(recovered[0]?.contentId, "retry@mail-portal.local");
	assert.equal(recovered[0]?.file, file);
	assert.match(body, /cid:retry@mail-portal\.local/);
	const blockedUntilRetry = evaluateComposeAttachments(recovered, body);
	assert.equal(blockedUntilRetry.ok, false);
	if (!blockedUntilRetry.ok) assert.match(blockedUntilRetry.error, /Retry the upload/);
});

test("composer wires trusted previews, body-aware policy, and atomic chip/body removal", () => {
	const compose = read("./ComposeEmail.tsx");
	const form = read("../hooks/useComposeForm.ts");
	assert.match(compose, /onInlineImages=\{addInlineImages\}/);
	assert.match(compose, /inlineImagePreviews=\{inlineImagePreviews\}/);
	assert.match(form, /evaluateComposeAttachments\(attachments, body\)/);
	assert.match(form, /evaluateComposeAttachments\([\s\S]*?savedAttachmentSnapshot,[\s\S]*?savedSnapshot\.body/);
	assert.match(form, /evaluateStoredDraftAttachments\([\s\S]*?saved\.body \?\? savedSnapshot\.body/);
	assert.match(
		form,
		/const removeAttachment = useCallback[\s\S]*?removeManagedInlineImageNodes[\s\S]*?handleBodyChange\(nextBody\)[\s\S]*?removeAttachmentRecord\(localId\)/,
	);
});
