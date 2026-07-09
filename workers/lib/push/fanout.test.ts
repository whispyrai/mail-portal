// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Best-effort fan-out: one payload → every device, prune only dead endpoints,
// never throw. Run:
//   node --experimental-strip-types --test workers/lib/push/fanout.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { fanOutPush } from "./fanout.ts";
import type { PushSubscription, SendPushResult } from "./types";

const sub = (n: string): PushSubscription => ({ endpoint: `https://push/${n}`, p256dh: "k", auth: "a" });
const ok: SendPushResult = { ok: true };
const gone: SendPushResult = { ok: false, reason: "PERMISSION_REVOKED", shouldDelete: true, statusCode: 410 };
const flaky: SendPushResult = { ok: false, reason: "SERVICE_UNAVAILABLE", shouldDelete: false, statusCode: 503 };

test("all deliver → nothing pruned", async () => {
	const r = await fanOutPush([sub("a"), sub("b")], "{}", async () => ok);
	assert.equal(r.delivered, 2);
	assert.equal(r.attempted, 2);
	assert.deepEqual(r.deadEndpoints, []);
});

test("only 404/410 endpoints are collected for pruning; transient failures are kept", async () => {
	const results: Record<string, SendPushResult> = {
		"https://push/a": ok,
		"https://push/b": gone,
		"https://push/c": flaky,
	};
	const r = await fanOutPush([sub("a"), sub("b"), sub("c")], "{}", async (s) => results[s.endpoint]);
	assert.equal(r.delivered, 1);
	assert.equal(r.attempted, 3);
	assert.deepEqual(r.deadEndpoints, ["https://push/b"]);
	assert.deepEqual(r.deliveredEndpoints, ["https://push/a"]);
});

test("a thrown send is swallowed — counted as failed, never pruned, never rethrown", async () => {
	const r = await fanOutPush([sub("a"), sub("b")], "{}", async (s) => {
		if (s.endpoint.endsWith("b")) throw new Error("network down");
		return ok;
	});
	assert.equal(r.delivered, 1);
	assert.equal(r.attempted, 2);
	assert.deepEqual(r.deadEndpoints, []); // a throw is not proof the endpoint is dead
});

test("no subscriptions → no-op result, no send calls", async () => {
	let calls = 0;
	const r = await fanOutPush([], "{}", async () => {
		calls++;
		return ok;
	});
	assert.equal(calls, 0);
	assert.deepEqual(r, { delivered: 0, attempted: 0, deadEndpoints: [], deliveredEndpoints: [] });
});
