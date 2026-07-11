// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Run: node --experimental-strip-types --test workers/lib/push/deviceLabel.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeviceLabel } from "./deviceLabel.ts";

const IPHONE_SAFARI =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const MAC_SAFARI =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const WINDOWS_EDGE =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const IOS_CHROME =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1";
const ANDROID_EDGE =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0";

test("humanises platform + browser", () => {
	assert.equal(buildDeviceLabel(IPHONE_SAFARI), "iPhone (Safari)");
	assert.equal(buildDeviceLabel(ANDROID_CHROME), "Android (Chrome)");
	assert.equal(buildDeviceLabel(MAC_SAFARI), "Mac (Safari)");
	assert.equal(buildDeviceLabel(WINDOWS_EDGE), "Windows (Edge)");
	assert.equal(buildDeviceLabel(ANDROID_EDGE), "Android (Edge)");
});

test("browser precedence: iOS-Chrome (CriOS) is Chrome, not Safari", () => {
	// CriOS UA also contains 'Safari/604.1', so Chrome must win.
	assert.equal(buildDeviceLabel(IOS_CHROME), "iPhone (Chrome)");
});

test("missing UA → 'Unknown device'", () => {
	assert.equal(buildDeviceLabel(null), "Unknown device");
	assert.equal(buildDeviceLabel(undefined), "Unknown device");
	assert.equal(buildDeviceLabel(""), "Unknown device");
});

test("unrecognised UA falls back to generic parts", () => {
	assert.equal(buildDeviceLabel("some-random-agent/1.0"), "Device (Browser)");
});
