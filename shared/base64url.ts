// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Decode unpadded base64url input. Invalid data returns null instead of throwing. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;

	try {
		const padding = "=".repeat((4 - (value.length % 4)) % 4);
		const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
}
