// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Data access for the global users table (D1, binding `DB`). The DB layer throws;
// callers (route handlers) translate failures into user-facing responses.

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/users-schema";
import type { UserRole, UserRow } from "../db/users-schema";
import type { Env } from "../types";

export type User = UserRow;

function db(env: Env) {
	return drizzle(env.DB, { schema });
}

export async function getUserByEmail(
	env: Env,
	email: string,
): Promise<User | undefined> {
	return db(env)
		.select()
		.from(schema.users)
		.where(eq(schema.users.email, email.toLowerCase()))
		.get();
}

export async function getUserById(
	env: Env,
	id: string,
): Promise<User | undefined> {
	return db(env).select().from(schema.users).where(eq(schema.users.id, id)).get();
}

export async function getUserByMcpTokenHash(
	env: Env,
	tokenHash: string,
): Promise<User | undefined> {
	return db(env)
		.select()
		.from(schema.users)
		.where(eq(schema.users.mcp_token_hash, tokenHash))
		.get();
}

export async function listUsers(env: Env): Promise<User[]> {
	return db(env).select().from(schema.users).all();
}

export async function countUsers(env: Env): Promise<number> {
	const rows = await db(env)
		.select({ id: schema.users.id })
		.from(schema.users)
		.all();
	return rows.length;
}

export interface CreateUserInput {
	email: string;
	passwordHash: string;
	passwordSalt: string;
	role: UserRole;
	mailboxAddress: string;
	mcpTokenHash?: string | null;
}

export async function createUser(
	env: Env,
	input: CreateUserInput,
): Promise<User> {
	const now = Date.now();
	const row: UserRow = {
		id: `usr_${crypto.randomUUID()}`,
		email: input.email.toLowerCase(),
		password_hash: input.passwordHash,
		password_salt: input.passwordSalt,
		role: input.role,
		is_active: 1,
		mailbox_address: input.mailboxAddress.toLowerCase(),
		mcp_token_hash: input.mcpTokenHash ?? null,
		created_at: now,
		updated_at: now,
	};
	await db(env).insert(schema.users).values(row).run();
	return row;
}

export async function setUserActive(
	env: Env,
	id: string,
	isActive: boolean,
): Promise<void> {
	await db(env)
		.update(schema.users)
		.set({ is_active: isActive ? 1 : 0, updated_at: Date.now() })
		.where(eq(schema.users.id, id))
		.run();
}

export async function updateUserPassword(
	env: Env,
	id: string,
	passwordHash: string,
	passwordSalt: string,
): Promise<void> {
	await db(env)
		.update(schema.users)
		.set({
			password_hash: passwordHash,
			password_salt: passwordSalt,
			updated_at: Date.now(),
		})
		.where(eq(schema.users.id, id))
		.run();
}

export async function setUserMcpTokenHash(
	env: Env,
	id: string,
	tokenHash: string | null,
): Promise<void> {
	await db(env)
		.update(schema.users)
		.set({ mcp_token_hash: tokenHash, updated_at: Date.now() })
		.where(eq(schema.users.id, id))
		.run();
}
