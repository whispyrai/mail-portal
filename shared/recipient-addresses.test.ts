import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { isValidRecipientAddress } from "./recipient-addresses.ts";

test("the composer's address check agrees with the send API's zod check", () => {
	const api = z.string().email();
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
	for (const input of inputs) {
		assert.equal(
			isValidRecipientAddress(input),
			api.safeParse(input).success,
			input,
		);
	}
});
