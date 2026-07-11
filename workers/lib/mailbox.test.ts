// Mailbox provisioning contract tests. R2 settings are the inbound visibility
// marker, so they must not be written before the Durable Object is initialized.

import assert from "node:assert/strict";
import test from "node:test";
import { provisionMailbox } from "./mailbox.ts";

function envWith(init: {
	existingSettings?: boolean;
	failFolders?: boolean;
	writes?: string[];
}) {
	const writes = init.writes ?? [];
	return {
		BRAND: "wiser",
		BUCKET: {
			async head() {
				return init.existingSettings ? {} : null;
			},
			async put(key: string, value: string) {
				writes.push(`${key}:${value}`);
			},
		},
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get(value: string) {
				assert.equal(value, "hesham@wiserchat.ai");
				return {
					async getFolders() {
						if (init.failFolders) throw new Error("simulated DO failure");
						return [];
					},
				};
			},
		},
	};
}

test("provisionMailbox does not make a new mailbox visible when DO initialization fails", async () => {
	const writes: string[] = [];

	await assert.rejects(
		() =>
			provisionMailbox(
				envWith({ failFolders: true, writes }) as never,
				"hesham@wiserchat.ai",
				"Hesham",
			),
		/simulated DO failure/,
	);

	assert.deepEqual(writes, []);
});

test("provisionMailbox writes settings after DO initialization succeeds", async () => {
	const writes: string[] = [];

	await provisionMailbox(
		envWith({ writes }) as never,
		"hesham@wiserchat.ai",
		"Hesham",
		{ agentSystemPrompt: "Wiser prompt" },
	);

	assert.equal(writes.length, 1);
	assert.match(writes[0] ?? "", /^mailboxes\/hesham@wiserchat\.ai\.json:/);
	assert.match(writes[0] ?? "", /"fromName":"Hesham"/);
	assert.match(writes[0] ?? "", /"agentSystemPrompt":"Wiser prompt"/);
});
