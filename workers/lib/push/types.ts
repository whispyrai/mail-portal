// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared web-push types. The portal mirrors the Whispyr CRM push stack
// (per-device subscriptions, best-effort fan-out, dead-endpoint cleanup) but
// swaps the send transport for the Worker runtime — see ./transport.ts.

/** A stored per-device push subscription (one row in the mailbox DO). */
export type PushSubscription = {
	/** Opaque URL minted by the browser's push service — globally unique. */
	endpoint: string;
	/** ECDH public key (base64url) for aes128gcm payload encryption. */
	p256dh: string;
	/** Auth secret (base64url) for the same. */
	auth: string;
};

/** The JSON payload the service worker receives and renders (see public/sw.js). */
export type PushPayload = {
	title: string;
	body: string;
	icon: string;
	badge: string;
	clickUrl: string;
	data: { emailId: string; mailboxId: string };
};

const PUSH_PAYLOAD_KEYS = ["title", "body", "icon", "badge", "clickUrl", "data"];
const UNSAFE_PUSH_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function safeText(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
		value.trim() === value && value.normalize("NFC") === value && !UNSAFE_PUSH_TEXT.test(value);
}

function safeAssetPath(value: unknown): value is string {
	return safeText(value, 2, 200) && /^\/(?!\/)[A-Za-z0-9._/-]+$/.test(value) &&
		!value.includes("\\") && !value.split("/").includes("..");
}

export function validateStoredPushPayload(
	value: unknown,
	input: { emailId: string; mailboxId: string },
): PushPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Push payload is invalid");
	}
	const payload = value as Record<string, unknown>;
	if (Object.keys(payload).sort().join(",") !== [...PUSH_PAYLOAD_KEYS].sort().join(",")) {
		throw new Error("Push payload is invalid");
	}
	if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
		throw new Error("Push payload is invalid");
	}
	const data = payload.data as Record<string, unknown>;
	if (Object.keys(data).sort().join(",") !== "emailId,mailboxId") {
		throw new Error("Push payload is invalid");
	}
	const mailboxId = input.mailboxId.trim().toLowerCase();
	const expectedClick = `/mailbox/${encodeURIComponent(mailboxId)}/open/${encodeURIComponent(input.emailId)}`;
	if (
		data.emailId !== input.emailId ||
		data.mailboxId !== mailboxId ||
		!safeText(payload.title, 1, 120) ||
		!safeText(payload.body, 1, 400) ||
		!safeAssetPath(payload.icon) ||
		!safeAssetPath(payload.badge) ||
		payload.clickUrl !== expectedClick
	) throw new Error("Push payload is invalid");
	const encoded = JSON.stringify(payload);
	if (new TextEncoder().encode(encoded).byteLength > 3_993) {
		throw new Error("Push payload is invalid");
	}
	return payload as PushPayload;
}

/**
 * Why a single-endpoint send failed. Mirrors the CRM's
 * `PushNotificationFailureReason` so the classification table ports verbatim.
 */
export type PushFailureReason =
	| "PERMISSION_REVOKED"
	| "CONFIG_ERROR"
	| "PAYLOAD_TOO_LARGE"
	| "RATE_LIMITED"
	| "SERVICE_UNAVAILABLE"
	| "SEND_FAILED";

/** Result of sending to one endpoint. Never thrown — always returned. */
export type SendPushResult =
	| { ok: true }
	| { ok: false; reason: PushFailureReason; shouldDelete: boolean; statusCode: number | null };
