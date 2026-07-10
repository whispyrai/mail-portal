// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Worker-native Web Push send transport. The Whispyr CRM sends via the Node
// `web-push` package, which does not run on Cloudflare Workers; this
// reimplements the wire format on WebCrypto:
//   - VAPID auth  — an ES256 JWT (RFC 8292), signed with `jose`.
//   - payload     — RFC 8291 `aes128gcm` (ECDH P-256 → HKDF → AES-128-GCM),
//                   via `crypto.subtle`.
// Everything else (status classification, fan-out, pruning, payload shape) is
// shared transport-agnostic code ported verbatim from the CRM.

import { SignJWT, importJWK } from "jose";
import { decodeBase64Url } from "../../../shared/base64url.ts";
import type { Env } from "../../types";

// crypto.subtle's BufferSource wants ArrayBuffer-backed views (not the wider
// ArrayBufferLike). Pin every byte buffer we hand it to this.
type Bytes = Uint8Array<ArrayBuffer>;

export type VapidConfig = {
	/** `mailto:` or `https:` contact, per RFC 8292. */
	subject: string;
	/** Base64url P-256 public key (also handed to the browser to subscribe). */
	publicKey: string;
	/** Base64url P-256 private scalar. Secret. */
	privateKey: string;
};

type VapidEnvironment = Partial<
	Pick<Env, "VAPID_SUBJECT" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY">
>;

function isVapidSubject(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "mailto:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Resolve the VAPID config from env, or null if not fully configured. Push is
 * a bonus channel: a portal env without VAPID keys (e.g. before secrets are
 * set) simply never sends push — it must never break mail receipt.
 */
export function vapidConfig(env: VapidEnvironment): VapidConfig | null {
	const subject = env.VAPID_SUBJECT;
	const publicKey = env.VAPID_PUBLIC_KEY;
	const privateKey = env.VAPID_PRIVATE_KEY;
	if (!subject || !publicKey || !privateKey) return null;
	const publicBytes = decodeBase64Url(publicKey);
	const privateBytes = decodeBase64Url(privateKey);
	if (
		!isVapidSubject(subject) ||
		publicBytes?.byteLength !== 65 ||
		publicBytes[0] !== 0x04 ||
		privateBytes?.byteLength !== 32
	) {
		return null;
	}
	return { subject, publicKey, privateKey };
}

// ── base64url + byte helpers ───────────────────────────────────────

function requiredBase64Url(value: string, label: string): Bytes {
	const bytes = decodeBase64Url(value);
	if (!bytes) throw new TypeError(`${label} must be valid unpadded base64url`);
	return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrays: Uint8Array[]): Bytes {
	const total = arrays.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.length;
	}
	return out;
}

const utf8 = (s: string): Bytes => Uint8Array.from(new TextEncoder().encode(s));

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, lengthBytes: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		lengthBytes * 8,
	);
	return new Uint8Array(bits);
}

// ── RFC 8291 aes128gcm payload encryption ──────────────────────────

type EncryptOptions = {
	/** Injectable for deterministic tests; random 16 bytes in production. */
	salt?: Bytes;
	/** Injectable ECDH keypair for deterministic tests. */
	serverKeys?: CryptoKeyPair;
};

/** aes128gcm content-coding header framing constants (RFC 8188). */
const RECORD_SIZE = 4096;
const KEY_ID_LENGTH = 65; // an uncompressed P-256 point
const MAX_WEB_PUSH_PLAINTEXT_BYTES = 3_993;

/**
 * Encrypt `plaintext` for a subscription's keys, returning the full
 * `aes128gcm` message body (header + single encrypted record).
 */
export async function encryptPayload(
	plaintext: string,
	p256dh: string,
	auth: string,
	opts: EncryptOptions = {},
): Promise<Bytes> {
	const plaintextBytes = utf8(plaintext);
	if (plaintextBytes.byteLength > MAX_WEB_PUSH_PLAINTEXT_BYTES) {
		throw new RangeError(
			`Web Push payload exceeds the ${MAX_WEB_PUSH_PLAINTEXT_BYTES} bytes maximum`,
		);
	}

	const receiverPublic = requiredBase64Url(p256dh, "p256dh");
	const authSecret = requiredBase64Url(auth, "auth");
	const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

	const serverKeys =
		opts.serverKeys ??
		(await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

	const receiverKey = await crypto.subtle.importKey(
		"raw",
		receiverPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, serverKeys.privateKey, 256),
	);

	// IKM = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0"||ua_pub||as_pub)
	const authInfo = concatBytes(utf8("WebPush: info\0"), receiverPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, authInfo, 32);

	// CEK + NONCE derived from the 16-byte salt.
	const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

	const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// Single, last record: append the 0x02 padding delimiter, then seal.
	const record = concatBytes(plaintextBytes, new Uint8Array([0x02]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, record),
	);

	const rs = new Uint8Array([
		(RECORD_SIZE >>> 24) & 0xff,
		(RECORD_SIZE >>> 16) & 0xff,
		(RECORD_SIZE >>> 8) & 0xff,
		RECORD_SIZE & 0xff,
	]);
	const header = concatBytes(salt, rs, new Uint8Array([KEY_ID_LENGTH]), asPublic);
	return concatBytes(header, ciphertext);
}

// ── VAPID JWT (RFC 8292) ───────────────────────────────────────────

/** Build the ES256 VAPID JWT for one push endpoint's origin (audience). */
export async function buildVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
	const pub = requiredBase64Url(vapid.publicKey, "VAPID public key"); // 0x04 || x[32] || y[32]
	const jwk = {
		kty: "EC",
		crv: "P-256",
		d: vapid.privateKey,
		x: bytesToB64url(pub.slice(1, 33)),
		y: bytesToB64url(pub.slice(33, 65)),
	};
	const key = await importJWK(jwk, "ES256");
	return await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", typ: "JWT" })
		.setAudience(audience)
		.setSubject(vapid.subject)
		.setExpirationTime("12h")
		.sign(key);
}
