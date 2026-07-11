// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Send one Web Push message to a single endpoint. This is the impure edge of
// the transport (crypto + fetch) — its correctness on the wire is verified on
// real devices (the WISER-240 human step), not in the node unit runner. The
// pure pieces it composes (encryptPayload, buildVapidJwt in ./transport, and
// classifyPushStatus in ./classify) are unit-tested. Never throws.

import { classifyPushStatus } from "./classify";
import { buildVapidJwt, encryptPayload, type VapidConfig } from "./transport";
import type { PushSubscription, SendPushResult } from "./types";

export async function sendWebPush(
	sub: PushSubscription,
	payloadString: string,
	vapid: VapidConfig,
): Promise<SendPushResult> {
	try {
		const audience = new URL(sub.endpoint).origin;
		const [jwt, body] = await Promise.all([
			buildVapidJwt(audience, vapid),
			encryptPayload(payloadString, sub.p256dh, sub.auth),
		]);
		const res = await fetch(sub.endpoint, {
			method: "POST",
			headers: {
				Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				// TTL 0: a late notification is worse than none (time-sensitive mail).
				TTL: "0",
				Urgency: "high",
			},
			body,
		});
		if (res.ok) return { ok: true };
		const { reason, shouldDelete } = classifyPushStatus(res.status);
		return { ok: false, reason, shouldDelete, statusCode: res.status };
	} catch {
		// Network / crypto error: transient, keep the subscription.
		return { ok: false, reason: "SEND_FAILED", shouldDelete: false, statusCode: null };
	}
}
