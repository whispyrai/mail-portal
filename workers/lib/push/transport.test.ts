// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Transport crypto: VAPID config gating, aes128gcm header framing +
// determinism, and VAPID JWT structure. The AEAD's wire-interop with real
// push services (APNs/FCM/autopush) is the WISER-240 human device step.
// Run: node --experimental-strip-types --test workers/lib/push/transport.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { vapidConfig, encryptPayload, buildVapidJwt } from "./transport.ts";

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeJwtPart(part: string): Record<string, unknown> {
	const pad = "=".repeat((4 - (part.length % 4)) % 4);
	return JSON.parse(atob((part + pad).replace(/-/g, "+").replace(/_/g, "/")));
}

test("vapidConfig returns null unless all three env values are present", () => {
	assert.equal(vapidConfig({} as never), null);
	assert.equal(vapidConfig({ VAPID_SUBJECT: "mailto:a@b.co" } as never), null);
	assert.equal(
		vapidConfig({ VAPID_SUBJECT: "mailto:a@b.co", VAPID_PUBLIC_KEY: "pub" } as never),
		null,
	);
	const cfg = vapidConfig({
		VAPID_SUBJECT: "mailto:a@b.co",
		VAPID_PUBLIC_KEY: "pub",
		VAPID_PRIVATE_KEY: "priv",
	} as never);
	assert.deepEqual(cfg, { subject: "mailto:a@b.co", publicKey: "pub", privateKey: "priv" });
});

test("encryptPayload emits a well-framed aes128gcm body (RFC 8188 header)", async () => {
	// A throwaway receiver keypair + auth secret.
	const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey)));
	const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const plaintext = "hello push";
	const plaintextLen = new TextEncoder().encode(plaintext).length;

	const body = await encryptPayload(plaintext, p256dh, auth, { salt, serverKeys });

	// header = salt(16) | rs(4) | idlen(1) | keyid(65); record = plaintext | 0x02 delimiter | tag(16)
	assert.equal(body.length, 16 + 4 + 1 + 65 + (plaintextLen + 1) + 16);
	assert.deepEqual(body.slice(0, 16), salt, "header starts with the salt");
	assert.deepEqual([...body.slice(16, 20)], [0x00, 0x00, 0x10, 0x00], "record size = 4096, big-endian");
	assert.equal(body[20], 65, "keyid length byte = 65");
	assert.deepEqual(body.slice(21, 86), asPublic, "keyid = server public key");
});

test("encryptPayload is deterministic for fixed salt + server keys", async () => {
	const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey)));
	const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const pt = "same input, same output";

	const a = await encryptPayload(pt, p256dh, auth, { salt, serverKeys });
	const b = await encryptPayload(pt, p256dh, auth, { salt, serverKeys });
	assert.deepEqual(a, b);
});

test("buildVapidJwt signs an ES256 JWT with the endpoint origin as audience", async () => {
	// Generate a VAPID keypair and express it the way `web-push generate-vapid-keys` does:
	// base64url raw public point + base64url private scalar (from the JWK `d`).
	const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
	const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as { d: string };

	const jwt = await buildVapidJwt("https://fcm.googleapis.com", {
		subject: "mailto:team@wiserchat.ai",
		publicKey,
		privateKey: jwk.d,
	});

	const [header, payload] = jwt.split(".");
	assert.equal(decodeJwtPart(header).alg, "ES256");
	const claims = decodeJwtPart(payload);
	assert.equal(claims.aud, "https://fcm.googleapis.com");
	assert.equal(claims.sub, "mailto:team@wiserchat.ai");
	assert.equal(typeof claims.exp, "number");
	assert.ok((claims.exp as number) > Math.floor(Date.now() / 1000), "exp is in the future");
});
