import assert from "node:assert/strict";
import test from "node:test";
import { mutationOriginDecision } from "./request-security.ts";

test("cookie-backed mutations accept only the portal's own origin", () => {
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/api/v1/mailboxes", {
				method: "POST",
				headers: { Origin: "https://mail.wiserchat.ai" },
			}),
		),
		"allow",
	);
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/api/v1/mailboxes", {
				method: "POST",
				headers: { Origin: "https://attacker.example" },
			}),
		),
		"forbid",
	);
});

test("cookie-backed mutations fail closed when browser origin evidence is absent or opaque", () => {
	for (const headers of [
		{},
		{ Origin: "null" },
		{ "Sec-Fetch-Site": "cross-site" },
	]) {
		assert.equal(
			mutationOriginDecision(
				new Request("https://mail.wiserchat.ai/logout", {
					method: "POST",
					headers,
				}),
			),
			"forbid",
		);
	}
});

test("safe reads and the separately authenticated SES webhook bypass browser-origin enforcement", () => {
	assert.equal(
		mutationOriginDecision(new Request("https://mail.wiserchat.ai/")),
		"allow",
	);
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/webhooks/ses", {
				method: "POST",
			}),
		),
		"allow",
	);
});
