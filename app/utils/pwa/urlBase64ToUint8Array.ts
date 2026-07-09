// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Convert the base64url VAPID public key into the Uint8Array that
// PushManager.subscribe() expects as `applicationServerKey`. Ported from the
// Whispyr CRM.

// Return the concrete ArrayBuffer-backed variant so it satisfies
// PushManager.subscribe()'s applicationServerKey (BufferSource) under TS 5.7.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; i++) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}
