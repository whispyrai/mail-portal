// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Hand-rolled email + password auth for the sales mail portal (locked-decisions
// D-20..D-25): PBKDF2-SHA256 password hashing via Web Crypto, signed JWT session
// cookies via jose, and helpers for the per-user MCP bearer token.
//
// No auth library by design: ~5 internal users, no social login / magic links /
// password-reset email flows. Better Auth is the documented upgrade path.

import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "../db/users-schema";

// ── base64 helpers ─────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ── Password hashing (keyed HMAC-SHA256 with a server-held pepper) ──
//
// Workers Free has a hard 10ms CPU limit per request that is NOT configurable, so
// a proper slow KDF (PBKDF2 at OWASP iteration counts is ~100ms+ of CPU) blows it
// and the isolate is killed → 500. On Free we use a keyed hash instead: HMAC-
// SHA256 over (salt || password) with a server-held pepper (JWT_SECRET, never
// stored in the DB). Fast (<1ms), and a database dump alone cannot brute-force it
// without also stealing the Worker secret — an appropriate posture for ~5 internal
// users with admin-set strong passwords. For a true slow KDF, move to Workers Paid
// and raise limits.cpu_ms. See locked-decisions D-21 + the 2026-05-29 build log.

const SALT_BYTES = 16;

async function hmacSha256(pepper: string, message: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pepper),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return new Uint8Array(sig);
}

/**
 * Hash a password as HMAC-SHA256(pepper, "salt:password"). Generates a random
 * salt unless one is supplied (pass the stored salt when verifying). `pepper` is
 * the server secret (JWT_SECRET). Returns base64 hash + salt.
 */
export async function hashPassword(
	password: string,
	pepper: string,
	existingSaltB64?: string,
): Promise<{ hash: string; salt: string }> {
	const salt = existingSaltB64
		? base64ToBytes(existingSaltB64)
		: crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const saltB64 = bytesToBase64(salt);
	const digest = await hmacSha256(pepper, `${saltB64}:${password}`);
	return { hash: bytesToBase64(digest), salt: saltB64 };
}

/** Constant-time string comparison (equal length assumed for hashes). */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

/** Verify a password against a stored salt + hash, using the server pepper. */
export async function verifyPassword(
	password: string,
	saltB64: string,
	expectedHashB64: string,
	pepper: string,
): Promise<boolean> {
	const { hash } = await hashPassword(password, pepper, saltB64);
	return timingSafeEqual(hash, expectedHashB64);
}

// ── Session JWT (HS256 via jose) ───────────────────────────────────

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (D-24)
const SESSION_RENEW_THRESHOLD_SECONDS = 24 * 60 * 60; // sliding renewal under 1 day left

export interface SessionClaims {
	sub: string; // user id
	email: string;
	role: UserRole;
	mailbox: string; // mailbox_address this session may act as
}

export async function signSession(
	claims: SessionClaims,
	secret: string,
): Promise<string> {
	const key = new TextEncoder().encode(secret);
	return new SignJWT({
		email: claims.email,
		role: claims.role,
		mailbox: claims.mailbox,
	})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(claims.sub)
		.setIssuedAt()
		.setExpirationTime(`${SESSION_TTL_SECONDS}s`)
		.sign(key);
}

/** Verify a session JWT. Returns the claims, or null if invalid/expired. */
export async function verifySession(
	token: string,
	secret: string,
): Promise<(SessionClaims & { exp: number }) | null> {
	try {
		const key = new TextEncoder().encode(secret);
		const { payload } = await jwtVerify(token, key);
		if (
			typeof payload.sub !== "string" ||
			typeof payload.email !== "string" ||
			typeof payload.role !== "string" ||
			typeof payload.mailbox !== "string"
		) {
			return null;
		}
		return {
			sub: payload.sub,
			email: payload.email,
			role: payload.role as UserRole,
			mailbox: payload.mailbox,
			exp: typeof payload.exp === "number" ? payload.exp : 0,
		};
	} catch {
		return null;
	}
}

/** True when a still-valid session is within the sliding-renewal window. */
export function shouldRenewSession(exp: number, nowSeconds: number): boolean {
	return exp - nowSeconds < SESSION_RENEW_THRESHOLD_SECONDS;
}

// ── Session cookie ─────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "session";

export function buildSessionCookie(
	jwt: string,
	opts: { secure: boolean; domain?: string; maxAge?: number },
): string {
	const parts = [
		`${SESSION_COOKIE_NAME}=${jwt}`,
		"HttpOnly",
		"SameSite=Strict",
		"Path=/",
		`Max-Age=${opts.maxAge ?? SESSION_TTL_SECONDS}`,
	];
	if (opts.secure) parts.push("Secure");
	if (opts.domain) parts.push(`Domain=${opts.domain}`);
	return parts.join("; ");
}

export function clearSessionCookie(opts: {
	secure: boolean;
	domain?: string;
}): string {
	const parts = [
		`${SESSION_COOKIE_NAME}=`,
		"HttpOnly",
		"SameSite=Strict",
		"Path=/",
		"Max-Age=0",
	];
	if (opts.secure) parts.push("Secure");
	if (opts.domain) parts.push(`Domain=${opts.domain}`);
	return parts.join("; ");
}

export function readCookie(
	cookieHeader: string | null | undefined,
	name: string,
): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
	}
	return null;
}

// ── MCP bearer token ───────────────────────────────────────────────

/** Generate a high-entropy, URL-safe MCP token (shown once to the user). */
export function generateMcpToken(): string {
	return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 hash of a token, base64, for storage and lookup. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return bytesToBase64(new Uint8Array(digest));
}

/** Extract a bearer token from an Authorization header. */
export function readBearerToken(authHeader: string | null | undefined): string | null {
	if (!authHeader) return null;
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : null;
}

// ── OAuth authorize transaction (consent CSRF + tamper protection) ──

/**
 * Sign the parsed OAuth authorize request into a short-lived JWT carried through
 * the consent screen as a hidden field. Verified on POST /authorize so the
 * request parameters cannot be tampered with, and — together with the
 * SameSite=Strict session cookie that a cross-site attacker cannot send —
 * protects the consent POST against CSRF.
 */
export async function signAuthTxn(
	req: unknown,
	secret: string,
): Promise<string> {
	const key = new TextEncoder().encode(secret);
	return new SignJWT({ req: req as Record<string, unknown> })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime("10m")
		.sign(key);
}

/** Verify an authorize-transaction JWT; returns the embedded request or null. */
export async function verifyAuthTxn<T = unknown>(
	txn: string,
	secret: string,
): Promise<T | null> {
	try {
		const key = new TextEncoder().encode(secret);
		const { payload } = await jwtVerify(txn, key);
		return (payload.req as T) ?? null;
	} catch {
		return null;
	}
}

/**
 * Validate a post-login redirect target. Only honors a root-relative path to the
 * OAuth authorize endpoint, so a malicious `returnTo` can't turn login into an
 * open redirect.
 */
export function safeAuthorizeReturnTo(
	raw: string | null | undefined,
): string | null {
	if (!raw) return null;
	if (!raw.startsWith("/") || raw.startsWith("//")) return null; // not protocol-relative
	const path = raw.split("?")[0];
	return path === "/authorize" ? raw : null;
}

// ── Cookie scope ───────────────────────────────────────────────────

/**
 * Derive the cookie Domain so a session spans the apex and `mail.` subdomain in
 * production (Domain=whispyrcrm.com). Returns undefined for localhost / IPs (dev)
 * so the cookie is host-only. `domainsVar` is the wrangler DOMAINS value.
 */
export function cookieDomainFor(
	host: string,
	domainsVar: string | undefined,
): string | undefined {
	const root = (domainsVar || "").split(",")[0]?.trim();
	if (!root) return undefined;
	const h = host.split(":")[0];
	if (h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;
	if (h === root || h.endsWith(`.${root}`)) return root;
	return undefined;
}
