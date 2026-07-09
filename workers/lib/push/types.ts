// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared web-push types. The portal mirrors the Whispyr CRM push stack
// (per-device subscriptions, best-effort fan-out, dead-endpoint cleanup) but
// swaps the send transport for the Worker runtime — see ./transport.ts.

/** A stored per-device push subscription (one row in the mailbox DO). */
export interface PushSubscription {
	/** Opaque URL minted by the browser's push service — globally unique. */
	endpoint: string;
	/** ECDH public key (base64url) for aes128gcm payload encryption. */
	p256dh: string;
	/** Auth secret (base64url) for the same. */
	auth: string;
}

/** The JSON payload the service worker receives and renders (see public/sw.js). */
export interface PushPayload {
	title: string;
	body: string;
	icon: string;
	badge: string;
	clickUrl: string;
	data: { emailId: string; mailboxId: string };
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
