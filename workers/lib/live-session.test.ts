import assert from "node:assert/strict";
import test from "node:test";
import type { SessionClaims } from "./auth.ts";
import {
	agentMailboxFromPath,
	isAcceptedAgentWebSocket,
	resolveLiveSessionUser,
} from "./live-session.ts";

const claims: SessionClaims = {
	sub: "user-1",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "user@example.com",
	sessionVersion: 2,
};

function user(overrides: Record<string, unknown> = {}) {
	return {
		id: "user-1",
		email: "user@example.com",
		password_hash: "hash",
		password_salt: "salt",
		role: "AGENT" as const,
		is_active: 1,
		mailbox_address: "user@example.com",
		mcp_token_hash: null,
		recovery_email: null,
		ownership_confirmed_at: null,
		session_version: 2,
		created_at: 1,
		updated_at: 1,
		...overrides,
	};
}

test("live session resolution returns only the current active credential generation", async () => {
	assert.equal(
		(await resolveLiveSessionUser({} as never, claims, async () => user()))?.id,
		"user-1",
	);
	assert.equal(
		await resolveLiveSessionUser(
			{} as never,
			claims,
			async () => user({ session_version: 3 }),
		),
		null,
	);
	assert.equal(
		await resolveLiveSessionUser(
			{} as never,
			claims,
			async () => user({ is_active: 0 }),
		),
		null,
	);
	assert.equal(
		await resolveLiveSessionUser({} as never, claims, async () => undefined),
		null,
	);
});

test("only accepted Agent WebSockets skip finalized HTTP revalidation", () => {
	assert.equal(
		isAcceptedAgentWebSocket("/agents/mail@example.com/get-messages", "websocket", 200),
		false,
	);
	assert.equal(
		isAcceptedAgentWebSocket("/agents/mail@example.com", "websocket", 403),
		false,
	);
	assert.equal(
		isAcceptedAgentWebSocket("/api/mailboxes", "websocket", 101),
		false,
	);
	assert.equal(
		isAcceptedAgentWebSocket("/agents/mail@example.com", "WebSocket", 101),
		true,
	);
});

test("Agent routes resolve one canonical mailbox identity", () => {
	assert.equal(
		agentMailboxFromPath("/agents/email-agent/Team%40Example.COM/get-messages"),
		"team@example.com",
	);
	assert.equal(agentMailboxFromPath("/api/mailboxes"), null);
	assert.equal(agentMailboxFromPath("/agents/email-agent"), null);
	assert.equal(agentMailboxFromPath("/agents/email-agent/%E0%A4%A"), null);
});
