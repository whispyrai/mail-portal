// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Run: node --experimental-strip-types --test app/utils/pwa/urlBase64ToUint8Array.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { urlBase64ToUint8Array } from "./urlBase64ToUint8Array.ts";

test("decodes an unpadded base64url string to the right bytes", () => {
	// "aGVsbG8" is base64url for "hello" with the trailing "=" stripped.
	assert.deepEqual([...urlBase64ToUint8Array("aGVsbG8")], [104, 101, 108, 108, 111]);
});

test("handles the URL-safe alphabet (- and _)", () => {
	// bytes [251,255] → base64 "+/8=" → base64url "-_8"
	assert.deepEqual([...urlBase64ToUint8Array("-_8")], [251, 255]);
});

test("returns a Uint8Array", () => {
	assert.ok(urlBase64ToUint8Array("aGVsbG8") instanceof Uint8Array);
});
