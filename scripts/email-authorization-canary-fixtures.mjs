import assert from "node:assert/strict";

const BOUNDARY = "canary-boundary";
const EMAIL_ADDRESS_PATTERN =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const PROBE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{15,95}$/u;
const MAX_BODY_LINE_BYTES = 76;

export const EMAIL_AUTHORIZATION_CANARY_SIZES = Object.freeze({
	aboveGeneralLimit: Math.ceil(5.1 * 1024 * 1024),
	nearInboundLimit: 24_960_359,
});

export const FIXTURE_LAYOUT = Object.freeze({
	rawBytes: 24_960_359,
	prefixBytes: 652,
	largeAttachmentBytes: 18_238_584,
	largeBase64Bytes: 24_318_112,
	largeWrappedBytes: 24_958_064,
	smallAttachmentBytes: 1_024,
	tailBytes: 1_640,
	epilogueBytes: 3,
});

function deterministicBytes(byteLength, seed) {
	const bytes = Buffer.allocUnsafe(byteLength);
	let state = seed >>> 0;
	for (let index = 0; index < bytes.length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

function wrapBase64(bytes) {
	const encoded = bytes.toString("base64");
	const lines = encoded.match(/.{1,76}/gu) ?? [];
	return { encoded, wrapped: `${lines.join("\r\n")}\r\n` };
}

function paddedHeader(name, targetBytes, surrounding) {
	const fixedBytes = Buffer.byteLength(`${name}: \r\n`, "ascii");
	const paddingBytes =
		targetBytes - Buffer.byteLength(surrounding, "ascii") - fixedBytes;
	assert.ok(paddingBytes >= 0, `${name} padding target is too small`);
	return `${name}: ${"p".repeat(paddingBytes)}\r\n`;
}

function assertEmailAddress(value) {
	assert.equal(
		typeof value === "string" && EMAIL_ADDRESS_PATTERN.test(value),
		true,
		"Canary fixture requires a valid ASCII email address",
	);
}

function lineWrappedAscii(byteLength) {
	const fullLine = `${"c".repeat(MAX_BODY_LINE_BYTES)}\r\n`;
	const fullLineBytes = Buffer.byteLength(fullLine, "ascii");
	const fullLines = Math.floor(byteLength / fullLineBytes);
	const remainder = byteLength % fullLineBytes;
	if (remainder <= MAX_BODY_LINE_BYTES) {
		return fullLine.repeat(fullLines) + "c".repeat(remainder);
	}
	return (
		fullLine.repeat(fullLines) +
		"c".repeat(remainder - 2) +
		"\r\n"
	);
}

export function buildEmailAuthorizationFixture({
	from,
	to,
	probeId,
	rawBytes,
}) {
	assertEmailAddress(from);
	assertEmailAddress(to);
	assert.equal(
		typeof probeId === "string" && PROBE_ID_PATTERN.test(probeId),
		true,
		"Canary fixture requires a valid probe ID",
	);
	assert.equal(
		Number.isSafeInteger(rawBytes) && rawBytes > 1024,
		true,
		"Canary fixture size is too small",
	);

	const prefix = [
		`From: ${from}\r\n`,
		`To: ${to}\r\n`,
		`Subject: Mail authorization canary ${probeId}\r\n`,
		"Date: Fri, 17 Jul 2026 12:00:00 +0000\r\n",
		`Message-ID: <${probeId}@mail-authorization-canary.invalid>\r\n`,
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=us-ascii\r\n",
		"Content-Transfer-Encoding: 7bit\r\n",
		`X-Canary-Probe-ID: ${probeId}\r\n`,
		`X-Canary-Raw-Bytes: ${rawBytes}\r\n`,
		"\r\n",
		"Deterministic Cloudflare email authorization canary.\r\n",
	].join("");
	const prefixBytes = Buffer.byteLength(prefix, "ascii");
	assert.ok(rawBytes > prefixBytes, "Canary fixture size is too small");
	const raw = Buffer.from(
		prefix + lineWrappedAscii(rawBytes - prefixBytes),
		"ascii",
	);
	assert.equal(raw.byteLength, rawBytes);
	return { probeId, raw, rawBytes };
}

export function buildExactSizeFixture() {
	const largeAttachment = deterministicBytes(
		FIXTURE_LAYOUT.largeAttachmentBytes,
		0x6d_61_69_6c,
	);
	const smallAttachment = deterministicBytes(
		FIXTURE_LAYOUT.smallAttachmentBytes,
		0x63_61_6e_61,
	);
	const large = wrapBase64(largeAttachment);
	const small = wrapBase64(smallAttachment);
	assert.equal(large.encoded.length, FIXTURE_LAYOUT.largeBase64Bytes);
	assert.equal(
		Buffer.byteLength(large.wrapped, "ascii"),
		FIXTURE_LAYOUT.largeWrappedBytes,
	);

	const prefixBeforePadding = [
		"From: Canary Sender <sender@example.net>\r\n",
		"To: Exact Size Recipient <recipient@wiserchat.ai>\r\n",
		"Subject: Exact size local workerd canary\r\n",
		"Date: Wed, 15 Jul 2026 12:00:00 +0000\r\n",
		"Message-ID: <exact-size-canary@example.net>\r\n",
		"MIME-Version: 1.0\r\n",
	].join("");
	const prefixAfterPadding = [
		`Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n`,
		"\r\n",
		`--${BOUNDARY}\r\n`,
		"Content-Type: text/plain; charset=utf-8\r\n",
		"Content-Transfer-Encoding: 7bit\r\n",
		"\r\n",
		"Local workerd exact-size canary.\r\n",
		`--${BOUNDARY}\r\n`,
		"Content-Type: application/octet-stream; name=large-canary.bin\r\n",
		"Content-Disposition: attachment; filename=large-canary.bin\r\n",
		"Content-Transfer-Encoding: base64\r\n",
		"\r\n",
	].join("");
	const prefixSurrounding = prefixBeforePadding + prefixAfterPadding;
	const prefix =
		prefixBeforePadding +
		paddedHeader(
			"X-Canary-Prefix-Padding",
			FIXTURE_LAYOUT.prefixBytes,
			prefixSurrounding,
		) +
		prefixAfterPadding;

	const tailBeforePadding = [
		`--${BOUNDARY}\r\n`,
		"Content-Type: application/octet-stream; name=small-canary.bin\r\n",
		"Content-Disposition: attachment; filename=small-canary.bin\r\n",
		"Content-Transfer-Encoding: base64\r\n",
	].join("");
	const tailAfterPadding = [
		"\r\n",
		small.wrapped,
		`--${BOUNDARY}--`,
	].join("");
	const tailSurrounding = tailBeforePadding + tailAfterPadding;
	const tail =
		tailBeforePadding +
		paddedHeader(
			"X-Canary-Tail-Padding",
			FIXTURE_LAYOUT.tailBytes,
			tailSurrounding,
		) +
		tailAfterPadding;
	const epilogue = "\r\n\n";

	assert.equal(Buffer.byteLength(prefix, "ascii"), FIXTURE_LAYOUT.prefixBytes);
	assert.equal(Buffer.byteLength(tail, "ascii"), FIXTURE_LAYOUT.tailBytes);
	assert.equal(
		Buffer.byteLength(epilogue, "ascii"),
		FIXTURE_LAYOUT.epilogueBytes,
	);
	const raw = Buffer.from(prefix + large.wrapped + tail + epilogue, "ascii");
	assert.equal(raw.byteLength, FIXTURE_LAYOUT.rawBytes);

	return { largeAttachment, raw, smallAttachment };
}
