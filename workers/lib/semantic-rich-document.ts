import {
	SemanticAttachmentExtractionError,
	type SemanticRichDocumentFormat,
} from "./semantic-attachment.ts";

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_MAX_ENTRIES = 1_000;
const ZIP_MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_RATIO = 100;
const ZIP_MAX_SECURITY_ENTRY_BYTES = 1024 * 1024;

const CFB_FREE_SECTOR = 0xffffffff;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_FAT_SECTOR = 0xfffffffd;
const CFB_DIFAT_SECTOR = 0xfffffffc;
const CFB_MAX_CHAIN_SECTORS = 16_384;

type ZipEntry = {
	name: string;
	method: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	dataStart: number;
};

function failure(
	code: ConstructorParameters<typeof SemanticAttachmentExtractionError>[0],
): never {
	throw new SemanticAttachmentExtractionError(code);
}

function boundedView(
	bytes: Uint8Array,
	offset: number,
	length: number,
): DataView {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset + length > bytes.byteLength
	) {
		failure("invalid_container");
	}
	return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return failure("invalid_container");
	}
}

function safeZipName(value: string): string {
	if (
		!value ||
		value.length > 1_024 ||
		/[\\\u0000-\u001f\u007f]/u.test(value) ||
		value.startsWith("/") ||
		/^[a-z]:/iu.test(value)
	)
		failure("invalid_container");
	const pieces = value.split("/");
	if (pieces.some((piece) => piece === ".." || piece === ".")) {
		failure("invalid_container");
	}
	return value;
}

function validateZipExtra(extra: Uint8Array): void {
	const allowedMetadata = new Set([0x000a, 0x5455, 0x5855, 0x7875]);
	const seen = new Set<number>();
	let offset = 0;
	while (offset < extra.byteLength) {
		if (offset + 4 > extra.byteLength) failure("invalid_container");
		const view = boundedView(extra, offset, 4);
		const identifier = view.getUint16(0, true);
		const length = view.getUint16(2, true);
		if (
			offset + 4 + length > extra.byteLength ||
			seen.has(identifier) ||
			!allowedMetadata.has(identifier)
		)
			failure("invalid_container");
		seen.add(identifier);
		offset += 4 + length;
	}
}

function findZipEnd(bytes: Uint8Array): number {
	const minimum = Math.max(0, bytes.byteLength - 65_557);
	for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
		if (
			boundedView(bytes, offset, 4).getUint32(0, true) === ZIP_END_SIGNATURE
		) {
			const commentLength = boundedView(bytes, offset + 20, 2).getUint16(
				0,
				true,
			);
			if (offset + 22 + commentLength === bytes.byteLength) return offset;
		}
	}
	return failure("invalid_container");
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
	if (bytes.byteLength < 22) failure("invalid_container");
	const endOffset = findZipEnd(bytes);
	const end = boundedView(bytes, endOffset, 22);
	const disk = end.getUint16(4, true);
	const centralDisk = end.getUint16(6, true);
	const diskEntries = end.getUint16(8, true);
	const totalEntries = end.getUint16(10, true);
	const centralSize = end.getUint32(12, true);
	const centralOffset = end.getUint32(16, true);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		diskEntries !== totalEntries ||
		totalEntries === 0 ||
		totalEntries > ZIP_MAX_ENTRIES ||
		totalEntries === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff ||
		centralOffset + centralSize !== endOffset
	)
		failure("invalid_container");

	const entries: ZipEntry[] = [];
	const names = new Set<string>();
	const ranges: Array<{ start: number; end: number }> = [];
	let totalCompressed = 0;
	let totalUncompressed = 0;
	let offset = centralOffset;
	for (let index = 0; index < totalEntries; index += 1) {
		const central = boundedView(bytes, offset, 46);
		if (central.getUint32(0, true) !== ZIP_CENTRAL_SIGNATURE)
			failure("invalid_container");
		const flags = central.getUint16(8, true);
		const method = central.getUint16(10, true);
		const crc = central.getUint32(16, true);
		const compressedSize = central.getUint32(20, true);
		const uncompressedSize = central.getUint32(24, true);
		const nameLength = central.getUint16(28, true);
		const extraLength = central.getUint16(30, true);
		const commentLength = central.getUint16(32, true);
		const localOffset = central.getUint32(42, true);
		if (offset + 46 + nameLength + extraLength + commentLength > endOffset) {
			failure("invalid_container");
		}
		const name = safeZipName(
			decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength)),
		);
		validateZipExtra(
			bytes.subarray(
				offset + 46 + nameLength,
				offset + 46 + nameLength + extraLength,
			),
		);
		const normalizedName = name.toLowerCase();
		if (names.has(normalizedName)) failure("invalid_container");
		names.add(normalizedName);
		if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0)
			failure("encrypted_document");
		if ((flags & 0x0008) !== 0) failure("invalid_container");
		if (method !== 0 && method !== 8) failure("invalid_container");
		if (method === 0 && compressedSize !== uncompressedSize)
			failure("invalid_container");
		if (
			(uncompressedSize > 0 && compressedSize === 0) ||
			(compressedSize > 0 && uncompressedSize / compressedSize > ZIP_MAX_RATIO)
		)
			failure("decompression_exceeded");
		totalCompressed += compressedSize;
		totalUncompressed += uncompressedSize;
		if (
			totalUncompressed > ZIP_MAX_UNCOMPRESSED_BYTES ||
			(totalCompressed > 0 &&
				totalUncompressed / totalCompressed > ZIP_MAX_RATIO)
		)
			failure("decompression_exceeded");

		const local = boundedView(bytes, localOffset, 30);
		if (local.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE)
			failure("invalid_container");
		const localFlags = local.getUint16(6, true);
		const localMethod = local.getUint16(8, true);
		const localNameLength = local.getUint16(26, true);
		const localExtraLength = local.getUint16(28, true);
		if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) {
			failure("invalid_container");
		}
		const localName = decodeUtf8(
			bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
		);
		if (localFlags !== flags || localMethod !== method || localName !== name)
			failure("invalid_container");
		validateZipExtra(
			bytes.subarray(
				localOffset + 30 + localNameLength,
				localOffset + 30 + localNameLength + localExtraLength,
			),
		);
		if (
			local.getUint32(14, true) !== crc ||
			local.getUint32(18, true) !== compressedSize ||
			local.getUint32(22, true) !== uncompressedSize
		)
			failure("invalid_container");
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		if (dataStart < localOffset || dataEnd > centralOffset)
			failure("invalid_container");
		ranges.push({ start: localOffset, end: dataEnd });
		entries.push({
			name,
			method,
			crc,
			compressedSize,
			uncompressedSize,
			dataStart,
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	if (offset !== endOffset) failure("invalid_container");
	ranges.sort((left, right) => left.start - right.start);
	if (ranges[0]?.start !== 0 || ranges.at(-1)?.end !== centralOffset) {
		failure("invalid_container");
	}
	for (let index = 1; index < ranges.length; index += 1) {
		if (ranges[index]!.start !== ranges[index - 1]!.end)
			failure("invalid_container");
	}
	return entries;
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

async function inflateEntry(
	bytes: Uint8Array,
	entry: ZipEntry,
	maximumBytes: number,
): Promise<Uint8Array> {
	if (entry.uncompressedSize > maximumBytes) failure("decompression_exceeded");
	const compressed = bytes.subarray(
		entry.dataStart,
		entry.dataStart + entry.compressedSize,
	);
	if (entry.method === 0) {
		if (crc32(compressed) !== entry.crc) failure("invalid_container");
		return compressed;
	}
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		const compressedCopy = new Uint8Array(compressed.byteLength);
		compressedCopy.set(compressed);
		reader = new Blob([compressedCopy.buffer])
			.stream()
			.pipeThrough(new DecompressionStream("deflate-raw"))
			.getReader();
	} catch {
		return failure("invalid_container");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > entry.uncompressedSize || total > maximumBytes) {
				await reader.cancel();
				failure("decompression_exceeded");
			}
			chunks.push(result.value);
		}
	} catch (error) {
		if (error instanceof SemanticAttachmentExtractionError) throw error;
		return failure("invalid_container");
	}
	if (total !== entry.uncompressedSize) failure("invalid_container");
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (crc32(output) !== entry.crc) failure("invalid_container");
	return output;
}

async function zipEntryText(
	bytes: Uint8Array,
	entry: ZipEntry,
): Promise<string> {
	return decodeUtf8(
		await inflateEntry(bytes, entry, ZIP_MAX_SECURITY_ENTRY_BYTES),
	);
}

async function validateZipPayloads(
	bytes: Uint8Array,
	entries: readonly ZipEntry[],
): Promise<void> {
	let totalActual = 0;
	let totalCompressed = 0;
	for (const entry of entries) {
		const output = await inflateEntry(bytes, entry, ZIP_MAX_UNCOMPRESSED_BYTES);
		totalActual += output.byteLength;
		totalCompressed += entry.compressedSize;
		if (
			totalActual > ZIP_MAX_UNCOMPRESSED_BYTES ||
			(totalCompressed > 0 && totalActual / totalCompressed > ZIP_MAX_RATIO)
		)
			failure("decompression_exceeded");
	}
}

function imageSignatureAt(bytes: Uint8Array, offset: number): boolean {
	if (
		offset + 8 <= bytes.byteLength &&
		bytes[offset] === 0x89 &&
		bytes[offset + 1] === 0x50 &&
		bytes[offset + 2] === 0x4e &&
		bytes[offset + 3] === 0x47 &&
		bytes[offset + 4] === 0x0d &&
		bytes[offset + 5] === 0x0a &&
		bytes[offset + 6] === 0x1a &&
		bytes[offset + 7] === 0x0a
	)
		return true;
	if (
		offset + 3 <= bytes.byteLength &&
		bytes[offset] === 0xff &&
		bytes[offset + 1] === 0xd8 &&
		bytes[offset + 2] === 0xff
	)
		return true;
	if (offset + 6 <= bytes.byteLength) {
		const six = new TextDecoder("latin1").decode(
			bytes.subarray(offset, offset + 6),
		);
		if (six === "GIF87a" || six === "GIF89a") return true;
	}
	if (
		offset + 14 <= bytes.byteLength &&
		bytes[offset] === 0x42 &&
		bytes[offset + 1] === 0x4d
	) {
		const view = boundedView(bytes, offset + 2, 12);
		const fileSize = view.getUint32(0, true);
		const pixelOffset = view.getUint32(8, true);
		if (
			fileSize >= 14 &&
			fileSize <= bytes.byteLength - offset &&
			pixelOffset >= 14 &&
			pixelOffset < fileSize
		)
			return true;
	}
	if (
		offset + 4 <= bytes.byteLength &&
		((bytes[offset] === 0x49 &&
			bytes[offset + 1] === 0x49 &&
			bytes[offset + 2] === 0x2a &&
			bytes[offset + 3] === 0x00) ||
			(bytes[offset] === 0x4d &&
				bytes[offset + 1] === 0x4d &&
				bytes[offset + 2] === 0x00 &&
				bytes[offset + 3] === 0x2a) ||
			(bytes[offset] === 0x00 &&
				bytes[offset + 1] === 0x00 &&
				(bytes[offset + 2] === 0x01 || bytes[offset + 2] === 0x02) &&
				bytes[offset + 3] === 0x00) ||
			(bytes[offset] === 0xd7 &&
				bytes[offset + 1] === 0xcd &&
				bytes[offset + 2] === 0xc6 &&
				bytes[offset + 3] === 0x9a))
	)
		return true;
	if (offset + 12 <= bytes.byteLength) {
		const header = new TextDecoder("latin1").decode(
			bytes.subarray(offset, offset + 12),
		);
		if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return true;
		if (
			header.slice(4, 8) === "ftyp" &&
			/(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)/u.test(header.slice(8))
		) {
			return true;
		}
		if (
			header === "\u0000\u0000\u0000\u000cjP  \r\n\u0087\n" ||
			header === "\u0000\u0000\u000cJXL \r\n\u0087\n"
		)
			return true;
	}
	if (
		offset + 2 <= bytes.byteLength &&
		bytes[offset] === 0xff &&
		bytes[offset + 1] === 0x0a
	)
		return true;
	if (
		offset + 44 <= bytes.byteLength &&
		bytes[offset] === 0x01 &&
		bytes[offset + 1] === 0x00 &&
		bytes[offset + 40] === 0x20 &&
		bytes[offset + 41] === 0x45 &&
		bytes[offset + 42] === 0x4d &&
		bytes[offset + 43] === 0x46
	)
		return true;
	return false;
}

function containsImagePayload(bytes: Uint8Array): boolean {
	if (imageSignatureAt(bytes, 0)) return true;
	const text = new TextDecoder("latin1").decode(
		bytes.subarray(0, Math.min(bytes.byteLength, 4_096)),
	);
	return /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(text);
}

async function rejectImagePayloads(
	bytes: Uint8Array,
	entries: readonly ZipEntry[],
): Promise<void> {
	for (const entry of entries) {
		if (
			containsImagePayload(
				await inflateEntry(bytes, entry, ZIP_MAX_UNCOMPRESSED_BYTES),
			)
		) {
			failure("active_content");
		}
	}
}

function entryMap(entries: readonly ZipEntry[]): Map<string, ZipEntry> {
	return new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
}

type XmlElement = {
	name: string;
	attributes: Map<string, string>;
};

function decodeXmlEntities(value: string): string {
	const entityPattern = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/giu;
	if (value.replace(entityPattern, "").includes("&"))
		failure("invalid_container");
	return value.replace(
		entityPattern,
		(
			match,
			decimal: string | undefined,
			hexadecimal: string | undefined,
			named: string | undefined,
		) => {
			if (named) {
				const entities = new Map([
					["amp", "&"],
					["quot", '"'],
					["apos", "'"],
					["lt", "<"],
					["gt", ">"],
				]);
				return (
					entities.get(named.toLowerCase()) ?? failure("invalid_container")
				);
			}
			const codePoint = Number.parseInt(
				decimal ?? hexadecimal ?? "",
				decimal ? 10 : 16,
			);
			if (
				!Number.isSafeInteger(codePoint) ||
				codePoint <= 0 ||
				codePoint > 0x10ffff ||
				(codePoint >= 0xd800 && codePoint <= 0xdfff)
			)
				failure("invalid_container");
			return String.fromCodePoint(codePoint);
		},
	);
}

function parseXmlElements(value: string): XmlElement[] {
	if (/<!\s*(?:doctype|entity)/iu.test(value)) failure("active_content");
	const elements: XmlElement[] = [];
	let offset = 0;
	while (offset < value.length) {
		const open = value.indexOf("<", offset);
		if (open === -1) break;
		if (value.startsWith("<!--", open)) {
			const close = value.indexOf("-->", open + 4);
			if (close === -1) failure("invalid_container");
			offset = close + 3;
			continue;
		}
		if (value.startsWith("<?", open)) {
			const close = value.indexOf("?>", open + 2);
			if (close === -1) failure("invalid_container");
			offset = close + 2;
			continue;
		}
		if (value.startsWith("</", open)) {
			const close = value.indexOf(">", open + 2);
			if (close === -1) failure("invalid_container");
			offset = close + 1;
			continue;
		}
		if (value.startsWith("<!", open)) failure("invalid_container");
		let close = open + 1;
		let quote = "";
		for (; close < value.length; close += 1) {
			const character = value[close]!;
			if (quote) {
				if (character === quote) quote = "";
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === ">") {
				break;
			}
		}
		if (close >= value.length || quote) failure("invalid_container");
		const raw = value
			.slice(open + 1, close)
			.trim()
			.replace(/\/$/u, "")
			.trim();
		const nameMatch = /^([^\s/>]+)/u.exec(raw);
		if (!nameMatch) failure("invalid_container");
		const name = nameMatch[1]!.split(":").at(-1)!.toLowerCase();
		const attributes = new Map<string, string>();
		let attributeOffset = nameMatch[0].length;
		while (attributeOffset < raw.length) {
			while (/\s/u.test(raw[attributeOffset] ?? "")) attributeOffset += 1;
			if (attributeOffset >= raw.length) break;
			const attributeMatch = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])/u.exec(
				raw.slice(attributeOffset),
			);
			if (!attributeMatch) failure("invalid_container");
			const attributeName = attributeMatch[1]!.split(":").at(-1)!.toLowerCase();
			const attributeQuote = attributeMatch[2]!;
			const valueStart = attributeOffset + attributeMatch[0].length;
			const valueEnd = raw.indexOf(attributeQuote, valueStart);
			if (valueEnd === -1 || attributes.has(attributeName))
				failure("invalid_container");
			attributes.set(
				attributeName,
				decodeXmlEntities(raw.slice(valueStart, valueEnd)),
			);
			attributeOffset = valueEnd + 1;
		}
		elements.push({ name, attributes });
		offset = close + 1;
	}
	return elements;
}

function relationshipOwnerPath(name: string): string {
	const normalized = name.toLowerCase();
	if (normalized === "_rels/.rels") return "";
	const match = /^(.*\/)?_rels\/([^/]+)\.rels$/u.exec(normalized);
	if (!match) failure("invalid_container");
	return `${match[1] ?? ""}${match[2]}`;
}

function relationshipPartPath(owner: string): string {
	if (!owner) return "_rels/.rels";
	const separator = owner.lastIndexOf("/");
	const directory = separator === -1 ? "" : owner.slice(0, separator + 1);
	const filename = owner.slice(separator + 1);
	return `${directory}_rels/${filename}.rels`;
}

function normalizePackageTarget(
	owner: string,
	rawTarget: string,
): string | null {
	let target: string;
	try {
		target = decodeURIComponent(rawTarget.trim());
	} catch {
		return failure("invalid_container");
	}
	if (!target) return failure("invalid_container");
	if (target.startsWith("#")) return null;
	if (
		/^[a-z][a-z0-9+.-]*:/iu.test(target) ||
		target.startsWith("//") ||
		target.startsWith("/") ||
		target.includes("\\") ||
		target.includes("?")
	) {
		failure("active_content");
	}
	const fragment = target.indexOf("#");
	if (fragment !== -1) target = target.slice(0, fragment);
	const separator = owner.lastIndexOf("/");
	const pieces = (
		separator === -1 ? [] : owner.slice(0, separator).split("/")
	).filter(Boolean);
	for (const piece of target.split("/")) {
		if (!piece || piece === ".") continue;
		if (piece === "..") {
			if (pieces.length === 0) failure("active_content");
			pieces.pop();
			continue;
		}
		pieces.push(piece);
	}
	if (pieces.length === 0) return failure("invalid_container");
	return safeZipName(pieces.join("/")).toLowerCase();
}

function readVarint(
	bytes: Uint8Array,
	start: number,
): { value: number; next: number } {
	let value = 0;
	let multiplier = 1;
	for (
		let offset = start;
		offset < bytes.byteLength && offset < start + 8;
		offset += 1
	) {
		const byte = bytes[offset]!;
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) failure("invalid_container");
		if ((byte & 0x80) === 0) return { value, next: offset + 1 };
		multiplier *= 128;
	}
	return failure("invalid_container");
}

function decodeSnappyBlock(bytes: Uint8Array): Uint8Array {
	const declared = readVarint(bytes, 0);
	if (declared.value > ZIP_MAX_UNCOMPRESSED_BYTES)
		failure("decompression_exceeded");
	const output = new Uint8Array(declared.value);
	let inputOffset = declared.next;
	let outputOffset = 0;
	while (inputOffset < bytes.byteLength) {
		const tag = bytes[inputOffset++]!;
		const type = tag & 0x03;
		if (type === 0) {
			let length = tag >>> 2;
			if (length < 60) {
				length += 1;
			} else {
				const lengthBytes = length - 59;
				if (
					lengthBytes < 1 ||
					lengthBytes > 4 ||
					inputOffset + lengthBytes > bytes.byteLength
				) {
					failure("invalid_container");
				}
				length = 1;
				for (let index = 0; index < lengthBytes; index += 1) {
					length += bytes[inputOffset + index]! * 2 ** (8 * index);
				}
				inputOffset += lengthBytes;
			}
			if (
				inputOffset + length > bytes.byteLength ||
				outputOffset + length > output.byteLength
			) {
				failure("invalid_container");
			}
			output.set(
				bytes.subarray(inputOffset, inputOffset + length),
				outputOffset,
			);
			inputOffset += length;
			outputOffset += length;
			continue;
		}
		let length: number;
		let copyOffset: number;
		if (type === 1) {
			if (inputOffset >= bytes.byteLength) failure("invalid_container");
			length = 4 + ((tag >>> 2) & 0x07);
			copyOffset = ((tag & 0xe0) << 3) | bytes[inputOffset++]!;
		} else if (type === 2) {
			if (inputOffset + 2 > bytes.byteLength) failure("invalid_container");
			length = 1 + (tag >>> 2);
			copyOffset = bytes[inputOffset]! | (bytes[inputOffset + 1]! << 8);
			inputOffset += 2;
		} else {
			if (inputOffset + 4 > bytes.byteLength) failure("invalid_container");
			length = 1 + (tag >>> 2);
			copyOffset = new DataView(
				bytes.buffer,
				bytes.byteOffset + inputOffset,
				4,
			).getUint32(0, true);
			inputOffset += 4;
		}
		if (
			copyOffset <= 0 ||
			copyOffset > outputOffset ||
			outputOffset + length > output.byteLength
		) {
			failure("invalid_container");
		}
		for (let index = 0; index < length; index += 1) {
			output[outputOffset] = output[outputOffset - copyOffset]!;
			outputOffset += 1;
		}
	}
	if (outputOffset !== output.byteLength) failure("invalid_container");
	return output;
}

function decodeIwa(bytes: Uint8Array): Uint8Array {
	const outputs: Uint8Array[] = [];
	let total = 0;
	let offset = 0;
	while (offset < bytes.byteLength) {
		if (offset + 4 > bytes.byteLength || bytes[offset] !== 0)
			failure("invalid_container");
		const compressedLength =
			bytes[offset + 1]! |
			(bytes[offset + 2]! << 8) |
			(bytes[offset + 3]! << 16);
		offset += 4;
		if (compressedLength <= 0 || offset + compressedLength > bytes.byteLength) {
			failure("invalid_container");
		}
		const output = decodeSnappyBlock(
			bytes.subarray(offset, offset + compressedLength),
		);
		total += output.byteLength;
		if (
			total > ZIP_MAX_UNCOMPRESSED_BYTES ||
			total / (offset + compressedLength) > ZIP_MAX_RATIO
		)
			failure("decompression_exceeded");
		outputs.push(output);
		offset += compressedLength;
	}
	const combined = new Uint8Array(total);
	let outputOffset = 0;
	for (const output of outputs) {
		combined.set(output, outputOffset);
		outputOffset += output.byteLength;
	}
	return combined;
}

function skipProtobufField(
	bytes: Uint8Array,
	offset: number,
	wireType: number,
): number {
	if (wireType === 0) return readVarint(bytes, offset).next;
	if (wireType === 1) {
		if (offset + 8 > bytes.byteLength) failure("invalid_container");
		return offset + 8;
	}
	if (wireType === 2) {
		const length = readVarint(bytes, offset);
		if (length.next + length.value > bytes.byteLength)
			failure("invalid_container");
		return length.next + length.value;
	}
	if (wireType === 5) {
		if (offset + 4 > bytes.byteLength) failure("invalid_container");
		return offset + 4;
	}
	return failure("invalid_container");
}

type ProtobufField = {
	number: number;
	wireType: number;
	value?: number;
	bytes?: Uint8Array;
};

function parseProtobufFields(bytes: Uint8Array): ProtobufField[] {
	const fields: ProtobufField[] = [];
	let offset = 0;
	while (offset < bytes.byteLength) {
		const key = readVarint(bytes, offset);
		offset = key.next;
		const number = Math.floor(key.value / 8);
		const wireType = key.value & 0x07;
		if (number <= 0 || ![0, 1, 2, 5].includes(wireType)) {
			failure("invalid_container");
		}
		if (wireType === 0) {
			const value = readVarint(bytes, offset);
			fields.push({ number, wireType, value: value.value });
			offset = value.next;
			continue;
		}
		if (wireType === 2) {
			const length = readVarint(bytes, offset);
			const end = length.next + length.value;
			if (end > bytes.byteLength) failure("invalid_container");
			fields.push({
				number,
				wireType,
				bytes: bytes.subarray(length.next, end),
			});
			offset = end;
			continue;
		}
		offset = skipProtobufField(bytes, offset, wireType);
		fields.push({ number, wireType });
	}
	return fields;
}

function isNumbersDocumentRoot(fields: readonly ProtobufField[]): boolean {
	return fields.some((field) => {
		if (field.number !== 1 || field.wireType !== 2 || !field.bytes)
			return false;
		try {
			return parseProtobufFields(field.bytes).some(
				(referenceField) =>
					referenceField.number === 1 &&
					referenceField.wireType === 0 &&
					(referenceField.value ?? 0) > 0,
			);
		} catch (error) {
			if (error instanceof SemanticAttachmentExtractionError) return false;
			throw error;
		}
	});
}

function protobufContainsImage(
	fields: readonly ProtobufField[],
	depth = 0,
): boolean {
	if (depth > 16) failure("invalid_container");
	for (const field of fields) {
		if (!field.bytes || field.bytes.byteLength === 0) continue;
		if (containsImagePayload(field.bytes)) return true;
		let nested: ProtobufField[];
		try {
			nested = parseProtobufFields(field.bytes);
		} catch (error) {
			if (!(error instanceof SemanticAttachmentExtractionError)) throw error;
			continue;
		}
		if (nested.length > 0 && protobufContainsImage(nested, depth + 1))
			return true;
	}
	return false;
}

function parseIwaMessageInfo(bytes: Uint8Array): {
	type: number;
	length: number;
} {
	let type: number | undefined;
	let length: number | undefined;
	let offset = 0;
	while (offset < bytes.byteLength) {
		const key = readVarint(bytes, offset);
		offset = key.next;
		const field = Math.floor(key.value / 8);
		const wireType = key.value & 0x07;
		if ((field === 1 || field === 3) && wireType === 0) {
			const result = readVarint(bytes, offset);
			if (field === 1) type = result.value;
			else length = result.value;
			offset = result.next;
		} else {
			offset = skipProtobufField(bytes, offset, wireType);
		}
	}
	if (type === undefined || length === undefined) failure("invalid_container");
	return { type, length };
}

function validateNumbersIwa(bytes: Uint8Array, requireDocument: boolean): void {
	const decoded = decodeIwa(bytes);
	let offset = 0;
	let sawNumbersDocument = false;
	while (offset < decoded.byteLength) {
		const archiveLength = readVarint(decoded, offset);
		offset = archiveLength.next;
		if (
			archiveLength.value <= 0 ||
			offset + archiveLength.value > decoded.byteLength
		) {
			failure("invalid_container");
		}
		const archive = decoded.subarray(offset, offset + archiveLength.value);
		offset += archiveLength.value;
		const messages: Array<{ type: number; length: number }> = [];
		let archiveOffset = 0;
		while (archiveOffset < archive.byteLength) {
			const key = readVarint(archive, archiveOffset);
			archiveOffset = key.next;
			const field = Math.floor(key.value / 8);
			const wireType = key.value & 0x07;
			if (field === 2 && wireType === 2) {
				const messageLength = readVarint(archive, archiveOffset);
				const messageEnd = messageLength.next + messageLength.value;
				if (messageEnd > archive.byteLength) failure("invalid_container");
				messages.push(
					parseIwaMessageInfo(archive.subarray(messageLength.next, messageEnd)),
				);
				archiveOffset = messageEnd;
			} else {
				archiveOffset = skipProtobufField(archive, archiveOffset, wireType);
			}
		}
		if (messages.length === 0) failure("invalid_container");
		for (const message of messages) {
			if (
				!Number.isSafeInteger(message.length) ||
				offset + message.length > decoded.byteLength
			) {
				failure("invalid_container");
			}
			const payload = decoded.subarray(offset, offset + message.length);
			const fields = parseProtobufFields(payload);
			if (containsImagePayload(payload) || protobufContainsImage(fields))
				failure("active_content");
			if (message.type === 1) {
				if (!isNumbersDocumentRoot(fields) || sawNumbersDocument) {
					failure("invalid_container");
				}
				sawNumbersDocument = true;
			}
			offset += payload.byteLength;
		}
	}
	if (requireDocument && !sawNumbersDocument) failure("invalid_container");
}

function rejectDangerousZipEntries(
	format: Exclude<SemanticRichDocumentFormat, "pdf" | "xls">,
	entries: readonly ZipEntry[],
): void {
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		if (
			/(^|\/)(vba|macros?|_vba_project_cur)(\/|\.|$)/u.test(name) ||
			/vbaproject\.bin$/u.test(name) ||
			/(^|\/)(basic|scripts)(\/|$)/u.test(name) ||
			/(^|\/)(embeddings|activex|customui|externallinks)(\/|$)/u.test(name) ||
			/(^|\/)(?:af|alt)chunk[^/]*(?:\/|\.|$)/u.test(name) ||
			/\.(?:exe|dll|com|bat|cmd|ps1|vbs|scr|msi|dmg|iso|jar)$/u.test(name) ||
			/\.(?:zip|7z|rar|tar|gz|bz2|xz)$/u.test(name)
		)
			failure("active_content");
		if (
			format !== "docx" &&
			/\.(?:avif|bmp|emf|gif|heic|ico|jp2|jpe?g|jxl|png|svg|tiff?|webp|wmf)$/u.test(
				name,
			)
		)
			failure("active_content");
	}
}

async function preflightZip(
	format: Exclude<SemanticRichDocumentFormat, "pdf" | "xls">,
	bytes: Uint8Array,
): Promise<void> {
	const entries = zipEntries(bytes);
	await validateZipPayloads(bytes, entries);
	rejectDangerousZipEntries(format, entries);
	if (format !== "docx") await rejectImagePayloads(bytes, entries);
	const byName = entryMap(entries);
	if (format === "docx" || format === "xlsx") {
		const mainName =
			format === "docx" ? "word/document.xml" : "xl/workbook.xml";
		const required = ["[content_types].xml", "_rels/.rels", mainName];
		if (required.some((name) => !byName.has(name)))
			failure("invalid_container");
		const contentTypes = parseXmlElements(
			await zipEntryText(bytes, byName.get("[content_types].xml")!),
		);
		const expected =
			format === "docx"
				? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
				: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
		const overrides = new Map<string, string>();
		const defaults = new Map<string, string>();
		for (const element of contentTypes) {
			if (element.name !== "override" && element.name !== "default") continue;
			const contentType =
				element.attributes.get("contenttype")?.trim().toLowerCase() ?? "";
			if (!contentType) failure("invalid_container");
			if (
				/macroenabled|vbaproject|oleobject|activex/iu.test(contentType) ||
				(format === "xlsx" && /^image\//iu.test(contentType))
			)
				failure("active_content");
			if (element.name === "override") {
				const partName = element.attributes
					.get("partname")
					?.trim()
					.replace(/^\//u, "")
					.toLowerCase();
				if (!partName || overrides.has(partName)) failure("invalid_container");
				overrides.set(partName, contentType);
			} else {
				const extension = element.attributes
					.get("extension")
					?.trim()
					.replace(/^\./u, "")
					.toLowerCase();
				if (!extension || defaults.has(extension)) failure("invalid_container");
				defaults.set(extension, contentType);
			}
		}
		if (overrides.get(mainName) !== expected) failure("invalid_container");

		const relationshipsByOwner = new Map<
			string,
			Array<{ target: string | null; type: string }>
		>();
		for (const entry of entries.filter((candidate) =>
			candidate.name.toLowerCase().endsWith(".rels"),
		)) {
			const owner = relationshipOwnerPath(entry.name);
			if (relationshipsByOwner.has(owner)) failure("invalid_container");
			const relationships = parseXmlElements(
				await zipEntryText(bytes, entry),
			).filter((element) => element.name === "relationship");
			const parsed: Array<{ target: string | null; type: string }> = [];
			for (const relationship of relationships) {
				const type =
					relationship.attributes.get("type")?.trim().toLowerCase() ?? "";
				const rawTarget = relationship.attributes.get("target")?.trim() ?? "";
				const targetMode =
					relationship.attributes.get("targetmode")?.trim().toLowerCase() ?? "";
				if (
					!type ||
					(targetMode !== "" && targetMode !== "internal") ||
					(format === "xlsx" && type.endsWith("/image")) ||
					/oleobject|attachedtemplate|externallink|afchunk|altchunk|activex|\/package/iu.test(
						type,
					) ||
					/(^|\/)(?:af|alt)chunk|(^|\/)(?:embeddings|activex|externallinks)(\/|$)/iu.test(
						rawTarget,
					)
				)
					failure("active_content");
				parsed.push({
					target: normalizePackageTarget(owner, rawTarget),
					type,
				});
			}
			relationshipsByOwner.set(owner, parsed);
		}
		const rootRelationships = relationshipsByOwner.get("");
		if (!rootRelationships) failure("invalid_container");
		const rootDocuments = rootRelationships.filter(
			(relationship) =>
				relationship.type.endsWith("/officedocument") &&
				relationship.target === mainName,
		);
		if (rootDocuments.length !== 1) failure("invalid_container");

		const reachable = new Set(["[content_types].xml", "_rels/.rels"]);
		const queue = rootRelationships.flatMap((relationship) =>
			relationship.target ? [relationship.target] : [],
		);
		while (queue.length > 0) {
			const part = queue.shift()!;
			if (reachable.has(part)) continue;
			if (!byName.has(part)) failure("invalid_container");
			reachable.add(part);
			const relationshipPart = relationshipPartPath(part);
			const nested = relationshipsByOwner.get(part);
			if (!nested) continue;
			if (!byName.has(relationshipPart)) failure("invalid_container");
			reachable.add(relationshipPart);
			for (const relationship of nested) {
				if (relationship.target) queue.push(relationship.target);
			}
		}
		if (
			entries.some((entry) => !reachable.has(entry.name.toLowerCase())) ||
			[...relationshipsByOwner.keys()].some(
				(owner) => owner && !reachable.has(owner),
			)
		)
			failure("active_content");
		for (const part of reachable) {
			if (part === "[content_types].xml" || part.endsWith(".rels")) continue;
			const extension = part.includes(".") ? part.split(".").at(-1)! : "";
			const contentType = overrides.get(part) ?? defaults.get(extension);
			if (!contentType) failure("invalid_container");
			if (format === "xlsx" && /^image\//iu.test(contentType))
				failure("active_content");
		}
		return;
	}
	if (format === "odt" || format === "ods") {
		const mimetype = byName.get("mimetype");
		const manifest = byName.get("meta-inf/manifest.xml");
		if (
			!mimetype ||
			!manifest ||
			!byName.has("content.xml") ||
			mimetype.method !== 0
		) {
			failure("invalid_container");
		}
		const expected =
			format === "odt"
				? "application/vnd.oasis.opendocument.text"
				: "application/vnd.oasis.opendocument.spreadsheet";
		if ((await zipEntryText(bytes, mimetype)) !== expected)
			failure("invalid_container");
		const manifestText = await zipEntryText(bytes, manifest);
		if (
			/encryption-data|encrypted-package|algorithm-name/iu.test(manifestText)
		) {
			failure("encrypted_document");
		}
		if (
			/script|macro|application\/vnd\.sun\.star\.basic/iu.test(manifestText)
		) {
			failure("active_content");
		}
		const manifestElements = parseXmlElements(manifestText);
		const manifestEntries = new Map<string, string>();
		for (const element of manifestElements) {
			if (element.name !== "file-entry") continue;
			const rawPath = element.attributes.get("full-path")?.trim() ?? "";
			const mediaType =
				element.attributes.get("media-type")?.trim().toLowerCase() ?? "";
			if (!rawPath) failure("invalid_container");
			const path =
				rawPath === "/"
					? "/"
					: normalizePackageTarget("", rawPath.replace(/\/$/u, ""));
			if (!path || manifestEntries.has(path)) failure("invalid_container");
			if (/^image\//iu.test(mediaType)) failure("active_content");
			manifestEntries.set(path, mediaType);
		}
		if (
			manifestEntries.get("/") !== expected ||
			!manifestEntries.has("content.xml")
		)
			failure("invalid_container");
		for (const entry of entries) {
			const name = entry.name.toLowerCase();
			if (name === "mimetype" || name === "meta-inf/manifest.xml") continue;
			const mediaType = manifestEntries.get(name);
			if (mediaType === undefined) failure("active_content");
			if (!/\.(?:xml|rdf)$/u.test(name)) failure("active_content");
			if (
				mediaType &&
				mediaType !== "text/xml" &&
				mediaType !== "application/xml" &&
				mediaType !== "application/rdf+xml"
			)
				failure("active_content");
		}
		for (const entry of entries) {
			const name = entry.name.toLowerCase();
			if (name === "meta-inf/manifest.xml" || !/\.(?:xml|rdf)$/u.test(name))
				continue;
			const elements = parseXmlElements(await zipEntryText(bytes, entry));
			for (const element of elements) {
				if (
					[
						"scripts",
						"script",
						"event-listener",
						"event-listeners",
						"binary-data",
						"image",
						"object",
						"object-ole",
						"plugin",
						"applet",
					].includes(element.name)
				)
					failure("active_content");
				const href = element.attributes.get("href")?.trim() ?? "";
				if (href) {
					const target = normalizePackageTarget(name, href);
					if (target && (!manifestEntries.has(target) || !byName.has(target)))
						failure("active_content");
				}
				if (
					[...element.attributes.keys()].some(
						(attribute) =>
							attribute === "event-name" || attribute.startsWith("on"),
					)
				)
					failure("active_content");
			}
		}
		return;
	}
	const document = byName.get("index/document.iwa");
	if (!document) failure("invalid_container");
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		if (name.startsWith("index/") && name.endsWith(".iwa")) {
			validateNumbersIwa(
				await inflateEntry(bytes, entry, ZIP_MAX_UNCOMPRESSED_BYTES),
				name === "index/document.iwa",
			);
			continue;
		}
		if (
			/^metadata\/(?:buildversionhistory|properties)\.plist$/u.test(name) ||
			name === "metadata/documentidentifier"
		)
			continue;
		failure("active_content");
	}
}

function validateClassicPdfXref(
	text: string,
	xrefOffset: number,
	endOffset: number,
): void {
	if (
		!Number.isSafeInteger(xrefOffset) ||
		xrefOffset <= 0 ||
		xrefOffset >= endOffset
	) {
		return failure("invalid_container");
	}
	const lines = text.slice(xrefOffset, endOffset).split(/\r?\n/u);
	if (lines[0]?.trim() !== "xref") failure("invalid_container");
	const objectNumbers = new Set<number>();
	let lineIndex = 1;
	let sawFreeObjectZero = false;
	while (lineIndex < lines.length && lines[lineIndex]?.trim() !== "trailer") {
		const section = /^(\d+)\s+(\d+)$/u.exec(lines[lineIndex]!.trim());
		if (!section) failure("invalid_container");
		const firstObject = Number.parseInt(section[1]!, 10);
		const count = Number.parseInt(section[2]!, 10);
		if (
			!Number.isSafeInteger(firstObject) ||
			!Number.isSafeInteger(count) ||
			count <= 0
		) {
			failure("invalid_container");
		}
		lineIndex += 1;
		for (let item = 0; item < count; item += 1, lineIndex += 1) {
			const entry = /^(\d{10})\s(\d{5})\s([fn])\s*$/u.exec(
				lines[lineIndex] ?? "",
			);
			if (!entry) failure("invalid_container");
			const objectNumber = firstObject + item;
			if (objectNumbers.has(objectNumber)) failure("invalid_container");
			objectNumbers.add(objectNumber);
			const generation = Number.parseInt(entry[2]!, 10);
			if (entry[3] === "f") {
				if (objectNumber === 0) sawFreeObjectZero = true;
				continue;
			}
			const objectOffset = Number.parseInt(entry[1]!, 10);
			if (
				objectOffset <= 0 ||
				objectOffset >= xrefOffset ||
				!new RegExp(`^${objectNumber}\\s+${generation}\\s+obj\\b`, "u").test(
					text.slice(objectOffset),
				)
			)
				failure("invalid_container");
		}
	}
	if (!sawFreeObjectZero || lines[lineIndex]?.trim() !== "trailer") {
		failure("invalid_container");
	}
	const trailer = lines.slice(lineIndex + 1).join("\n");
	if (
		!/<<[\s\S]*\/Size\s+\d+[\s\S]*\/Root\s+\d+\s+\d+\s+R[\s\S]*>>/u.test(
			trailer,
		)
	) {
		failure("invalid_container");
	}
}

function preflightPdf(bytes: Uint8Array): void {
	if (bytes.byteLength < 24) failure("invalid_container");
	const text = new TextDecoder("latin1").decode(bytes);
	if (!/^%PDF-(?:1\.[0-9]|2\.0)[\r\n]/u.test(text))
		failure("invalid_container");
	const end = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(text);
	if (!end) failure("invalid_container");
	const xrefOffset = Number.parseInt(end[1]!, 10);
	validateClassicPdfXref(text, xrefOffset, end.index);
	const normalizedNames = text.replace(
		/#([0-9a-f]{2})/giu,
		(_match, hexadecimal: string) =>
			String.fromCharCode(Number.parseInt(hexadecimal, 16)),
	);
	if (/\/(?:ObjStm|XRef|Prev|XRefStm)\b/iu.test(normalizedNames)) {
		failure("invalid_container");
	}
	if (/\/Encrypt\b/iu.test(normalizedNames)) failure("encrypted_document");
	if (
		/\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|OpenAction|AA|AcroForm|SubmitForm|ImportData|GoToE)\b/iu.test(
			normalizedNames,
		)
	) {
		failure("active_content");
	}
}

function cfbSector(
	bytes: Uint8Array,
	sectorSize: number,
	sectorId: number,
): Uint8Array {
	const totalSectors = (bytes.byteLength - sectorSize) / sectorSize;
	if (
		!Number.isSafeInteger(sectorId) ||
		sectorId < 0 ||
		sectorId >= totalSectors
	) {
		failure("invalid_container");
	}
	const offset = sectorSize + sectorId * sectorSize;
	return bytes.subarray(offset, offset + sectorSize);
}

function cfbChain(
	bytes: Uint8Array,
	sectorSize: number,
	fat: readonly number[],
	startSector: number,
	maximumSectors = CFB_MAX_CHAIN_SECTORS,
): Uint8Array {
	if (startSector === CFB_END_OF_CHAIN) return new Uint8Array();
	const sectors: Uint8Array[] = [];
	const seen = new Set<number>();
	let sector = startSector;
	while (sector !== CFB_END_OF_CHAIN) {
		if (
			sector === CFB_FREE_SECTOR ||
			sector === CFB_FAT_SECTOR ||
			sector === CFB_DIFAT_SECTOR ||
			seen.has(sector) ||
			sectors.length >= maximumSectors ||
			sector >= fat.length
		)
			failure("invalid_container");
		seen.add(sector);
		sectors.push(cfbSector(bytes, sectorSize, sector));
		sector = fat[sector]!;
	}
	const output = new Uint8Array(sectors.length * sectorSize);
	sectors.forEach((value, index) => output.set(value, index * sectorSize));
	return output;
}

function preflightXls(bytes: Uint8Array): void {
	if (bytes.byteLength < 1_024) failure("invalid_container");
	const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	if (signature.some((byte, index) => bytes[index] !== byte))
		failure("invalid_container");
	const header = boundedView(bytes, 0, 512);
	const major = header.getUint16(26, true);
	const sectorShift = header.getUint16(30, true);
	const sectorSize = 2 ** sectorShift;
	if (
		header.getUint16(28, true) !== 0xfffe ||
		header.getUint16(32, true) !== 6 ||
		!(
			(major === 3 && sectorSize === 512) ||
			(major === 4 && sectorSize === 4096)
		) ||
		bytes.byteLength < sectorSize ||
		(bytes.byteLength - sectorSize) % sectorSize !== 0
	)
		failure("invalid_container");
	const totalSectors = (bytes.byteLength - sectorSize) / sectorSize;
	const fatCount = header.getUint32(44, true);
	if (
		fatCount === 0 ||
		fatCount > totalSectors ||
		fatCount > CFB_MAX_CHAIN_SECTORS
	) {
		failure("invalid_container");
	}
	const fatSectors: number[] = [];
	for (let index = 0; index < 109; index += 1) {
		const sector = header.getUint32(76 + index * 4, true);
		if (sector !== CFB_FREE_SECTOR) fatSectors.push(sector);
	}
	const difatCount = header.getUint32(72, true);
	let difatSector = header.getUint32(68, true);
	const seenDifat = new Set<number>();
	for (let index = 0; index < difatCount; index += 1) {
		if (seenDifat.has(difatSector)) failure("invalid_container");
		seenDifat.add(difatSector);
		const sectorBytes = cfbSector(bytes, sectorSize, difatSector);
		const view = new DataView(
			sectorBytes.buffer,
			sectorBytes.byteOffset,
			sectorBytes.byteLength,
		);
		for (let item = 0; item < sectorSize / 4 - 1; item += 1) {
			const value = view.getUint32(item * 4, true);
			if (value !== CFB_FREE_SECTOR) fatSectors.push(value);
		}
		difatSector = view.getUint32(sectorSize - 4, true);
	}
	if (difatSector !== CFB_END_OF_CHAIN || fatSectors.length !== fatCount) {
		failure("invalid_container");
	}
	const uniqueFat = new Set(fatSectors);
	if (uniqueFat.size !== fatSectors.length) failure("invalid_container");
	const fat: number[] = [];
	for (const sector of fatSectors) {
		const data = cfbSector(bytes, sectorSize, sector);
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let offset = 0; offset < data.byteLength; offset += 4) {
			fat.push(view.getUint32(offset, true));
		}
	}
	for (const sector of fatSectors) {
		if (fat[sector] !== CFB_FAT_SECTOR) failure("invalid_container");
	}
	const directory = cfbChain(
		bytes,
		sectorSize,
		fat,
		header.getUint32(48, true),
	);
	if (directory.byteLength === 0 || directory.byteLength % 128 !== 0)
		failure("invalid_container");
	const directoryEntries: Array<{
		index: number;
		name: string;
		type: number;
		left: number;
		right: number;
		child: number;
		startSector: number;
		size: number;
	}> = [];
	for (let offset = 0; offset < directory.byteLength; offset += 128) {
		const view = new DataView(
			directory.buffer,
			directory.byteOffset + offset,
			128,
		);
		const nameLength = view.getUint16(64, true);
		const type = view.getUint8(66);
		if (type === 0 && nameLength === 0) continue;
		if (
			nameLength < 2 ||
			nameLength > 64 ||
			nameLength % 2 !== 0 ||
			![1, 2, 5].includes(type) ||
			view.getUint16(nameLength - 2, true) !== 0
		) {
			failure("invalid_container");
		}
		let name = "";
		for (let index = 0; index < nameLength - 2; index += 2) {
			const codeUnit = view.getUint16(index, true);
			if (codeUnit === 0) failure("invalid_container");
			name += String.fromCharCode(codeUnit);
		}
		const highSize = view.getUint32(124, true);
		if (major === 3 && highSize !== 0) failure("invalid_container");
		const size = view.getUint32(120, true) + highSize * 0x1_0000_0000;
		if (!Number.isSafeInteger(size) || size > ZIP_MAX_UNCOMPRESSED_BYTES) {
			failure("decompression_exceeded");
		}
		directoryEntries.push({
			index: offset / 128,
			name,
			type,
			left: view.getUint32(68, true),
			right: view.getUint32(72, true),
			child: view.getUint32(76, true),
			startSector: view.getUint32(116, true),
			size,
		});
	}
	const normalizedNames = directoryEntries.map((entry) =>
		entry.name.toLowerCase(),
	);
	if (
		normalizedNames.some(
			(name) =>
				name.includes("vba") ||
				name.includes("macro") ||
				name === "_vba_project_cur" ||
				name === "objectpool" ||
				name === "ole10native" ||
				name === "package",
		)
	)
		failure("active_content");
	if (
		normalizedNames.some(
			(name) =>
				name === "encryptedpackage" ||
				name === "encryptioninfo" ||
				name === "dataspaces" ||
				name === "drmcontent",
		)
	)
		failure("encrypted_document");
	const workbookCandidates = directoryEntries.filter(
		(entry) =>
			entry.type === 2 &&
			(entry.name.toLowerCase() === "workbook" ||
				entry.name.toLowerCase() === "book"),
	);
	if (workbookCandidates.length !== 1 || workbookCandidates[0]!.size === 0) {
		failure("invalid_container");
	}
	const workbook = workbookCandidates[0]!;
	const roots = directoryEntries.filter((entry) => entry.type === 5);
	if (
		roots.length !== 1 ||
		roots[0]!.index !== 0 ||
		roots[0]!.name !== "Root Entry" ||
		roots[0]!.left !== CFB_FREE_SECTOR ||
		roots[0]!.right !== CFB_FREE_SECTOR
	) {
		failure("invalid_container");
	}
	const byIndex = new Map(
		directoryEntries.map((entry) => [entry.index, entry]),
	);
	const reachable = new Set<number>();
	const stack = [roots[0]!.child];
	while (stack.length > 0) {
		const index = stack.pop()!;
		if (index === CFB_FREE_SECTOR) continue;
		const entry = byIndex.get(index);
		if (!entry || entry.type === 5 || reachable.has(index))
			failure("invalid_container");
		reachable.add(index);
		if (reachable.size > directoryEntries.length) failure("invalid_container");
		stack.push(entry.right);
		if (entry.type === 1) stack.push(entry.child);
		else if (entry.child !== CFB_FREE_SECTOR) failure("invalid_container");
		stack.push(entry.left);
	}
	if (reachable.size !== directoryEntries.length - 1)
		failure("invalid_container");
	let workbookBytes: Uint8Array;
	const miniCutoff = header.getUint32(56, true);
	if (workbook.size >= miniCutoff) {
		workbookBytes = cfbChain(
			bytes,
			sectorSize,
			fat,
			workbook.startSector,
		).subarray(0, workbook.size);
	} else {
		const root = directoryEntries.find((entry) => entry.type === 5);
		const miniFatCount = header.getUint32(64, true);
		if (!root || miniFatCount === 0) failure("invalid_container");
		const miniFatBytes = cfbChain(
			bytes,
			sectorSize,
			fat,
			header.getUint32(60, true),
			miniFatCount,
		);
		const miniFatView = new DataView(
			miniFatBytes.buffer,
			miniFatBytes.byteOffset,
			miniFatBytes.byteLength,
		);
		const miniFat: number[] = [];
		for (let offset = 0; offset < miniFatBytes.byteLength; offset += 4) {
			miniFat.push(miniFatView.getUint32(offset, true));
		}
		const miniStream = cfbChain(
			bytes,
			sectorSize,
			fat,
			root.startSector,
		).subarray(0, root.size);
		const chunks: Uint8Array[] = [];
		const seen = new Set<number>();
		let sector = workbook.startSector;
		while (sector !== CFB_END_OF_CHAIN) {
			if (sector >= miniFat.length || seen.has(sector))
				failure("invalid_container");
			seen.add(sector);
			const start = sector * 64;
			if (start + 64 > miniStream.byteLength) failure("invalid_container");
			chunks.push(miniStream.subarray(start, start + 64));
			sector = miniFat[sector]!;
		}
		workbookBytes = new Uint8Array(chunks.length * 64);
		chunks.forEach((chunk, index) => workbookBytes.set(chunk, index * 64));
		workbookBytes = workbookBytes.subarray(0, workbook.size);
	}
	if (workbookBytes.byteLength !== workbook.size) failure("invalid_container");
	let offset = 0;
	let inSubstream = false;
	let sawGlobals = false;
	let sawEof = false;
	while (offset + 4 <= workbookBytes.byteLength) {
		const view = new DataView(
			workbookBytes.buffer,
			workbookBytes.byteOffset + offset,
			4,
		);
		const record = view.getUint16(0, true);
		const length = view.getUint16(2, true);
		if (record === 0x0000) failure("invalid_container");
		if (offset + 4 + length > workbookBytes.byteLength)
			failure("invalid_container");
		const payload = boundedView(workbookBytes, offset + 4, length);
		if (record === 0x0809) {
			if (inSubstream || length < 4) failure("invalid_container");
			const type = payload.getUint16(2, true);
			if (!sawGlobals && type !== 0x0005) failure("invalid_container");
			if (type === 0x0040 || type === 0x0006) failure("active_content");
			sawGlobals = true;
			inSubstream = true;
		} else if (!inSubstream) {
			failure("invalid_container");
		}
		if (record === 0x002f) failure("encrypted_document");
		if (record === 0x00d3) failure("active_content");
		if ([0x005d, 0x007f, 0x00eb, 0x00ec, 0x00ed].includes(record)) {
			failure("active_content");
		}
		if (record === 0x0085 && length >= 6) {
			const sheetType = payload.getUint8(5);
			if (sheetType === 0x01 || sheetType === 0x06) failure("active_content");
		}
		if (record === 0x000a) {
			if (length !== 0) failure("invalid_container");
			sawEof = true;
			inSubstream = false;
		}
		offset += 4 + length;
		if (
			!inSubstream &&
			offset + 4 <= workbookBytes.byteLength &&
			workbookBytes[offset] === 0 &&
			workbookBytes[offset + 1] === 0 &&
			workbookBytes[offset + 2] === 0 &&
			workbookBytes[offset + 3] === 0
		) {
			if (!workbookBytes.subarray(offset).every((byte) => byte === 0)) {
				failure("invalid_container");
			}
			break;
		}
	}
	if (!sawGlobals || !sawEof || inSubstream) failure("invalid_container");
}

export async function preflightSemanticRichDocument(input: {
	format: SemanticRichDocumentFormat;
	bytes: ArrayBuffer;
}): Promise<void> {
	const bytes = new Uint8Array(input.bytes);
	if (input.format === "pdf") return preflightPdf(bytes);
	if (input.format === "xls") return preflightXls(bytes);
	return preflightZip(input.format, bytes);
}
