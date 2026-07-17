// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Data access for the global users table (D1, binding `DB`). The DB layer throws;
// callers (route handlers) translate failures into user-facing responses.

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/users-schema.ts";
import type { UserRole, UserRow } from "../db/users-schema.ts";
import type { Env } from "../types.ts";

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
  return db(env)
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
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
  const result = await env.DB.prepare(
    `SELECT
       u.id, u.email, u.password_hash, u.password_salt, u.session_version,
       u.role, u.is_active, u.mailbox_address, u.mcp_token_hash,
       u.recovery_email, u.ownership_confirmed_at, u.created_at, u.updated_at
     FROM users AS u
     WHERE u.is_active = 1
       OR EXISTS (
         SELECT 1
         FROM mailboxes AS m
         WHERE m.owner_user_id = u.id
           AND m.type = 'PERSONAL'
           AND m.id = u.mailbox_address
           AND m.address = u.mailbox_address
       )
     ORDER BY u.email ASC`,
  ).all<User>();
  return result.results;
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
  ownershipConfirmedAt?: number | null;
}

export async function createUser(
  env: Env,
  input: CreateUserInput,
): Promise<User> {
  const now = Date.now();
  const mailboxAddress = input.mailboxAddress.toLowerCase();
  const row: UserRow = {
    id: `usr_${crypto.randomUUID()}`,
    email: input.email.toLowerCase(),
    password_hash: input.passwordHash,
    password_salt: input.passwordSalt,
    session_version: 1,
    role: input.role,
    is_active: 1,
    mailbox_address: mailboxAddress,
    mcp_token_hash: input.mcpTokenHash ?? null,
    recovery_email: null,
    ownership_confirmed_at: input.ownershipConfirmedAt ?? null,
    created_at: now,
    updated_at: now,
  };
  const database = db(env);
  await database.batch([
    database.insert(schema.users).values(row),
    database.insert(schema.mailboxes).values({
      id: mailboxAddress,
      address: mailboxAddress,
      type: "PERSONAL",
      owner_user_id: row.id,
      is_active: 1,
      created_at: now,
      updated_at: now,
    }),
  ]);
  return row;
}

export async function revokeUserCredentials(
  env: Env,
  id: string,
  passwordHash: string,
  passwordSalt: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, mcp_token_hash = NULL,
			 session_version = session_version + 1, updated_at = ? WHERE id = ?`,
    ).bind(passwordHash, passwordSalt, now, id),
    env.DB.prepare(
      "UPDATE credential_recovery_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
    ).bind(now, id),
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
           completed_at = ?, updated_at = ?, last_error_code = 'CREDENTIALS_REVOKED',
           cancellation_reason = 'CREDENTIALS_REVOKED', cancellation_observed_at = ?
       WHERE token_id IN (
         SELECT id FROM credential_recovery_tokens WHERE user_id = ?
       ) AND state IN ('pending', 'leased')`,
    ).bind(now, now, now, id),
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET cancellation_reason = COALESCE(cancellation_reason, 'CREDENTIALS_REVOKED'),
           cancellation_observed_at = COALESCE(cancellation_observed_at, ?),
           updated_at = ?
       WHERE token_id IN (
         SELECT id FROM credential_recovery_tokens WHERE user_id = ?
       ) AND state = 'dispatching'`,
    ).bind(now, now, id),
  ]);
}

export async function deleteUser(env: Env, id: string): Promise<void> {
  await db(env).delete(schema.users).where(eq(schema.users.id, id)).run();
}
