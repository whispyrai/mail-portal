// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AttachmentRefSchema,
	PushSubscriptionSchema,
	SendEmailRequestSchema,
} from "./schemas.ts";

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const validPublicKey = Uint8Array.from({ length: 65 }, (_, index) =>
	index === 0 ? 0x04 : index,
);
const validAuthSecret = Uint8Array.from({ length: 16 }, (_, index) => index);

function subscription(p256dh: string, auth: string) {
	return {
		endpoint: "https://push.example.test/subscription",
		keys: { p256dh, auth },
	};
}

test("PushSubscriptionSchema accepts Web Push keys with their required byte shapes", () => {
	const result = PushSubscriptionSchema.safeParse(
		subscription(encodeBase64Url(validPublicKey), encodeBase64Url(validAuthSecret)),
	);
	assert.equal(result.success, true);
});

test("PushSubscriptionSchema rejects malformed or incorrectly sized keys", () => {
	const cases = [
		{
			...subscription(encodeBase64Url(validPublicKey), encodeBase64Url(validAuthSecret)),
			endpoint: "http://push.example.test/subscription",
		},
		subscription("not+base64url", encodeBase64Url(validAuthSecret)),
		subscription(encodeBase64Url(validPublicKey.slice(0, 64)), encodeBase64Url(validAuthSecret)),
		subscription(
			encodeBase64Url(Uint8Array.from(validPublicKey, (byte, index) => (index === 0 ? 0x03 : byte))),
			encodeBase64Url(validAuthSecret),
		),
		subscription(encodeBase64Url(validPublicKey), encodeBase64Url(validAuthSecret.slice(0, 15))),
	];

	for (const candidate of cases) {
		assert.equal(PushSubscriptionSchema.safeParse(candidate).success, false);
	}
});

test("browser send requests require a stable idempotency key", () => {
	const base = {
		to: "person@example.com",
		from: "team@example.com",
		subject: "Hello",
		text: "Hello",
	};

	assert.equal(SendEmailRequestSchema.safeParse(base).success, false);
	assert.equal(
		SendEmailRequestSchema.safeParse({
			...base,
			idempotency_key: "logical-send-1",
		}).success,
		true,
	);
});

test("draft-backed sends require the captured draft version", () => {
	const base = {
		to: "person@example.com",
		from: "team@example.com",
		subject: "Hello",
		text: "Hello",
		idempotency_key: "logical-send-1",
	};

	assert.equal(
		SendEmailRequestSchema.safeParse({
			...base,
			source_draft_id: "draft-1",
		}).success,
		false,
	);
	assert.equal(
		SendEmailRequestSchema.safeParse({
			...base,
			source_draft_id: "draft-1",
			source_draft_version: 3,
		}).success,
		true,
	);
});

test("send requests enforce the provider aggregate recipient limit", () => {
	const base = {
		from: "team@example.com",
		subject: "Hello",
		text: "Hello",
		idempotency_key: "logical-send-1",
	};
	const addresses = Array.from(
		{ length: 51 },
		(_, index) => `person-${index + 1}@example.com`,
	);
	assert.equal(
		SendEmailRequestSchema.safeParse({
			...base,
			to: addresses.slice(0, 25),
			cc: addresses.slice(25, 40),
			bcc: addresses.slice(40, 50),
		}).success,
		true,
	);
	assert.equal(
		SendEmailRequestSchema.safeParse({
			...base,
			to: addresses.slice(0, 25),
			cc: addresses.slice(25, 40),
			bcc: addresses.slice(40),
		}).success,
		false,
	);
});

test("fresh upload references require Content-ID exactly for inline disposition", () => {
	assert.deepEqual(
		AttachmentRefSchema.parse({
			kind: "upload",
			uploadId: "upload-inline-1",
			disposition: "inline",
			contentId: "image-1@mail-portal.local",
		}),
		{
			kind: "upload",
			uploadId: "upload-inline-1",
			disposition: "inline",
			contentId: "image-1@mail-portal.local",
		},
	);
	assert.equal(
		AttachmentRefSchema.safeParse({
			kind: "upload",
			uploadId: "upload-inline-2",
			disposition: "inline",
		}).success,
		false,
	);
	assert.equal(
		AttachmentRefSchema.safeParse({
			kind: "upload",
			uploadId: "upload-ordinary-1",
			disposition: "attachment",
			contentId: "must-not-be-used@mail-portal.local",
		}).success,
		false,
	);
});

test("Content-ID validation rejects header injection and enforces the 255-byte boundary", () => {
	const validAtBoundary = `${"a".repeat(243)}@example.com`;
	assert.equal(new TextEncoder().encode(validAtBoundary).byteLength, 255);
	assert.equal(
		AttachmentRefSchema.safeParse({
			kind: "upload",
			uploadId: "upload-boundary",
			disposition: "inline",
			contentId: validAtBoundary,
		}).success,
		true,
	);

	const invalidContentIds = [
		`${"a".repeat(244)}@example.com`,
		"image@example.com\r\nBcc: victim@example.com",
		"image\u0000@example.com",
		"image @example.com",
		"<image@example.com>",
		"imáge@example.com",
		"image",
		"image@@example.com",
		"image@-example.com",
		"image@example..com",
	];
	for (const contentId of invalidContentIds) {
		assert.equal(
			AttachmentRefSchema.safeParse({
				kind: "upload",
				uploadId: "upload-invalid",
				disposition: "inline",
				contentId,
			}).success,
			false,
			contentId,
		);
	}
});

test("existing references reject client Content-ID overrides", () => {
	assert.equal(
		AttachmentRefSchema.safeParse({
			kind: "existing",
			emailId: "draft-1",
			attachmentId: "inline-1",
			contentId: "attacker-controlled@example.com",
		}).success,
		false,
	);
});

test("attachment reference variants reject unknown and mixed discriminant fields", () => {
	for (const input of [
		{
			kind: "upload",
			uploadId: "upload-1",
			emailId: "draft-1",
			attachmentId: "stored-1",
		},
		{
			kind: "existing",
			emailId: "draft-1",
			attachmentId: "stored-1",
			uploadId: "upload-1",
		},
		{
			kind: "upload",
			uploadId: "upload-1",
			unexpected: "must not be stripped",
		},
	]) {
		const result = AttachmentRefSchema.safeParse(input);
		assert.equal(result.success, false, JSON.stringify(input));
		if (!result.success) {
			assert.equal(
				result.error.issues.some((issue) => issue.code === "unrecognized_keys"),
				true,
			);
		}
	}
});
