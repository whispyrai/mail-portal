// Account provisioning contract tests: user credentials and mailbox visibility
// must move together for launch-time admin/bootstrap flows.

import assert from "node:assert/strict";
import test from "node:test";
import { provisionAccount } from "./account-provisioning.ts";
import type { CreateUserInput, User } from "./users.ts";

const input = {
	email: "hesham@wiserchat.ai",
	passwordHash: "hash",
	passwordSalt: "salt",
	role: "ADMIN",
	mailboxAddress: "hesham@wiserchat.ai",
	displayName: "Hesham",
} satisfies CreateUserInput & { displayName: string };

function userFrom(input: CreateUserInput): User {
	return {
		id: "usr_test",
		email: input.email,
		password_hash: input.passwordHash,
		password_salt: input.passwordSalt,
		role: input.role,
		is_active: 1,
		mailbox_address: input.mailboxAddress,
		mcp_token_hash: null,
		created_at: 1,
		updated_at: 1,
	};
}

test("provisionAccount rolls back the user when mailbox provisioning fails", async () => {
	const deletedUsers: string[] = [];
	const createInput: CreateUserInput[] = [];

	await assert.rejects(
		() =>
			provisionAccount({} as never, input, {
				async createUser(_env, value) {
					createInput.push(value);
					return userFrom(value);
				},
				async deleteUser(_env, id) {
					deletedUsers.push(id);
				},
				async provisionMailbox() {
					throw new Error("simulated R2 failure");
				},
			}),
		/simulated R2 failure/,
	);

	assert.equal(createInput.length, 1);
	assert.deepEqual(deletedUsers, ["usr_test"]);
});

test("provisionAccount surfaces rollback failure with both causes", async () => {
	const original = new Error("simulated DO failure");
	const rollback = new Error("simulated D1 rollback failure");
	const consoleError = console.error;
	const logs: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		logs.push(args);
	};

	try {
		await assert.rejects(
			() =>
				provisionAccount({} as never, input, {
					async createUser(_env, value) {
						return userFrom(value);
					},
					async deleteUser() {
						throw rollback;
					},
					async provisionMailbox() {
						throw original;
					},
				}),
			(error) =>
				error instanceof Error &&
				error.name === "AccountProvisioningError" &&
				"cause" in error &&
				"rollbackError" in error &&
				error.cause === original &&
				error.rollbackError === rollback,
		);
	} finally {
		console.error = consoleError;
	}
	assert.equal(logs.length, 1);
});
