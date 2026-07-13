import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	SemanticAttachmentExtractionError,
	type SemanticAttachmentExtractionFailure,
	type SemanticRichDocumentFormat,
} from "./semantic-attachment.ts";
import { preflightSemanticRichDocument } from "./semantic-rich-document.ts";

const encoder = new TextEncoder();

function pdf(objectBody = "<< /Type /Catalog >>"): ArrayBuffer {
	const header = "%PDF-1.7\n";
	const object = `1 0 obj\n${objectBody}\nendobj\n`;
	const xrefOffset = header.length + object.length;
	const xref = [
		"xref",
		"0 2",
		"0000000000 65535 f ",
		`${header.length.toString().padStart(10, "0")} 00000 n `,
		"trailer",
		"<< /Size 2 /Root 1 0 R >>",
		"startxref",
		xrefOffset.toString(),
		"%%EOF",
		"",
	].join("\n");
	const encoded = encoder.encode(header + object + xref);
	const output = new Uint8Array(encoded.byteLength);
	output.set(encoded);
	return output.buffer;
}

function numbersIwa(
	payload = new Uint8Array([0x0a, 0x02, 0x08, 0x01]),
): Uint8Array {
	const archiveInfo = new Uint8Array([
		0x12,
		0x04,
		0x08,
		0x01,
		0x18,
		payload.byteLength,
	]);
	const archive = new Uint8Array(
		1 + archiveInfo.byteLength + payload.byteLength,
	);
	archive[0] = archiveInfo.byteLength;
	archive.set(archiveInfo, 1);
	archive.set(payload, 1 + archiveInfo.byteLength);
	const snappy = new Uint8Array(2 + archive.byteLength);
	snappy[0] = archive.byteLength;
	snappy[1] = (archive.byteLength - 1) << 2;
	snappy.set(archive, 2);
	const block = new Uint8Array(4 + snappy.byteLength);
	block[0] = 0;
	block[1] = snappy.byteLength;
	block.set(snappy, 4);
	return block;
}

function protobufBytesField(payload: Uint8Array): Uint8Array {
	const output = new Uint8Array(2 + payload.byteLength);
	output[0] = 0x12;
	output[1] = payload.byteLength;
	output.set(payload, 2);
	return output;
}

function odfManifest(mimeType: string, extra = ""): string {
	return `<manifest:manifest><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimeType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${extra}</manifest:manifest>`;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zip(
	entries: Array<{
		name: string;
		data: string | Uint8Array;
		flags?: number;
		method?: number;
		compressedData?: Uint8Array;
		extra?: Uint8Array;
		declaredCompressedSize?: number;
		declaredUncompressedSize?: number;
	}>,
): ArrayBuffer {
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let localOffset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const data =
			typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
		const storedData = entry.compressedData ?? data;
		const extra = entry.extra ?? new Uint8Array();
		const compressedSize =
			entry.declaredCompressedSize ?? storedData.byteLength;
		const uncompressedSize = entry.declaredUncompressedSize ?? data.byteLength;
		const local = new Uint8Array(
			30 + name.byteLength + extra.byteLength + storedData.byteLength,
		);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, entry.flags ?? 0, true);
		localView.setUint16(8, entry.method ?? 0, true);
		localView.setUint32(14, crc32(data), true);
		localView.setUint32(18, compressedSize, true);
		localView.setUint32(22, uncompressedSize, true);
		localView.setUint16(26, name.byteLength, true);
		localView.setUint16(28, extra.byteLength, true);
		local.set(name, 30);
		local.set(extra, 30 + name.byteLength);
		local.set(storedData, 30 + name.byteLength + extra.byteLength);
		locals.push(local);

		const central = new Uint8Array(46 + name.byteLength + extra.byteLength);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, entry.flags ?? 0, true);
		centralView.setUint16(10, entry.method ?? 0, true);
		centralView.setUint32(16, crc32(data), true);
		centralView.setUint32(20, compressedSize, true);
		centralView.setUint32(24, uncompressedSize, true);
		centralView.setUint16(28, name.byteLength, true);
		centralView.setUint16(30, extra.byteLength, true);
		centralView.setUint32(42, localOffset, true);
		central.set(name, 46);
		central.set(extra, 46 + name.byteLength);
		centrals.push(central);
		localOffset += local.byteLength;
	}
	const centralSize = centrals.reduce(
		(total, value) => total + value.byteLength,
		0,
	);
	const output = new Uint8Array(localOffset + centralSize + 22);
	let offset = 0;
	for (const local of locals) {
		output.set(local, offset);
		offset += local.byteLength;
	}
	const centralOffset = offset;
	for (const central of centrals) {
		output.set(central, offset);
		offset += central.byteLength;
	}
	const end = new DataView(output.buffer, offset, 22);
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, centralOffset, true);
	return output.buffer;
}

function zipWithCentralGap(bytes: ArrayBuffer): ArrayBuffer {
	const source = new Uint8Array(bytes);
	const endOffset = source.byteLength - 22;
	const centralOffset = new DataView(
		source.buffer,
		source.byteOffset + endOffset,
		22,
	).getUint32(16, true);
	const gap = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
	const output = new Uint8Array(source.byteLength + gap.byteLength);
	output.set(source.subarray(0, centralOffset));
	output.set(gap, centralOffset);
	output.set(source.subarray(centralOffset), centralOffset + gap.byteLength);
	new DataView(output.buffer, endOffset + gap.byteLength, 22).setUint32(
		16,
		centralOffset + gap.byteLength,
		true,
	);
	return output.buffer;
}

function directoryEntry(
	name: string,
	type: number,
	startSector: number,
	size: number,
	child = 0xffffffff,
): Uint8Array {
	const entry = new Uint8Array(128);
	const view = new DataView(entry.buffer);
	const encodedName = new Uint8Array((name.length + 1) * 2);
	for (let index = 0; index < name.length; index += 1) {
		new DataView(encodedName.buffer).setUint16(
			index * 2,
			name.charCodeAt(index),
			true,
		);
	}
	entry.set(encodedName.slice(0, 64), 0);
	view.setUint16(64, Math.min(encodedName.byteLength, 64), true);
	view.setUint8(66, type);
	view.setUint8(67, 1);
	view.setUint32(68, 0xffffffff, true);
	view.setUint32(72, 0xffffffff, true);
	view.setUint32(76, child, true);
	view.setUint32(116, startSector, true);
	view.setUint32(120, size, true);
	view.setUint32(124, 0, true);
	return entry;
}

function xls(
	options: {
		macroRecord?: boolean;
		encrypted?: boolean;
		macroStorage?: boolean;
		worksheet?: boolean;
		macroSheet?: boolean;
		drawing?: boolean;
		duplicateWorkbook?: boolean;
		zeroRecordBeforeEof?: boolean;
		rootAtIndexOne?: boolean;
		reservedDirectoryType?: boolean;
	} = {},
): ArrayBuffer {
	const output = new Uint8Array(512 + 10 * 512);
	const header = new DataView(output.buffer, 0, 512);
	output.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
	header.setUint16(24, 0x003e, true);
	header.setUint16(26, 3, true);
	header.setUint16(28, 0xfffe, true);
	header.setUint16(30, 9, true);
	header.setUint16(32, 6, true);
	header.setUint32(44, 1, true);
	header.setUint32(48, 0, true);
	header.setUint32(56, 4096, true);
	header.setUint32(60, 0xfffffffe, true);
	header.setUint32(68, 0xfffffffe, true);
	header.setUint32(76, 9, true);
	for (let index = 1; index < 109; index += 1)
		header.setUint32(76 + index * 4, 0xffffffff, true);

	const directory = output.subarray(512, 1024);
	if (options.rootAtIndexOne) {
		directory.set(directoryEntry("Workbook", 2, 1, 4096), 0);
		directory.set(directoryEntry("Root Entry", 5, 0xfffffffe, 0, 0), 128);
	} else {
		directory.set(directoryEntry("Root Entry", 5, 0xfffffffe, 0, 1), 0);
		directory.set(directoryEntry("Workbook", 2, 1, 4096), 128);
	}
	if (options.reservedDirectoryType) {
		directory.set(directoryEntry("Reserved", 3, 0xfffffffe, 0), 256);
		new DataView(directory.buffer, directory.byteOffset + 128, 128).setUint32(
			72,
			2,
			true,
		);
	}
	if (options.macroStorage)
		directory.set(directoryEntry("_VBA_PROJECT_CUR", 1, 0xfffffffe, 0), 256);
	if (options.duplicateWorkbook)
		directory.set(directoryEntry("Book", 2, 1, 4096), 256);

	const workbook = new DataView(output.buffer, 512 + 512, 4096);
	let recordOffset = 0;
	workbook.setUint16(recordOffset, 0x0809, true);
	workbook.setUint16(recordOffset + 2, 4, true);
	workbook.setUint16(recordOffset + 4, 0x0600, true);
	workbook.setUint16(recordOffset + 6, 0x0005, true);
	recordOffset += 8;
	if (options.macroRecord || options.encrypted) {
		workbook.setUint16(recordOffset, options.encrypted ? 0x002f : 0x00d3, true);
		workbook.setUint16(recordOffset + 2, 0, true);
		recordOffset += 4;
	}
	if (options.zeroRecordBeforeEof) {
		workbook.setUint16(recordOffset, 0x0000, true);
		workbook.setUint16(recordOffset + 2, 0, true);
		recordOffset += 4;
	}
	workbook.setUint16(recordOffset, 0x000a, true);
	workbook.setUint16(recordOffset + 2, 0, true);
	recordOffset += 4;
	if (options.worksheet || options.macroSheet || options.drawing) {
		workbook.setUint16(recordOffset, 0x0809, true);
		workbook.setUint16(recordOffset + 2, 4, true);
		workbook.setUint16(recordOffset + 4, 0x0600, true);
		workbook.setUint16(
			recordOffset + 6,
			options.macroSheet ? 0x0040 : 0x0010,
			true,
		);
		recordOffset += 8;
		if (options.drawing) {
			workbook.setUint16(recordOffset, 0x00ec, true);
			workbook.setUint16(recordOffset + 2, 0, true);
			recordOffset += 4;
		}
		workbook.setUint16(recordOffset, 0x000a, true);
		workbook.setUint16(recordOffset + 2, 0, true);
	}

	const fat = new DataView(output.buffer, 512 + 9 * 512, 512);
	for (let index = 0; index < 128; index += 1)
		fat.setUint32(index * 4, 0xffffffff, true);
	fat.setUint32(0, 0xfffffffe, true);
	for (let sector = 1; sector < 8; sector += 1)
		fat.setUint32(sector * 4, sector + 1, true);
	fat.setUint32(8 * 4, 0xfffffffe, true);
	fat.setUint32(9 * 4, 0xfffffffd, true);
	return output.buffer;
}

type ZipDocumentFormat = Exclude<SemanticRichDocumentFormat, "pdf" | "xls">;

const packages: Record<ZipDocumentFormat, () => ArrayBuffer> = {
	docx: () =>
		zip([
			{
				name: "[Content_Types].xml",
				data: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			},
			{
				name: "_rels/.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			},
			{ name: "word/document.xml", data: "<w:document/>" },
		]),
	xlsx: () =>
		zip([
			{
				name: "[Content_Types].xml",
				data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
			},
			{
				name: "_rels/.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
			},
			{ name: "xl/workbook.xml", data: "<workbook/>" },
		]),
	odt: () =>
		zip([
			{
				name: "mimetype",
				data: "application/vnd.oasis.opendocument.text",
			},
			{
				name: "META-INF/manifest.xml",
				data: odfManifest("application/vnd.oasis.opendocument.text"),
			},
			{ name: "content.xml", data: "<office:document-content/>" },
		]),
	ods: () =>
		zip([
			{
				name: "mimetype",
				data: "application/vnd.oasis.opendocument.spreadsheet",
			},
			{
				name: "META-INF/manifest.xml",
				data: odfManifest("application/vnd.oasis.opendocument.spreadsheet"),
			},
			{ name: "content.xml", data: "<office:document-content/>" },
		]),
	numbers: () =>
		zip([
			{ name: "Index/Document.iwa", data: numbersIwa() },
			{ name: "Metadata/BuildVersionHistory.plist", data: "plist" },
		]),
};

test("rich preflight accepts structurally bounded examples from every locked family", async () => {
	await assert.doesNotReject(
		preflightSemanticRichDocument({ format: "pdf", bytes: pdf() }),
	);
	await assert.doesNotReject(
		preflightSemanticRichDocument({ format: "xls", bytes: xls() }),
	);
	await assert.doesNotReject(
		preflightSemanticRichDocument({
			format: "xls",
			bytes: xls({ worksheet: true }),
		}),
	);
	const zipFormats: ZipDocumentFormat[] = [
		"docx",
		"xlsx",
		"odt",
		"ods",
		"numbers",
	];
	for (const format of zipFormats) {
		await assert.doesNotReject(
			preflightSemanticRichDocument({
				format,
				bytes: packages[format](),
			}),
		);
	}
});

test("rich preflight rejects family confusion, truncation, encryption, and active content", async () => {
	const cases: Array<{
		format: SemanticRichDocumentFormat;
		bytes: ArrayBuffer;
		code: SemanticAttachmentExtractionFailure;
	}> = [
		{ format: "docx", bytes: packages.xlsx(), code: "invalid_container" },
		{ format: "xlsx", bytes: packages.docx(), code: "invalid_container" },
		{
			format: "numbers",
			bytes: packages.docx(),
			code: "invalid_container",
		},
		{
			format: "numbers",
			bytes: zip([
				{
					name: "Index/Document.iwa",
					data: numbersIwa(
						new Uint8Array([
							0x0a,
							0x02,
							0x08,
							0x01,
							...Array.from({ length: 18 }).reduce<Uint8Array>(
								(payload) => protobufBytesField(payload),
								new Uint8Array([
									0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
								]),
							),
						]),
					),
				},
			]),
			code: "invalid_container",
		},
		{
			format: "numbers",
			bytes: zip([
				{
					name: "Index/Document.iwa",
					data: new Uint8Array([1, 2, 3, 4]),
				},
			]),
			code: "invalid_container",
		},
		{
			format: "numbers",
			bytes: zip([
				{
					name: "Index/Document.iwa",
					data: numbersIwa(new Uint8Array([0x00])),
				},
			]),
			code: "invalid_container",
		},
		{
			format: "docx",
			bytes: packages.docx().slice(0, -10),
			code: "invalid_container",
		},
		{
			format: "docx",
			bytes: zip([
				{ name: "[Content_Types].xml", data: "<Types/>" },
				{ name: "_rels/.rels", data: "<Relationships/>" },
				{ name: "word/document.xml", data: "<w:document/>", flags: 1 },
			]),
			code: "encrypted_document",
		},
		{
			format: "docx",
			bytes: zip([
				{ name: "[Content_Types].xml", data: "<Types/>" },
				{ name: "_rels/.rels", data: "<Relationships/>" },
				{ name: "word/document.xml", data: "<w:document/>" },
				{ name: "word/vbaProject.bin", data: "macro" },
			]),
			code: "active_content",
		},
		{
			format: "odt",
			bytes: zip([
				{
					name: "mimetype",
					data: "application/vnd.oasis.opendocument.text",
				},
				{
					name: "META-INF/manifest.xml",
					data: odfManifest(
						"application/vnd.oasis.opendocument.text",
						"<manifest:encryption-data/>",
					),
				},
				{ name: "content.xml", data: "<office:document-content/>" },
			]),
			code: "encrypted_document",
		},
		{
			format: "pdf",
			bytes: pdf("<< /Type /Catalog /Encrypt 2 0 R >>"),
			code: "encrypted_document",
		},
		{
			format: "pdf",
			bytes: pdf("<< /Type /Catalog /JavaScript 2 0 R >>"),
			code: "active_content",
		},
		{
			format: "pdf",
			bytes: pdf("<< /Type /Catalog /Java#53cript 2 0 R >>"),
			code: "active_content",
		},
		{
			format: "pdf",
			bytes: encoder.encode(
				"%PDF-1.7\n1 0 obj<<>>endobj\nstartxref\n9\n%%EOF\n",
			).buffer,
			code: "invalid_container",
		},
		{
			format: "xls",
			bytes: xls({ encrypted: true }),
			code: "encrypted_document",
		},
		{
			format: "xls",
			bytes: xls({ macroRecord: true }),
			code: "active_content",
		},
		{
			format: "xls",
			bytes: xls({ macroStorage: true }),
			code: "active_content",
		},
		{
			format: "xls",
			bytes: xls({ macroSheet: true }),
			code: "active_content",
		},
		{
			format: "xls",
			bytes: xls({ drawing: true }),
			code: "active_content",
		},
	];
	for (const candidate of cases) {
		await assert.rejects(
			preflightSemanticRichDocument(candidate),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === candidate.code,
		);
	}
});

test("PDF preflight pins the conservative classic-xref compatibility boundary", async () => {
	const header = "%PDF-1.7\n";
	const catalog = "1 0 obj\n<< /Type /Catalog >>\nendobj\n";
	const xrefOffset = header.length + catalog.length;
	const xrefStream = encoder.encode(
		`${header}${catalog}2 0 obj\n<< /Type /XRef /Size 3 /Root 1 0 R /W [1 4 2] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`,
	).buffer;
	const incremental = encoder.encode(
		new TextDecoder()
			.decode(pdf())
			.replace(
				"<< /Size 2 /Root 1 0 R >>",
				"<< /Size 2 /Root 1 0 R /Prev 9 >>",
			),
	).buffer;
	for (const bytes of [xrefStream, incremental]) {
		await assert.rejects(
			preflightSemanticRichDocument({ format: "pdf", bytes }),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === "invalid_container",
		);
	}
});

test("rich preflight rejects decompression-heavy and embedded executable packages", async () => {
	for (const bytes of [
		zip([
			{ name: "[Content_Types].xml", data: "<Types/>" },
			{ name: "_rels/.rels", data: "<Relationships/>" },
			{
				name: "word/document.xml",
				data: new Uint8Array(100),
				method: 8,
				declaredCompressedSize: 100,
				declaredUncompressedSize: 10_001,
			},
		]),
		zip([
			{ name: "[Content_Types].xml", data: "<Types/>" },
			{ name: "_rels/.rels", data: "<Relationships/>" },
			{ name: "word/document.xml", data: "<w:document/>" },
			{ name: "payload.exe", data: "MZ" },
		]),
	]) {
		await assert.rejects(
			preflightSemanticRichDocument({ format: "docx", bytes }),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				(error.code === "decompression_exceeded" ||
					error.code === "active_content"),
		);
	}
});

test("rich preflight measures actual ZIP inflation before provider dispatch", async () => {
	const inflated = new Uint8Array(2 * 1024 * 1024);
	const compressedBuffer = deflateRawSync(inflated);
	const compressed = new Uint8Array(compressedBuffer.byteLength);
	compressed.set(compressedBuffer);
	const disguisedBomb = zip([
		{
			name: "[Content_Types].xml",
			data: '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		},
		{ name: "_rels/.rels", data: "<Relationships/>" },
		{
			name: "word/document.xml",
			data: inflated,
			compressedData: compressed,
			method: 8,
			declaredUncompressedSize: 1,
		},
	]);
	await assert.rejects(
		preflightSemanticRichDocument({ format: "docx", bytes: disguisedBomb }),
		(error) =>
			error instanceof SemanticAttachmentExtractionError &&
			error.code === "decompression_exceeded",
	);
});

test("OOXML preflight rejects comment decoys, encoded active relationships, and afChunk", async () => {
	const expectedType =
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
	const rootRelationship =
		'<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
	for (const bytes of [
		zip([
			{
				name: "[Content_Types].xml",
				data: `<Types><!-- ${expectedType} --><Override PartName="/word/document.xml" ContentType="application/octet-stream"/></Types>`,
			},
			{ name: "_rels/.rels", data: rootRelationship },
			{ name: "word/document.xml", data: "<w:document/>" },
		]),
		zip([
			{
				name: "[Content_Types].xml",
				data: `<Types><Override PartName="/word/document.xml" ContentType="${expectedType}"/></Types>`,
			},
			{ name: "_rels/.rels", data: rootRelationship },
			{ name: "word/document.xml", data: "<w:document/>" },
			{
				name: "word/_rels/document.xml.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTempl&#97;te" Target="https://example.test/template.dotm" TargetMode="External"/></Relationships>',
			},
		]),
		zip([
			{
				name: "[Content_Types].xml",
				data: `<Types><Override PartName="/word/document.xml" ContentType="${expectedType}"/></Types>`,
			},
			{ name: "_rels/.rels", data: rootRelationship },
			{ name: "word/document.xml", data: "<w:document/>" },
			{ name: "word/afchunk1.html", data: "<script>active</script>" },
			{
				name: "word/_rels/document.xml.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk1.html"/></Relationships>',
			},
		]),
		zip([
			{
				name: "[Content_Types].xml",
				data: `<Types><Override PartName="/word/document.xml" ContentType="${expectedType}"/></Types>`,
			},
			{ name: "_rels/.rels", data: rootRelationship },
			{ name: "word/document.xml", data: "<w:document/>" },
			{
				name: "word/_rels/document.xml.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.test/template.dotm" TargetMode=" External "/></Relationships>',
			},
		]),
		zip([
			{
				name: "[Content_Types].xml",
				data: `<Types><Override PartName="/word/document.xml" ContentType="${expectedType}"/></Types>`,
			},
			{ name: "_rels/.rels", data: rootRelationship },
			{ name: "word/document.xml", data: "<w:document/>" },
			{
				name: "word/_rels/document.xml.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/payload"/></Relationships>',
			},
		]),
	]) {
		await assert.rejects(
			preflightSemanticRichDocument({ format: "docx", bytes }),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				(error.code === "invalid_container" || error.code === "active_content"),
		);
	}
});

test("rich ZIP preflight rejects unindexed local records and data descriptors", async () => {
	for (const bytes of [
		zipWithCentralGap(packages.docx()),
		zip([
			{
				name: "[Content_Types].xml",
				data: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
				flags: 0x0008,
			},
			{
				name: "_rels/.rels",
				data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			},
			{ name: "word/document.xml", data: "<w:document/>" },
		]),
	]) {
		await assert.rejects(
			preflightSemanticRichDocument({ format: "docx", bytes }),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === "invalid_container",
		);
	}
});

test("rich spreadsheet preflight rejects image-bearing packages regardless of filename", async () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const xlsxRoot =
		'<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
	const avif = encoder.encode(
		"\u0000\u0000\u0000\u001cftypavif\u0000\u0000\u0000\u0000avifmif1",
	);
	const candidates: Array<{ format: ZipDocumentFormat; bytes: ArrayBuffer }> = [
		{
			format: "xlsx",
			bytes: zip([
				{
					name: "[Content_Types].xml",
					data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/media/asset" ContentType="image/png"/></Types>',
				},
				{ name: "_rels/.rels", data: xlsxRoot },
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{ name: "xl/media/asset", data: png },
			]),
		},
		{
			format: "xlsx",
			bytes: zip([
				{
					name: "[Content_Types].xml",
					data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
				},
				{ name: "_rels/.rels", data: xlsxRoot },
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{
					name: "xl/_rels/workbook.xml.rels",
					data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/asset"/></Relationships>',
				},
				{
					name: "xl/media/asset",
					data: '<svg xmlns="http://www.w3.org/2000/svg"/>',
				},
			]),
		},
		{
			format: "xlsx",
			bytes: zip([
				{
					name: "[Content_Types].xml",
					data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/media/asset.bin" ContentType="application/octet-stream"/></Types>',
				},
				{ name: "_rels/.rels", data: xlsxRoot },
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{ name: "xl/media/asset.bin", data: avif },
			]),
		},
		{
			format: "xlsx",
			bytes: zip([
				{
					name: "[Content_Types].xml",
					data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/opaque.bin" ContentType="application/octet-stream"/></Types>',
				},
				{ name: "_rels/.rels", data: xlsxRoot },
				{ name: "xl/workbook.xml", data: "<workbook/>" },
				{ name: "xl/opaque.bin", data: "undeclared graph payload" },
			]),
		},
		{
			format: "odt",
			bytes: zip([
				{
					name: "mimetype",
					data: "application/vnd.oasis.opendocument.text",
				},
				{
					name: "META-INF/manifest.xml",
					data: odfManifest(
						"application/vnd.oasis.opendocument.text",
						'<manifest:file-entry manifest:full-path="Pictures/asset" manifest:media-type="image/png"/>',
					),
				},
				{ name: "content.xml", data: "<office:document-content/>" },
				{ name: "Pictures/asset", data: png },
			]),
		},
		{
			format: "numbers",
			bytes: zip([
				{ name: "Index/Document.iwa", data: numbersIwa() },
				{ name: "Index/asset", data: png },
			]),
		},
		{
			format: "numbers",
			bytes: zip([
				{
					name: "Index/Document.iwa",
					data: numbersIwa(
						new Uint8Array([
							0x0a,
							0x02,
							0x08,
							0x01,
							0x12,
							png.byteLength,
							...png,
						]),
					),
				},
			]),
		},
	];
	for (const candidate of candidates) {
		await assert.rejects(
			preflightSemanticRichDocument(candidate),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === "active_content",
			candidate.format,
		);
	}
});

test("ODF preflight rejects embedded scripts, event handlers, and external resources", async () => {
	for (const content of [
		"<office:document-content><office:scripts><script:script/></office:scripts></office:document-content>",
		'<office:document-content><script:event-listener script:event-name="dom:load"/></office:document-content>',
		'<office:document-content><draw:object xlink:href="https://example.test/payload"/></office:document-content>',
		'<office:document-content><text:a xlink:href="../payload"/></office:document-content>',
		'<office:document-content><draw:image xlink:href="missing.png"/></office:document-content>',
		'<office:document-content><text:a xlink:href="missing.xml"/></office:document-content>',
	]) {
		await assert.rejects(
			preflightSemanticRichDocument({
				format: "odt",
				bytes: zip([
					{
						name: "mimetype",
						data: "application/vnd.oasis.opendocument.text",
					},
					{
						name: "META-INF/manifest.xml",
						data: odfManifest("application/vnd.oasis.opendocument.text"),
					},
					{ name: "content.xml", data: content },
				]),
			}),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === "active_content",
		);
	}
});

test("XLS preflight rejects ambiguous workbook streams and zero records", async () => {
	for (const bytes of [
		xls({ duplicateWorkbook: true }),
		xls({ zeroRecordBeforeEof: true }),
		xls({ rootAtIndexOne: true }),
		xls({ reservedDirectoryType: true }),
	]) {
		await assert.rejects(
			preflightSemanticRichDocument({ format: "xls", bytes }),
			(error) =>
				error instanceof SemanticAttachmentExtractionError &&
				error.code === "invalid_container",
		);
	}
});

test("ZIP preflight rejects path-affecting Unicode extras", async () => {
	const unicodePathExtra = new Uint8Array([
		0x75, 0x70, 0x05, 0x00, 0x01, 0, 0, 0, 0,
	]);
	const bytes = zip([
		{
			name: "[Content_Types].xml",
			data: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		},
		{
			name: "_rels/.rels",
			data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		},
		{
			name: "word/document.xml",
			data: "<w:document/>",
			extra: unicodePathExtra,
		},
	]);
	await assert.rejects(
		preflightSemanticRichDocument({ format: "docx", bytes }),
		(error) =>
			error instanceof SemanticAttachmentExtractionError &&
			error.code === "invalid_container",
	);
});
