// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Platform / browser detection for the PWA install UX. Ported from the Whispyr
// CRM. The install + push story is platform-gated by real constraints: iOS
// only installs (and only then can subscribe) from Safari via Add to Home
// Screen; Android installs from Chrome. In-app browsers (Instagram, etc.)
// can't install at all and are detected up front.

type Platform = "ios" | "android" | "desktop" | "unknown";
type Browser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "in-app" | "other";

export type PwaInstallEnvironment = {
	platform: Platform;
	browser: Browser;
	/** iOS needs Safari and Android needs Chrome to install + subscribe. */
	isRecommendedMobileBrowser: boolean;
};

function isInAppBrowser(ua: string): boolean {
	return /FBAN|FBAV|Instagram|Line\/|WhatsApp|MicroMessenger|wv\)/.test(ua);
}

function platformFromUserAgent(ua: string, maxTouchPoints: number): Platform {
	if (/iPhone|iPad|iPod/.test(ua)) return "ios";
	// iPadOS 13+ reports a desktop macOS UA; a touch-capable "Mac" is really an iPad.
	if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "ios";
	if (/Android/.test(ua)) return "android";
	return "desktop";
}

function browserFromUserAgent(ua: string, platform: Platform): Browser {
	if (isInAppBrowser(ua)) return "in-app";
	if (platform === "ios") {
		if (/CriOS/.test(ua)) return "chrome";
		if (/FxiOS/.test(ua)) return "firefox";
		if (/EdgiOS/.test(ua)) return "edge";
		if (/Safari/.test(ua)) return "safari";
		return "other";
	}
	if (platform === "android") {
		if (/SamsungBrowser/.test(ua)) return "samsung";
		if (/EdgA/.test(ua)) return "edge";
		if (/Firefox/.test(ua)) return "firefox";
		if (/Chrome/.test(ua)) return "chrome";
		return "other";
	}
	if (/Edg\//.test(ua)) return "edge";
	if (/Firefox\//.test(ua)) return "firefox";
	if (/Chrome\//.test(ua)) return "chrome";
	if (/Safari\//.test(ua)) return "safari";
	return "other";
}

export function detectPwaInstallEnvironmentFromUserAgent(
	ua: string,
	maxTouchPoints = 0,
): PwaInstallEnvironment {
	const platform = platformFromUserAgent(ua, maxTouchPoints);
	const browser = browserFromUserAgent(ua, platform);
	return {
		platform,
		browser,
		isRecommendedMobileBrowser:
			(platform === "ios" && browser === "safari") ||
			(platform === "android" && browser === "chrome"),
	};
}

export function detectPwaInstallEnvironment(): PwaInstallEnvironment {
	if (typeof navigator === "undefined") {
		return { platform: "unknown", browser: "other", isRecommendedMobileBrowser: false };
	}
	return detectPwaInstallEnvironmentFromUserAgent(navigator.userAgent, navigator.maxTouchPoints);
}
