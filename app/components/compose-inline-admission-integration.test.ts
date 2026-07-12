import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(new URL("../hooks/useAttachments.ts", import.meta.url), "utf8");

test("inline admission assigns disposition and CID synchronously before guarded uploads", () => {
	assert.match(hook, /const addInlineImages = useCallback/);
	assert.match(hook, /isInlineImageMimeType\(file\.type\)/);
	assert.match(hook, /generateClientInlineContentId\(\)/);
	assert.match(hook, /disposition === "inline"/);
	assert.match(hook, /contentId/);
	assert.match(
		hook,
		/commitAttachments\(nextAttachments\)[\s\S]*?for \(const upload of toUpload\)[\s\S]*?uploadOne/,
	);
	assert.match(hook, /return insertions/);
	assert.match(hook, /attempts\.begin\(localId\)/);
	assert.match(hook, /attempts\.isCurrent\(localId, token\)/);
});

test("preview URL ownership is reconciled outside records and released on every destructive lifecycle", () => {
	assert.match(hook, /ComposeInlinePreviewUrls/);
	assert.match(hook, /setInlineImagePreviews\(previewUrls\.reconcile\(nextAttachments, mailboxId\)\)/);
	assert.match(hook, /removeAttachment[\s\S]*?\.release\(localId\)/);
	assert.match(hook, /hydrateFromDraft[\s\S]*?\.releaseAll\(\)/);
	assert.match(hook, /reset[\s\S]*?\.releaseAll\(\)/);
	assert.match(hook, /restore[\s\S]*?\.releaseAll\(\)/);
	assert.match(hook, /useEffect\(\(\) => \(\) => \{[\s\S]*?abortAll\(\)[\s\S]*?releaseAll\(\)/);
	assert.match(hook, /inlineImagePreviews,/);
});
