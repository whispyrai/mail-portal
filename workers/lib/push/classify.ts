// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Map a push-service HTTP status to a failure reason + whether the stored
// subscription is dead and must be pruned. Ported verbatim from the Whispyr
// CRM (`webPushClient.ts` classifyStatusCode) — the send transport differs on
// Workers, but this classification is transport-agnostic. Only 404/410 (the
// push service reporting the endpoint gone: permission revoked, PWA
// uninstalled, or iOS's 7-day inactive-subscription wipe) delete the row.

import type { PushFailureReason } from "./types";

export function classifyPushStatus(statusCode: number | undefined): {
	reason: PushFailureReason;
	shouldDelete: boolean;
} {
	if (statusCode === 404 || statusCode === 410) {
		return { reason: "PERMISSION_REVOKED", shouldDelete: true };
	}
	if (statusCode === 401 || statusCode === 403) {
		return { reason: "CONFIG_ERROR", shouldDelete: false };
	}
	if (statusCode === 413) {
		return { reason: "PAYLOAD_TOO_LARGE", shouldDelete: false };
	}
	if (statusCode === 429) {
		return { reason: "RATE_LIMITED", shouldDelete: false };
	}
	if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
		return { reason: "SERVICE_UNAVAILABLE", shouldDelete: false };
	}
	return { reason: "SEND_FAILED", shouldDelete: false };
}
