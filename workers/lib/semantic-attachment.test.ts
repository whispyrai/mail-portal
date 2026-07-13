import assert from "node:assert/strict";
import test from "node:test";
import {
	SEMANTIC_ATTACHMENT_LIMITS,
	SemanticAttachmentExtractionError,
	extractSemanticAttachmentText,
	semanticAttachmentChunks,
	semanticAttachmentFingerprint,
	semanticAttachmentVectorId,
	semanticDirectTextFormat,
} from "./semantic-attachment.ts";

function bytes(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

test("direct attachment admission requires an exact allowlisted extension and MIME pair", () => {
	assert.equal(semanticDirectTextFormat("notes.txt", "text/plain; charset=utf-8"), "text");
	assert.equal(semanticDirectTextFormat("notes.md", "text/markdown"), "markdown");
	assert.equal(semanticDirectTextFormat("data.json", "application/json"), "json");
	assert.equal(semanticDirectTextFormat("feed.xml", "text/xml"), "xml");
	assert.equal(semanticDirectTextFormat("rows.csv", "text/csv"), "csv");
	for (const [filename, mimetype] of [
		["page.html", "text/html"],
		["script.js", "text/plain"],
		["notes.txt", "text/html"],
		["notes", "text/plain"],
	]) assert.equal(semanticDirectTextFormat(filename, mimetype), null);
});

test("direct extraction is fatal UTF-8, byte-exact, control-safe, and bounded", () => {
	const input = bytes("First line\r\nSecond line  \r\n");
	assert.deepEqual(extractSemanticAttachmentText({
		filename: "notes.md",
		mimetype: "text/markdown",
		declaredSize: input.byteLength,
		bytes: input,
	}), { format: "markdown", text: "First line\nSecond line" });
	for (const [filename, mimetype, format] of [
		["notes.txt", "text/plain", "text"],
		["notes.md", "text/markdown", "markdown"],
		["data.json", "application/json", "json"],
		["feed.xml", "application/xml", "xml"],
		["rows.csv", "text/csv", "csv"],
	] as const) {
		const multilingual = bytes("موعد\u200Cالعقد 👩🏽‍💻\u2028अगला कदम");
		assert.deepEqual(extractSemanticAttachmentText({
			filename,
			mimetype,
			declaredSize: multilingual.byteLength,
			bytes: multilingual,
		}), { format, text: "موعد\u200Cالعقد 👩🏽‍💻\nअगला कदम" });
	}
	for (const candidate of [
		{ code: "size_mismatch", value: bytes("ok"), declaredSize: 3 },
		{ code: "unsafe_text", value: bytes("before\u0000after"), declaredSize: 12 },
		{ code: "empty_output", value: bytes("  \n"), declaredSize: 3 },
	]) {
		assert.throws(
			() => extractSemanticAttachmentText({
				filename: "notes.txt",
				mimetype: "text/plain",
				declaredSize: candidate.declaredSize,
				bytes: candidate.value,
			}),
			(error) => error instanceof SemanticAttachmentExtractionError && error.code === candidate.code,
		);
	}
	const invalidUtf8 = new Uint8Array([0xc3, 0x28]).buffer;
	assert.throws(
		() => extractSemanticAttachmentText({
			filename: "notes.txt",
			mimetype: "text/plain",
			declaredSize: 2,
			bytes: invalidUtf8,
		}),
		(error) => error instanceof SemanticAttachmentExtractionError && error.code === "invalid_utf8",
	);
	const oversized = new Uint8Array(SEMANTIC_ATTACHMENT_LIMITS.inputBytes + 1).buffer;
	assert.throws(
		() => extractSemanticAttachmentText({
			filename: "notes.txt",
			mimetype: "text/plain",
			declaredSize: oversized.byteLength,
			bytes: oversized,
		}),
		(error) => error instanceof SemanticAttachmentExtractionError && error.code === "size_exceeded",
	);
	for (const binaryLooking of [
		"\uE000".repeat(64),
		"⚙".repeat(64),
		`e${"\u0301".repeat(65)}`,
	]) {
		const value = bytes(binaryLooking);
		assert.throws(
			() => extractSemanticAttachmentText({
				filename: "notes.txt",
				mimetype: "text/plain",
				declaredSize: value.byteLength,
				bytes: value,
			}),
			(error) => error instanceof SemanticAttachmentExtractionError && error.code === "unsafe_text",
		);
	}
	const multilingualSymbols = bytes("العقد رقم ٤٢: Δx = 3 × 7; status ✅");
	assert.equal(extractSemanticAttachmentText({
		filename: "notes.txt",
		mimetype: "text/plain",
		declaredSize: multilingualSymbols.byteLength,
		bytes: multilingualSymbols,
	}).text, "العقد رقم ٤٢: Δx = 3 × 7; status ✅");
});

test("attachment chunks preserve plain excerpts and use opaque byte-versioned identities", async () => {
	const chunks = semanticAttachmentChunks("contract.md", "word ".repeat(5_000));
	assert.ok(chunks.length > 1 && chunks.length <= 40);
	assert.ok(chunks.every((chunk) => chunk.embeddingText.startsWith("Attachment: contract.md\n")));
	assert.ok(chunks.every((chunk) => !chunk.excerpt.startsWith("Attachment:")));
	const fullCoverage = semanticAttachmentChunks(
		"contract.md",
		`${"x".repeat(47_990)}TAIL_MARKER`,
	);
	assert.match(fullCoverage.at(-1)?.excerpt ?? "", /TAIL_MARKER$/);
	const spacedFullCoverage = semanticAttachmentChunks(
		"contract.md",
		`${"word ".repeat(9_597)}TAIL_MARKER`,
	);
	assert.match(spacedFullCoverage.at(-1)?.excerpt ?? "", /TAIL_MARKER$/);
	assert.ok(spacedFullCoverage.every(
		(chunk) => chunk.excerpt.length <= SEMANTIC_ATTACHMENT_LIMITS.chunkChars,
	));
	const unicodeBoundary = semanticAttachmentChunks(
		"multilingual.txt",
		`${"x".repeat(1_399)}👩🏽‍💻e\u0301${"y".repeat(2_000)}`,
	);
	assert.ok(unicodeBoundary.every((chunk) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.excerpt)));
	assert.ok(unicodeBoundary.some((chunk) => chunk.excerpt.includes("👩🏽‍💻e\u0301")));
	const token = "0123456789abcdef0123456789abcdef";
	assert.equal(semanticAttachmentVectorId(token, 1), `sa1_${token}_01`);
	assert.throws(() => semanticAttachmentVectorId("attachment-1", 0));
	const original = await semanticAttachmentFingerprint({ bytes: bytes("one"), format: "text" });
	const repeated = await semanticAttachmentFingerprint({ bytes: bytes("one"), format: "text" });
	const changed = await semanticAttachmentFingerprint({ bytes: bytes("two"), format: "text" });
	assert.deepEqual(original, repeated);
	assert.notEqual(original.sourceFingerprint, changed.sourceFingerprint);
	assert.match(original.byteSha256, /^[a-f0-9]{64}$/);
});

test("attachment chunks stay bounded and advance through pathological combining sequences", () => {
	for (const base of ["e", "😀"]) {
		const chunks = semanticAttachmentChunks(
			"unicode.txt",
			`${"x".repeat(1_320)}${base}${"\u0301".repeat(64)}${"ordinary text ".repeat(2_000)}TAIL_MARKER`,
		);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every(
			(chunk) => chunk.excerpt.length <= SEMANTIC_ATTACHMENT_LIMITS.chunkChars,
		));
		assert.equal(chunks.filter((chunk) => chunk.excerpt.includes("TAIL_MARKER")).length, 1);
		assert.ok(chunks.every((chunk) => (
			!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.excerpt)
		)));
		assert.ok(chunks.every((chunk) => (
			!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.embeddingText)
		)));
		assert.ok(chunks.every((chunk) => !/^\p{M}/u.test(chunk.excerpt)));
	}
	const filenameBoundary = semanticAttachmentChunks(
		`${"a".repeat(254)}😀.txt`,
		"Evidence",
	);
	assert.doesNotMatch(
		filenameBoundary[0]?.embeddingText ?? "",
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
	);
	const oversizedCluster = `e${"\u0301".repeat(1_499)}\u0302${"\u0301".repeat(500)} tail`;
	assert.throws(
		() => semanticAttachmentChunks("unicode.txt", oversizedCluster),
		(error) => error instanceof SemanticAttachmentExtractionError && error.code === "unsafe_text",
	);
});
