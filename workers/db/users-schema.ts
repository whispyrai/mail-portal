// Global users table (D1), shared across the whole app. Per-mailbox data lives
// in the MailboxDO; users + credentials are a global concern and live here.
//
// Drizzle schema for the D1 database bound as `DB`. The matching DDL lives in
// migrations/0001_create_users.sql (applied with `wrangler d1 migrations apply`).

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Role vocabulary lives next to the table that uses it (no central enum dump).
export const USER_ROLES = ["AGENT", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable("users", {
	id: text("id").primaryKey(), // usr_<uuid>
	email: text("email").notNull().unique(), // login identity, lowercased
	password_hash: text("password_hash").notNull(), // PBKDF2-SHA256, base64
	password_salt: text("password_salt").notNull(), // 16 random bytes, base64
	role: text("role", { enum: USER_ROLES }).notNull().default("AGENT"),
	is_active: integer("is_active").notNull().default(1),
	mailbox_address: text("mailbox_address").notNull().unique(), // usually == email
	mcp_token_hash: text("mcp_token_hash"), // SHA-256 of the user's MCP bearer token
	created_at: integer("created_at").notNull(), // unix ms
	updated_at: integer("updated_at").notNull(), // unix ms
});

export type UserRow = typeof users.$inferSelect;
