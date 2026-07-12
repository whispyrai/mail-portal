import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) =>
	readFileSync(new URL(relative, import.meta.url), "utf8");

test("managed image node views render only registry previews while serialization remains CID", () => {
	const extension = read("./ManagedInlineImage.tsx");
	assert.match(extension, /ReactNodeViewRenderer/);
	assert.match(extension, /managedInlineImageContentId/);
	assert.match(extension, /previewRegistry\.get/);
	assert.match(extension, /<img[\s\S]*?src=\{previewUrl\}/);
	assert.doesNotMatch(extension, /src=\{node\.attrs\.src\}/);
	assert.match(extension, /src: `cid:\$\{contentId\}`/);
	assert.match(extension, /MANAGED_INLINE_IMAGE_ATTRIBUTE/);
	assert.match(extension, /getAttrs:[\s\S]*?managedInlineImageContentId[\s\S]*?false/);
	assert.match(extension, /managed: MANAGED_INLINE_IMAGE_VERSION/);
	assert.match(extension, /tag: "img\[src\]"/);
});

test("preview changes update a stable registry without setContent or caret movement", () => {
	const editor = read("./RichTextEditor.tsx");
	assert.match(editor, /InlineImagePreviewRegistry/);
	assert.match(editor, /previewRegistry\.replace\(inlineImagePreviews\)/);
	const previewEffect = editor.match(
		/useEffect\(\(\) => \{\s*previewRegistry\.replace\(inlineImagePreviews\);\s*\}, \[inlineImagePreviews, previewRegistry\]\);/,
	)?.[0];
	assert.ok(previewEffect);
	assert.doesNotMatch(previewEffect, /setContent|focus|setTextSelection/);
	assert.match(editor, /ManagedInlineImage\.configure\([\s\S]*?previewRegistry/);
});

test("paste, drop, and toolbar insert managed nodes synchronously at the active selection", () => {
	const editor = read("./RichTextEditor.tsx");
	assert.match(editor, /consumeComposeEditorFileTransfer/);
	assert.match(editor, /view\.state\.selection\.from/);
	assert.match(editor, /view\.posAtCoords/);
	assert.match(editor, /insertContentAt\(position/);
	const transfer = read("../lib/compose-file-transfer.ts");
	assert.match(transfer, /consumeComposeEditorFileTransfer[\s\S]*?stopPropagation/);
	assert.match(editor, /aria-label="Insert image"/);
	assert.match(editor, /accept="image\/\*"/);
});
