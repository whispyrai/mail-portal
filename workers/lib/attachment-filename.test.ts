import assert from "node:assert/strict";
import test from "node:test";
import {
	attachmentStorageId,
	R2_OBJECT_KEY_MAX_BYTES,
	safeAttachmentStorageFilename,
} from "../../shared/attachment-filename.ts";

test("storage filenames never split a Unicode code point at the character boundary", () => {
	const filename = `${"a".repeat(254)}📄.pdf`;
	const prefix = "attachments/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000/";
	const normalized = safeAttachmentStorageFilename(filename, prefix);
	assert.ok([...normalized].length <= 255);
	assert.match(normalized, /\.pdf$/);
	for (const character of normalized) {
		assert.equal(
			character.length === 1 && /[\uD800-\uDFFF]/.test(character),
			false,
		);
	}
	assert.ok(new TextEncoder().encode(`${prefix}${normalized}`).byteLength <= R2_OBJECT_KEY_MAX_BYTES);
});

test("storage identity is stable per destination, source, and occurrence", async () => {
	const source = { kind: "upload" as const, uploadId: crypto.randomUUID() };
	const first = await attachmentStorageId("draft-1", source, 0);
	assert.equal(await attachmentStorageId("draft-1", source, 0), first);
	assert.notEqual(await attachmentStorageId("draft-1", source, 1), first);
	assert.notEqual(await attachmentStorageId("draft-2", source, 0), first);
	assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test("draft save scope gives concurrent revisions disjoint permanent identities", async () => {
	const source = { kind: "upload" as const, uploadId: crypto.randomUUID() };
	const first = await attachmentStorageId("draft-1", source, 0, "save-1");
	assert.equal(
		await attachmentStorageId("draft-1", source, 0, "save-1"),
		first,
	);
	assert.notEqual(
		await attachmentStorageId("draft-1", source, 0, "save-2"),
		first,
	);
});
