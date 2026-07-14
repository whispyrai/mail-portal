import assert from "node:assert/strict";
import test from "node:test";
import { createAgentConnectionRevoker } from "./agent-connection-revocation.ts";

function fixture(input: { failMailbox?: string } = {}) {
	const calls: string[] = [];
	const revoker = createAgentConnectionRevoker({
		async getAgent(mailboxId) {
			return {
				async reconcileActor(userId) {
					calls.push(`reconcile:${mailboxId}:${userId}`);
					if (mailboxId === input.failMailbox) throw new Error("RPC unavailable");
				},
				async reconcileMailbox() {
					calls.push(`all:${mailboxId}`);
					if (mailboxId === input.failMailbox) throw new Error("RPC unavailable");
				},
			};
		},
	});
	return { calls, revoker };
}

test("Agent connection revocation normalizes and targets exact mailboxes", async () => {
	const { calls, revoker } = fixture();
	await revoker.reconcileActor("Team@Example.com", "user-1");
	await revoker.reconcileMailbox("Team@Example.com");
	assert.deepEqual(calls, [
		"reconcile:team@example.com:user-1",
		"all:team@example.com",
	]);
});

test("Agent connection reconciliation surfaces private RPC failures", async () => {
	const { calls, revoker } = fixture({ failMailbox: "one@example.com" });
	await assert.rejects(
		() => revoker.reconcileActor("one@example.com", "user-1"),
		/RPC unavailable/,
	);
	assert.deepEqual(calls, ["reconcile:one@example.com:user-1"]);
});
