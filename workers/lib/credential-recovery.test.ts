import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";

test("an invitation stores only a hash and delivers the raw token to the recovery address", async () => {
  const stored: Array<Record<string, unknown>> = [];
  const deliveries: Array<Record<string, unknown>> = [];
  const workflow = createCredentialRecoveryWorkflow({
    now: () => 1_000,
    generateToken: () => "raw-secret-token",
    hashToken: async () => "opaque-hash",
    store: {
      async issue(record) {
        stored.push(record);
      },
      async consume() {
        return null;
      },
    },
    async deliver(input) {
      deliveries.push(input);
      return "accepted";
    },
  });

  await workflow.issue({
    purpose: "setup",
    userId: "user-1",
    loginEmail: "user@wiserchat.ai",
    recoveryEmail: "user@personal.example",
    issuedBy: "admin-1",
    origin: "https://mail.wiserchat.ai",
  });

  assert.equal(stored[0]?.tokenHash, "opaque-hash");
  assert.doesNotMatch(JSON.stringify(stored), /raw-secret-token/);
  assert.equal(deliveries[0]?.to, "user@personal.example");
  assert.match(String(deliveries[0]?.recoveryUrl), /raw-secret-token/);
});

test("a recovery token is expiring and single-use at the workflow boundary", async () => {
  let available = true;
  const workflow = createCredentialRecoveryWorkflow({
    now: () => 10_000,
    generateToken: () => "token",
    hashToken: async (token) => `hash:${token}`,
    store: {
      async issue() {},
      async consume(input) {
        if (!available || input.tokenHash !== "hash:token") return null;
        available = false;
        return {
          userId: "user-1",
          loginEmail: "user@wiserchat.ai",
          outcome: "claimed" as const,
        };
      },
    },
    async deliver() {
      return "accepted";
    },
  });

  assert.deepEqual(
    await workflow.consume({
      token: "token",
      passwordHash: "password-hash",
      passwordSalt: "password-salt",
      mcpTokenHash: null,
    }),
    {
      userId: "user-1",
      loginEmail: "user@wiserchat.ai",
      outcome: "claimed",
    },
  );
  assert.equal(
    await workflow.consume({
      token: "token",
      passwordHash: "other",
      passwordSalt: "other",
      mcpTokenHash: null,
    }),
    null,
  );
});

test("setup and recovery issuance are recorded as distinct audit-safe purposes", async () => {
  const stored: Array<Record<string, unknown>> = [];
  const workflow = createCredentialRecoveryWorkflow({
    now: () => 20_000,
    generateToken: () => "raw-token",
    hashToken: async () => "hash-only",
    store: {
      async issue(record) {
        stored.push(record);
      },
      async consume() {
        return null;
      },
    },
    async deliver() {
      return "accepted";
    },
  });

  await workflow.issue({
    purpose: "recovery",
    userId: "user-1",
    loginEmail: "user@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });

  assert.equal(stored[0]?.purpose, "recovery");
  assert.equal(stored[0]?.issuedBy, undefined);
  assert.doesNotMatch(JSON.stringify(stored), /raw-token|personal\.example/);
});
