import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	isPushHealthAccessRevoked,
	pushHealthKey,
} from "../lib/push-health-cache.ts";

const querySource = readFileSync(new URL("./push.ts", import.meta.url), "utf8");

test("push health cache identity is actor-private and Mailbox-purgeable", () => {
	assert.deepEqual(
		pushHealthKey("shared@example.com", "member-a@example.com"),
		["push", "shared@example.com", "health", "member-a@example.com"],
	);
	assert.notDeepEqual(
		pushHealthKey("shared@example.com", "member-a@example.com"),
		pushHealthKey("shared@example.com", "member-b@example.com"),
	);
});

test("a direct health 403 reports the exact revoked Mailbox and never retries", () => {
	assert.equal(isPushHealthAccessRevoked({ status: 403 }), true);
	assert.equal(isPushHealthAccessRevoked({ status: 401 }), false);
	assert.match(querySource, /onAccessRevoked\?\.\(mailboxId\)/);
	assert.match(querySource, /refetchOnWindowFocus: true/);
	assert.match(querySource, /refetchOnReconnect: true/);
	assert.match(querySource, /staleTime: 0/);
	assert.match(querySource, /!isPushHealthAccessRevoked\(error\)/);
});

test("ordinary health failures do not masquerade as access revocation", () => {
	assert.equal(isPushHealthAccessRevoked({ status: 503 }), false);
	assert.equal(isPushHealthAccessRevoked(new Error("offline")), false);
});
