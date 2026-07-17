// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { provisionMailbox } from "./mailbox.ts";
import { createUser, deleteUser, type CreateUserInput, type User } from "./users.ts";
import type { Env } from "../types.ts";

function accountProvisioningError(message: string, cause: unknown, rollbackError: unknown) {
	const error = new Error(message);
	error.name = "AccountProvisioningError";
	return Object.assign(error, { cause, rollbackError });
}

type ProvisioningOps = {
	createUser: (env: Env, input: CreateUserInput) => Promise<User>;
	deleteUser: (env: Env, id: string) => Promise<void>;
	provisionMailbox: (
		env: Env,
		email: string,
		name: string,
		settings?: Record<string, unknown>,
	) => Promise<void>;
};

const defaultOps: ProvisioningOps = {
	createUser,
	deleteUser,
	provisionMailbox,
};

export type ProvisionAccountInput = CreateUserInput & {
	displayName: string;
	mailboxSettings?: Record<string, unknown>;
};

export async function provisionAccount(
	env: Env,
	input: ProvisionAccountInput,
	ops: ProvisioningOps = defaultOps,
): Promise<User> {
	let user: User | undefined;
	try {
		user = await ops.createUser(env, input);
		await ops.provisionMailbox(env, input.mailboxAddress, input.displayName, input.mailboxSettings);
		return user;
	} catch (error) {
		if (user) {
			try {
				await ops.deleteUser(env, user.id);
			} catch (rollbackError) {
				console.error("[account-provisioning] failed to roll back user after mailbox provisioning failure", {
					userId: user.id,
					errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
				});
				throw accountProvisioningError(
					"User was created but mailbox provisioning and rollback both failed",
					error,
					rollbackError,
				);
			}
		}
		throw error;
	}
}
