import assert from "node:assert/strict";
import test from "node:test";
import {
	authoredBodyReferencesInlineContentId,
	createManagedInlineImageHtml,
	generateClientInlineContentId,
	managedInlineImageContentId,
	removeManagedInlineImageNodes,
	validateInlineImageMappings,
} from "./compose-inline-images.ts";
import { INLINE_IMAGE_HTML_MAX_BYTES } from "../../shared/inline-image-mappings.ts";

test("client inline images use one canonical managed CID representation", () => {
	const contentId = generateClientInlineContentId(
		() => "123e4567-e89b-12d3-a456-426614174000",
	);

	assert.equal(contentId, "123e4567-e89b-12d3-a456-426614174000@mail-portal.local");
	assert.equal(
		createManagedInlineImageHtml({ contentId, alt: 'Team "chart" <Q3>' }),
		'<img src="cid:123e4567-e89b-12d3-a456-426614174000@mail-portal.local" alt="Team &quot;chart&quot; &lt;Q3&gt;" data-mail-inline-image="v1">',
	);
});

test("only canonical managed CID sources are eligible for editor preview or persistence", () => {
	assert.equal(
		managedInlineImageContentId("CID:chart@mail-portal.local", "V1"),
		"chart@mail-portal.local",
	);
	for (const source of [
		"https://tracker.example/pixel.png",
		"data:image/png;base64,AAAA",
		"blob:https://mail.example/id",
		"cid:<chart@mail-portal.local>",
	]) {
		assert.equal(managedInlineImageContentId(source, "v1"), null);
	}
	assert.equal(managedInlineImageContentId("cid:chart@mail-portal.local", null), null);

	const invalidBody = '<img src="https://tracker.example/pixel.png" data-mail-inline-image="v1">';
	const result = validateInlineImageMappings(invalidBody, []);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /canonical CID source/);
});

test("removing an inline attachment deletes matching authored nodes but preserves the forwarded tail", () => {
	const body = '<p>Before</p><img data-mail-inline-image="v1" alt="Chart" src="CID:chart@mail-portal.local"><p>After</p><div data-mail-forwarded-message="v1"><img src="cid:chart@mail-portal.local" data-mail-inline-image="v1"></div>';

	assert.equal(
		removeManagedInlineImageNodes(body, "CHART@MAIL-PORTAL.LOCAL"),
		'<p>Before</p><p>After</p><div data-mail-forwarded-message="v1"><img src="cid:chart@mail-portal.local" data-mail-inline-image="v1"></div>',
	);
	assert.equal(
		authoredBodyReferencesInlineContentId(
			'<div data-mail-forwarded-message="v1"><img src="cid:chart@mail-portal.local"></div>',
			"chart@mail-portal.local",
		),
		false,
	);
});

test("mapping is case-safe and ignores managed images in the forwarded tail", () => {
	const result = validateInlineImageMappings(
		'<p>Authored</p><img src="CID:CHART@MAIL-PORTAL.LOCAL" alt="Chart" data-mail-inline-image="v1"><div data-mail-forwarded-message="v1"><img src="cid:old@sender.example" data-mail-inline-image="v1"></div>',
		[
			{
				filename: "chart.png",
				mimetype: "image/png",
				status: "ready",
				disposition: "inline",
				contentId: "chart@mail-portal.local",
			},
		],
	);

	assert.deepEqual(result, {
		ok: true,
		referencedContentIds: ["chart@mail-portal.local"],
	});
});

test("forward exclusion requires a structural marker attribute", () => {
	const body = '<p title="data-mail-forwarded-message=&quot;v1&quot;">Authored</p><img src="cid:chart@mail-portal.local">';
	const result = validateInlineImageMappings(body, []);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /missing its attachment/);
});

test("mapping treats quoted angle brackets and attribute-looking text as data", () => {
	const missingBehindQuotedAngle = validateInlineImageMappings(
		'<img alt=">" src="cid:missing@mail-portal.local" data-mail-inline-image="v1">',
		[],
	);
	assert.equal(missingBehindQuotedAngle.ok, false);
	if (!missingBehindQuotedAngle.ok) {
		assert.match(missingBehindQuotedAngle.error, /missing its attachment/);
	}

	const fakeSource = validateInlineImageMappings(
		'<img title="fake src=\'cid:chart@mail-portal.local\'" src="https://tracker.example/pixel.png" data-mail-inline-image="v1">',
		[{
			filename: "chart.png",
			mimetype: "image/png",
			status: "ready",
			disposition: "inline",
			contentId: "chart@mail-portal.local",
		}],
	);
	assert.equal(fakeSource.ok, false);
	if (!fakeSource.ok) assert.match(fakeSource.error, /canonical CID source/);
});

test("removal uses the same quote-aware projection and never trusts fake attributes", () => {
	const quoted = '<p>Before</p><img alt=">" src="cid:chart@mail-portal.local" data-mail-inline-image="v1"><p>After</p>';
	assert.equal(
		removeManagedInlineImageNodes(quoted, "chart@mail-portal.local"),
		"<p>Before</p><p>After</p>",
	);
	const fake = '<img title="fake src=\'cid:chart@mail-portal.local\'" src="https://tracker.example/pixel.png" data-mail-inline-image="v1">';
	assert.equal(
		removeManagedInlineImageNodes(fake, "chart@mail-portal.local"),
		fake,
	);
});

test("mapping fails closed on duplicate relevant attributes and malformed HTML", () => {
	for (const body of [
		'<img src="cid:one@example.com" SRC="cid:two@example.com">',
		'<img src="cid:one@example.com" data-mail-inline-image="v1" data-mail-inline-image="v1">',
		'<img src="cid:one@example.com" data-mail-inline-image="v1>',
		'<div><img src="cid:one@example.com"></section>',
		'<!-- unclosed',
	]) {
		const result = validateInlineImageMappings(body, []);
		assert.equal(result.ok, false, body);
		if (!result.ok) assert.match(result.code, /duplicate|malformed/);
	}
});

test("comments and raw script or style text cannot manufacture inline nodes", () => {
	const body = [
		'<!-- <img src="cid:missing@example.com"> -->',
		'<script>const markup = `<img src="cid:missing@example.com">`; const nearClose = "</scriptx><img src=\'cid:missing@example.com\'>";</script>',
		'<style>.x::after { content: "<img src=cid:missing@example.com>"; }</style>',
		'<p>Safe authored body</p>',
	].join("");
	assert.deepEqual(validateInlineImageMappings(body, []), {
		ok: true,
		referencedContentIds: [],
	});
});

test("only a real root-level forward block excludes the tail", () => {
	const nested = validateInlineImageMappings(
		'<section><div data-mail-forwarded-message="v1"></div></section><img src="cid:missing@example.com">',
		[],
	);
	assert.equal(nested.ok, false);
	if (!nested.ok) assert.match(nested.error, /missing its attachment/);

	const root = validateInlineImageMappings(
		'<p>Authored</p><div data-mail-forwarded-message="v1"><img src="cid:missing@example.com"></div>',
		[],
	);
	assert.deepEqual(root, { ok: true, referencedContentIds: [] });
});

test("attribute entities normalize like HTML and validation has an exact byte bound", () => {
	const attachment = {
		filename: "chart.png",
		mimetype: "image/png",
		status: "ready",
		disposition: "inline",
		contentId: "chart@example.com",
	};
	assert.deepEqual(
		validateInlineImageMappings(
			'<IMG SRC="CID&#58;CHART@EXAMPLE.COM" DATA-MAIL-INLINE-IMAGE="v&#49;">',
			[attachment],
		),
		{ ok: true, referencedContentIds: ["chart@example.com"] },
	);

	const atBoundary = "a".repeat(INLINE_IMAGE_HTML_MAX_BYTES);
	assert.deepEqual(validateInlineImageMappings(atBoundary, []), {
		ok: true,
		referencedContentIds: [],
	});
	const oversized = validateInlineImageMappings(`${atBoundary}a`, []);
	assert.equal(oversized.ok, false);
	if (!oversized.ok) {
		assert.equal(oversized.code, "inline_html_too_large");
		assert.equal(oversized.error, "Message HTML is too large to validate safely.");
	}
});

test("legacy canonical CID images reopen through the same authoritative mapping and fail when unmatched", () => {
	const legacyBody = '<p>Saved draft</p><img src="cid:legacy@mail-portal.local" alt="Legacy">';
	const attachment = {
		filename: "legacy.png",
		mimetype: "image/png",
		status: "ready",
		disposition: "inline",
		contentId: "LEGACY@MAIL-PORTAL.LOCAL",
	};
	assert.deepEqual(validateInlineImageMappings(legacyBody, [attachment]), {
		ok: true,
		referencedContentIds: ["legacy@mail-portal.local"],
	});
	const unmatched = validateInlineImageMappings(legacyBody, []);
	assert.equal(unmatched.ok, false);
	if (!unmatched.ok) assert.match(unmatched.error, /missing its attachment/);
});

test("mapping fails closed for duplicate, missing, non-ready, non-inline, and non-image parts", () => {
	const node = createManagedInlineImageHtml({
		contentId: "chart@mail-portal.local",
		alt: "Chart",
	});
	const readyInlineImage = {
		filename: "chart.png",
		mimetype: "image/png",
		status: "ready",
		disposition: "inline",
		contentId: "chart@mail-portal.local",
	};
	const cases = [
		{ body: `${node}${node}`, attachments: [readyInlineImage], error: /more than once/ },
		{ body: node, attachments: [], error: /missing its attachment/ },
		{
			body: node,
			attachments: [{ ...readyInlineImage }, { ...readyInlineImage, filename: "copy.png" }],
			error: /same Content-ID/,
		},
		{
			body: node,
			attachments: [{ ...readyInlineImage, status: "uploading" }],
			error: /not ready/,
		},
		{
			body: node,
			attachments: [{ ...readyInlineImage, disposition: "attachment" }],
			error: /not an inline attachment/,
		},
		{
			body: node,
			attachments: [{ ...readyInlineImage, mimetype: "application/pdf" }],
			error: /not an image/,
		},
	];

	for (const example of cases) {
		const result = validateInlineImageMappings(example.body, example.attachments);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, example.error);
	}
});
