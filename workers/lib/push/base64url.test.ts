// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64Url } from "../../../shared/base64url.ts";

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("decodeBase64Url decodes an unpadded Web Push public key", () => {
	const publicKey = Uint8Array.from({ length: 65 }, (_, index) => index);
	assert.deepEqual(decodeBase64Url(encodeBase64Url(publicKey)), publicKey);
});

test("decodeBase64Url rejects malformed input without throwing", () => {
	assert.equal(decodeBase64Url("a"), null, "a length remainder of one cannot be base64url");
	assert.equal(decodeBase64Url("not+base64url"), null, "non-url-safe characters are rejected");
});
