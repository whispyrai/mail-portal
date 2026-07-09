// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Humanise a User-Agent into a "{platform} ({browser})" device label for the
// per-device subscription list. Ported from the Whispyr CRM's deviceLabel
// helper (hand-rolled, no ua-parser dep). Derived server-side from the
// request's `user-agent` header, never sent by the client.

/** Order matters: earlier tokens win when a UA contains several (e.g. CriOS also carries "Safari"). */
function browserFromUA(ua: string): string {
	if (/EdgiOS|Edg\//.test(ua)) return "Edge";
	if (/FxiOS|Firefox/.test(ua)) return "Firefox";
	if (/OPR\/|Opera/.test(ua)) return "Opera";
	if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
	if (/CriOS|Chrome/.test(ua)) return "Chrome";
	if (/Safari/.test(ua)) return "Safari";
	return "Browser";
}

function platformFromUA(ua: string): string {
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
	if (/Windows/.test(ua)) return "Windows";
	if (/Linux/.test(ua)) return "Linux";
	return "Device";
}

export function buildDeviceLabel(userAgent: string | null | undefined): string {
	if (!userAgent) return "Unknown device";
	return `${platformFromUA(userAgent)} (${browserFromUA(userAgent)})`;
}
