import assert from "node:assert/strict";
import test from "node:test";
import {
	EMAIL_AUTHORIZATION_CANARY_SIZES,
	FIXTURE_LAYOUT,
	buildEmailAuthorizationFixture,
	buildExactSizeFixture,
} from "./email-authorization-canary-fixtures.mjs";

const FIXTURE_ID = "wiser-forward-near-limit-0123456789abcdef";

test("authorization fixtures own the exact 5.1 MiB and near-25 MiB wire sizes", () => {
	for (const rawBytes of Object.values(EMAIL_AUTHORIZATION_CANARY_SIZES)) {
		const fixture = buildEmailAuthorizationFixture({
			from: "canary-sender@wiserchat.ai",
			to: "canary-recipient@wiserchat.ai",
			probeId: FIXTURE_ID,
			rawBytes,
		});
		assert.equal(fixture.raw.byteLength, rawBytes);
		assert.equal(fixture.probeId, FIXTURE_ID);
		assert.equal(fixture.rawBytes, rawBytes);
		const source = fixture.raw.toString("ascii");
		assert.match(source, /^From: canary-sender@wiserchat\.ai\r\n/u);
		assert.match(source, /\r\nTo: canary-recipient@wiserchat\.ai\r\n/u);
		assert.match(source, new RegExp(`\\r\\nX-Canary-Probe-ID: ${FIXTURE_ID}\\r\\n`, "u"));
		assert.ok(
			source.split("\r\n").every((line) => Buffer.byteLength(line, "ascii") <= 998),
		);
	}
});

test("authorization fixture rejects unsafe headers and unsupported sizes", () => {
	const base = {
		from: "canary-sender@wiserchat.ai",
		to: "canary-recipient@wiserchat.ai",
		probeId: FIXTURE_ID,
		rawBytes: EMAIL_AUTHORIZATION_CANARY_SIZES.aboveGeneralLimit,
	};
	assert.throws(
		() => buildEmailAuthorizationFixture({ ...base, from: "sender\r\nBcc: victim@example.com" }),
		/valid ASCII email address/u,
	);
	assert.throws(
		() => buildEmailAuthorizationFixture({ ...base, probeId: "../unsafe" }),
		/valid probe ID/u,
	);
	assert.throws(
		() => buildEmailAuthorizationFixture({ ...base, rawBytes: 100 }),
		/too small/u,
	);
});

test("the local workerd fixture keeps its established exact byte ownership", () => {
	const fixture = buildExactSizeFixture();
	assert.equal(fixture.raw.byteLength, 24_960_359);
	assert.equal(fixture.largeAttachment.byteLength, 18_238_584);
	assert.equal(fixture.smallAttachment.byteLength, 1_024);
	assert.equal(FIXTURE_LAYOUT.rawBytes, fixture.raw.byteLength);
});
