import assert from "node:assert/strict";
import test from "node:test";
import { isValidRecipientAddress } from "../../shared/recipient-addresses.ts";
import { SendEmailRequestSchema } from "./schemas.ts";

/** Whether the send API accepts this exact address as a recipient. */
function apiAccepts(address: string): boolean {
	return SendEmailRequestSchema.safeParse({
		to: address,
		from: "team@example.com",
		subject: "Parity",
		html: "<p>Parity</p>",
		idempotency_key: "parity-check-key",
	}).success;
}

test("the composer flags exactly the addresses the send API rejects", () => {
	const inputs = [
		"a@x.co",
		"first.last+tag@sub.example.com",
		"o'neil@example.ie",
		"A@X.COM",
		"a_b@x.io",
		"a@x-y.com",
		"a@x.museum",
		"bob",
		"a@x",
		"a@x.c",
		"a@@x.com",
		".a@x.com",
		"a..b@x.com",
		"a@x.com.",
		"a@-x.com",
		"a b@x.com",
		"a@x.com ",
		'"q"@x.com',
		"ünï@x.com",
		"user@[1.2.3.4]",
	];
	assert.equal(apiAccepts("a@x.co"), true, "the request shape itself is valid");
	for (const input of inputs) {
		assert.equal(isValidRecipientAddress(input), apiAccepts(input), input);
	}
});
