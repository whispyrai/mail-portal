import assert from "node:assert/strict";
import test from "node:test";
import {
	automationDryRunTestId,
} from "./automation-dry-run-idempotency.ts";

test("Automation dry-run test IDs are stable and isolated by Mailbox, actor, and operation", async () => {
	const base = {
		mailboxId: "TEAM@EXAMPLE.COM",
		actorId: "user-1",
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
	};
	const first = await automationDryRunTestId(base);
	assert.match(first, /^test_operation_[a-f0-9]{64}$/u);
	assert.equal(first, await automationDryRunTestId({ ...base, mailboxId: "team@example.com" }));
	for (const changed of [
		{ ...base, mailboxId: "other@example.com" },
		{ ...base, actorId: "user-2" },
		{ ...base, operationId: "92e968b7-3120-41a7-b839-f42b77c477bc" },
	]) {
		assert.notEqual(first, await automationDryRunTestId(changed));
	}
});
