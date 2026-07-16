import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_INLINE_ATTACHMENT_METADATA,
	MAX_INLINE_IMAGE_BYTES,
	MAX_INLINE_IMAGE_COUNT,
	isExpectedInlineImageBlob,
	normalizeInlineContentId,
	planReferencedInlineImages,
} from "./email-inline-images.ts";

test("inline content IDs normalize only safe CID and Content-ID spellings", () => {
	assert.equal(normalizeInlineContentId(" CID:<Chart@Example.COM> "), "chart@example.com");
	assert.equal(normalizeInlineContentId("<chart@example.com>"), "chart@example.com");
	assert.equal(normalizeInlineContentId("chart@example.com"), "chart@example.com");
	for (const invalid of [
		null,
		42,
		{},
		"",
		"cid:",
		"<chart@example.com",
		"chart@example.com>",
		"chart @example.com",
		"chart\n@example.com",
		`cid:${"x".repeat(513)}`,
	]) {
		assert.equal(normalizeInlineContentId(invalid), null, String(invalid));
	}
});

test("hostile unknown attachment metadata is rejected without hiding later valid metadata", () => {
	const valid = {
		id: "chart-1",
		filename: "chart.png",
		mimetype: "image/png",
		size: 68,
		content_id: "chart@example.com",
		disposition: "inline",
	};
	const throwingField = { ...valid };
	Object.defineProperty(throwingField, "content_id", {
		get() {
			throw new Error("hostile metadata getter");
		},
	});
	const hostile: unknown[] = [
		null,
		42,
		"attachment",
		[],
		{},
		{ ...valid, id: null },
		{ ...valid, filename: {} },
		{ ...valid, mimetype: 3 },
		{ ...valid, content_id: [] },
		{ ...valid, disposition: {} },
		{ ...valid, size: null },
		{ ...valid, id: "x".repeat(10_000) },
		{ ...valid, filename: "x".repeat(10_000) },
		{ ...valid, mimetype: "x".repeat(10_000) },
		{ ...valid, content_id: "x".repeat(10_000) },
		{ ...valid, disposition: "x".repeat(10_000) },
		throwingField,
		valid,
	];
	assert.doesNotThrow(() => planReferencedInlineImages(
		["cid:chart@example.com"],
		hostile,
	));
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], hostile),
		[{
			cid: "chart@example.com",
			attachmentId: "chart-1",
			expectedMimeType: "image/png",
			expectedSize: 68,
		}],
	);
});

test("only referenced, exact, unambiguous inline raster attachments are planned once", () => {
	const plan = planReferencedInlineImages(
		["CID:<CHART@EXAMPLE.COM>", "cid:chart@example.com", "cid:missing@example.com"],
		[
			{
				id: "chart-1",
				filename: "chart.png",
				mimetype: "image/png",
				size: 68,
				content_id: "<chart@example.com>",
				disposition: "inline",
			},
			{
				id: "not-referenced",
				filename: "private.png",
				mimetype: "image/png",
				size: 32,
				content_id: "private@example.com",
				disposition: "inline",
			},
			{
				id: "wrong-disposition",
				filename: "missing.png",
				mimetype: "image/png",
				size: 32,
				content_id: "missing@example.com",
				disposition: "attachment",
			},
		],
	);

	assert.deepEqual(plan, [{
		cid: "chart@example.com",
		attachmentId: "chart-1",
		expectedMimeType: "image/png",
		expectedSize: 68,
	}]);
});

test("ambiguous CIDs, active content, malformed metadata, and payload overflow fail closed", () => {
	const shared = {
		filename: "chart.png",
		mimetype: "image/png",
		size: 10,
		content_id: "chart@example.com",
		disposition: "inline",
	};
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], [
			{ id: "chart-1", ...shared },
			{ id: "chart-2", ...shared },
		]),
		[],
	);
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], [{
			id: "chart-svg",
			...shared,
			filename: "chart.svg",
			mimetype: "image/svg+xml",
		}]),
		[],
	);
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], [{
			id: "chart-too-large",
			...shared,
			size: MAX_INLINE_IMAGE_BYTES + 1,
		}]),
		[],
	);

	const references = Array.from(
		{ length: MAX_INLINE_IMAGE_COUNT + 5 },
		(_, index) => `cid:image-${index}@example.com`,
	);
	const attachments = references.map((reference, index) => ({
		id: `image-${index}`,
		filename: `image-${index}.png`,
		mimetype: "image/png",
		size: 1,
		content_id: reference.slice(4),
		disposition: "inline",
	}));
	assert.equal(
		planReferencedInlineImages(references, attachments).length,
		MAX_INLINE_IMAGE_COUNT,
	);

	const oversizedMetadata = Array.from(
		{ length: MAX_INLINE_ATTACHMENT_METADATA },
		(_, index) => ({
			id: `unrelated-${index}`,
			filename: `unrelated-${index}.png`,
			mimetype: "image/png",
			size: 1,
			content_id: `unrelated-${index}@example.com`,
			disposition: "inline",
		}),
	);
	oversizedMetadata.push({
		id: "late-match",
		filename: "late-match.png",
		mimetype: "image/png",
		size: 1,
		content_id: "chart@example.com",
		disposition: "inline",
	});
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], oversizedMetadata),
		[],
	);

	const hiddenConflict = Array.from(
		{ length: MAX_INLINE_ATTACHMENT_METADATA - 1 },
		(_, index) => ({
			id: `unrelated-${index}`,
			filename: `unrelated-${index}.png`,
			mimetype: "image/png",
			size: 1,
			content_id: `unrelated-${index}@example.com`,
			disposition: "inline",
		}),
	);
	hiddenConflict.unshift({
		id: "early-match",
		filename: "chart.png",
		mimetype: "image/png",
		size: 10,
		content_id: "chart@example.com",
		disposition: "inline",
	});
	hiddenConflict.push({
		id: "hidden-conflict",
		filename: "chart.png",
		mimetype: "image/png",
		size: 10,
		content_id: "chart@example.com",
		disposition: "inline",
	});
	assert.deepEqual(
		planReferencedInlineImages(["cid:chart@example.com"], hiddenConflict),
		[],
	);
});

test("downloaded bytes must match authoritative size and raster MIME before crossing the iframe", () => {
	const planned = {
		cid: "chart@example.com",
		attachmentId: "chart-1",
		expectedMimeType: "image/png",
		expectedSize: 3,
	};
	assert.equal(
		isExpectedInlineImageBlob(planned, new Blob([new Uint8Array([1, 2, 3])], {
			type: "image/png",
		})),
		true,
	);
	assert.equal(
		isExpectedInlineImageBlob(planned, new Blob([new Uint8Array([1, 2])], {
			type: "image/png",
		})),
		false,
	);
	assert.equal(
		isExpectedInlineImageBlob(planned, new Blob([new Uint8Array([1, 2, 3])], {
			type: "image/svg+xml",
		})),
		false,
	);
});
