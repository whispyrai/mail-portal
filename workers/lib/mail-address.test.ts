import assert from "node:assert/strict";
import test from "node:test";
import {
	isAddressInConfiguredMailDomains,
	normalizeMailAddress,
} from "./mail-address.ts";

test("mail addresses must match one configured domain exactly", () => {
	const configuredDomains = "wiserchat.ai, test.wiserchat.ai";

	assert.equal(
		isAddressInConfiguredMailDomains("hesham@wiserchat.ai", configuredDomains),
		true,
	);
	assert.equal(
		isAddressInConfiguredMailDomains("cutover@test.wiserchat.ai", configuredDomains),
		true,
	);
	assert.equal(
		isAddressInConfiguredMailDomains("hesham@other.example", configuredDomains),
		false,
	);
	assert.equal(
		isAddressInConfiguredMailDomains("hesham@wiserchat.ai.attacker.example", configuredDomains),
		false,
	);
	assert.equal(isAddressInConfiguredMailDomains("missing-at-sign", configuredDomains), false);
	assert.equal(isAddressInConfiguredMailDomains("two@@wiserchat.ai", configuredDomains), false);
});

test("mail address normalization is case-insensitive but rejects malformed input", () => {
	assert.equal(normalizeMailAddress("  Hesham@WiserChat.AI "), "hesham@wiserchat.ai");
	assert.equal(normalizeMailAddress("@wiserchat.ai"), null);
	assert.equal(normalizeMailAddress("hesham@"), null);
	assert.equal(normalizeMailAddress("hes ham@wiserchat.ai"), null);
	assert.equal(normalizeMailAddress("hesham@wiser chat.ai"), null);
	assert.equal(normalizeMailAddress("two@@wiserchat.ai"), null);
});
