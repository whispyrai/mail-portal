// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Best-effort fan-out of one push payload to every device row for a mailbox.
// Mirrors the CRM's firePushNotification: serialize once, Promise.all, collect
// the endpoints the push service reported gone (404/410) for pruning, and the
// delivered ones for a lastSeenAt touch. Never throws — a failed or thrown
// send is one device's problem, not the dispatch's; the caller keeps storing
// mail regardless.

import type { PushSubscription, SendPushResult } from "./types";

export interface FanOutResult {
	delivered: number;
	attempted: number;
	deadEndpoints: string[];
	deliveredEndpoints: string[];
}

export type SendFn = (sub: PushSubscription, payload: string) => Promise<SendPushResult>;

export async function fanOutPush(
	subs: PushSubscription[],
	payloadString: string,
	send: SendFn,
): Promise<FanOutResult> {
	const settled = await Promise.all(
		subs.map(async (sub): Promise<{ endpoint: string; result: SendPushResult }> => {
			try {
				return { endpoint: sub.endpoint, result: await send(sub, payloadString) };
			} catch {
				// A thrown send (network error, etc.) is not proof the endpoint is
				// dead — count it as a transient failure and keep the row.
				return {
					endpoint: sub.endpoint,
					result: { ok: false, reason: "SEND_FAILED", shouldDelete: false, statusCode: null },
				};
			}
		}),
	);

	const deliveredEndpoints = settled.filter((r) => r.result.ok).map((r) => r.endpoint);
	const deadEndpoints = settled
		.filter((r) => !r.result.ok && r.result.shouldDelete)
		.map((r) => r.endpoint);

	return {
		delivered: deliveredEndpoints.length,
		attempted: settled.length,
		deadEndpoints,
		deliveredEndpoints,
	};
}
