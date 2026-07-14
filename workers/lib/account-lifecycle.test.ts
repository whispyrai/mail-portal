import assert from "node:assert/strict";
import test from "node:test";
import { sessionMatchesUserVersion } from "./auth.ts";
import { mcpCredentialVersionMatches } from "./mcp-authorization.ts";
import { createAccountLifecycle } from "./account-lifecycle.ts";

test("deactivate permanently revokes passwords, cookies, OAuth/MCP, and recovery grants", async () => {
  const state = {
    active: 1,
    passwordHash: "old-password-hash",
    passwordSalt: "old-salt",
    sessionVersion: 4,
    mcpTokenHash: "old-mcp-token-hash" as string | null,
    openRecoveryTokens: 2,
  };
  const purged: string[] = [];
  const disconnected: string[] = [];
  const lifecycle = createAccountLifecycle({
    generateReplacementPassword: async () => ({
      hash: "unknown-random-hash",
      salt: "new-salt",
    }),
    store: {
      async deactivate(input) {
        state.active = 0;
        state.passwordHash = input.passwordHash;
        state.passwordSalt = input.passwordSalt;
        state.sessionVersion += 1;
        state.mcpTokenHash = null;
        state.openRecoveryTokens = 0;
        return { mailboxIds: ["member@wiserchat.ai", "team@wiserchat.ai"] };
      },
      async activate() {
        state.active = 1;
      },
    },
    async purgePush(_userId, mailboxId) {
      purged.push(mailboxId);
    },
    async disconnectAgent(_userId, mailboxId) {
      disconnected.push(mailboxId);
    },
  });

  await lifecycle.deactivate("usr_member");
  await lifecycle.activate("usr_member");

  assert.equal(state.active, 1);
  assert.equal(state.passwordHash, "unknown-random-hash");
  assert.equal(state.mcpTokenHash, null);
  assert.equal(state.openRecoveryTokens, 0);
  assert.equal(
    sessionMatchesUserVersion(
      { sessionVersion: 4 },
      { session_version: state.sessionVersion },
    ),
    false,
  );
  assert.equal(
    mcpCredentialVersionMatches(
      { sessionVersion: 4 },
      { session_version: state.sessionVersion },
    ),
    false,
  );
  assert.deepEqual(purged.sort(), ["member@wiserchat.ai", "team@wiserchat.ai"]);
  assert.deepEqual(disconnected.sort(), ["member@wiserchat.ai", "team@wiserchat.ai"]);
});

test("push cleanup failure cannot roll back durable account revocation", async () => {
  let deactivated = false;
  const lifecycle = createAccountLifecycle({
    generateReplacementPassword: async () => ({ hash: "hash", salt: "salt" }),
    store: {
      async deactivate() {
        deactivated = true;
        return { mailboxIds: ["team@wiserchat.ai"] };
      },
      async activate() {},
    },
    async purgePush() {
      throw new Error("DO unavailable");
    },
    async disconnectAgent() {},
  });

  const result = await lifecycle.deactivate("usr_member");
  assert.equal(deactivated, true);
  assert.deepEqual(result.pushCleanupFailedMailboxIds, ["team@wiserchat.ai"]);
});

test("Agent disconnect failure is never reported as successful deactivation", async () => {
  let deactivated = false;
  const lifecycle = createAccountLifecycle({
    generateReplacementPassword: async () => ({ hash: "hash", salt: "salt" }),
    store: {
      async deactivate() {
        deactivated = true;
        return { mailboxIds: ["team@wiserchat.ai"] };
      },
      async activate() {},
    },
    async purgePush() {},
    async disconnectAgent() {
      throw new Error("Agent RPC unavailable");
    },
  });

  await assert.rejects(
    () => lifecycle.deactivate("usr_member"),
    /Live Agent connections could not be revoked/,
  );
  assert.equal(deactivated, true);
});
