// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Run: node --experimental-strip-types --test app/utils/pwa/detectPlatform.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPwaInstallEnvironmentFromUserAgent as detect } from "./detectPlatform.ts";

const UA = {
	iosSafari:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
	iosChrome:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1",
	androidChrome:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
	androidFirefox:
		"Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0",
	desktopChrome:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	instagramInApp:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0 (iPhone; iOS 17_4)",
	wechatInApp:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.49",
	macDesktop:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

test("iOS Safari is a recommended install browser", () => {
	const e = detect(UA.iosSafari);
	assert.equal(e.platform, "ios");
	assert.equal(e.browser, "safari");
	assert.equal(e.isRecommendedMobileBrowser, true);
});

test("Android Chrome is a recommended install browser", () => {
	const e = detect(UA.androidChrome);
	assert.equal(e.platform, "android");
	assert.equal(e.browser, "chrome");
	assert.equal(e.isRecommendedMobileBrowser, true);
});

test("iOS Chrome (CriOS) is iOS but NOT recommended (only Safari installs on iOS)", () => {
	const e = detect(UA.iosChrome);
	assert.equal(e.platform, "ios");
	assert.equal(e.browser, "chrome");
	assert.equal(e.isRecommendedMobileBrowser, false);
});

test("Android Firefox is android, not recommended", () => {
	const e = detect(UA.androidFirefox);
	assert.equal(e.platform, "android");
	assert.equal(e.browser, "firefox");
	assert.equal(e.isRecommendedMobileBrowser, false);
});

test("desktop Chrome → desktop, not a 'recommended mobile' browser", () => {
	const e = detect(UA.desktopChrome);
	assert.equal(e.platform, "desktop");
	assert.equal(e.browser, "chrome");
	assert.equal(e.isRecommendedMobileBrowser, false);
});

test("in-app browsers (Instagram) are detected and short-circuit", () => {
	const e = detect(UA.instagramInApp);
	assert.equal(e.browser, "in-app");
	assert.equal(e.isRecommendedMobileBrowser, false);
});

test("WeChat is detected as an in-app browser", () => {
	const e = detect(UA.wechatInApp);
	assert.equal(e.browser, "in-app");
	assert.equal(e.isRecommendedMobileBrowser, false);
});

test("iPadOS 13+ masquerades as macOS → treated as iOS via maxTouchPoints", () => {
	assert.equal(detect(UA.macDesktop, 0).platform, "desktop");
	assert.equal(detect(UA.macDesktop, 5).platform, "ios");
});
