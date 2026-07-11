// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Push-service status classification — the load-bearing dead-endpoint rule.
// Run: node --experimental-strip-types --test workers/lib/push/classify.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPushStatus } from "./classify.ts";

test("404/410 → PERMISSION_REVOKED and prune the dead endpoint", () => {
	for (const status of [404, 410]) {
		const r = classifyPushStatus(status);
		assert.equal(r.reason, "PERMISSION_REVOKED", `status ${status}`);
		assert.equal(r.shouldDelete, true, `status ${status} must delete`);
	}
});

test("401/403 → CONFIG_ERROR, keep the endpoint (VAPID bug, not a dead device)", () => {
	for (const status of [401, 403]) {
		const r = classifyPushStatus(status);
		assert.equal(r.reason, "CONFIG_ERROR", `status ${status}`);
		assert.equal(r.shouldDelete, false, `status ${status} must NOT delete`);
	}
});

test("413 → PAYLOAD_TOO_LARGE, keep", () => {
	const r = classifyPushStatus(413);
	assert.equal(r.reason, "PAYLOAD_TOO_LARGE");
	assert.equal(r.shouldDelete, false);
});

test("429 → RATE_LIMITED, keep", () => {
	const r = classifyPushStatus(429);
	assert.equal(r.reason, "RATE_LIMITED");
	assert.equal(r.shouldDelete, false);
});

test("5xx → SERVICE_UNAVAILABLE, keep", () => {
	for (const status of [500, 503, 599]) {
		const r = classifyPushStatus(status);
		assert.equal(r.reason, "SERVICE_UNAVAILABLE", `status ${status}`);
		assert.equal(r.shouldDelete, false, `status ${status}`);
	}
});

test("anything else / undefined → SEND_FAILED, keep (never prune on an unknown status)", () => {
	for (const status of [200, 400, 418, undefined]) {
		const r = classifyPushStatus(status);
		assert.equal(r.reason, "SEND_FAILED", `status ${status}`);
		assert.equal(r.shouldDelete, false, `status ${status} must NOT delete`);
	}
});
