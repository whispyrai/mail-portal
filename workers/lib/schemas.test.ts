// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { PushSubscriptionSchema } from "./schemas.ts";

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
