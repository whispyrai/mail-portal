import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";

test("an invitation durably queues the raw token without returning it", async () => {
  const stored: Array<Record<string, unknown>> = [];
  const workflow = createCredentialRecoveryWorkflow({
    now: () => 1_000,
    generateToken: () => "raw-secret-token",
    hashToken: async () => "opaque-hash",
    store: {
      async issue(record, delivery) {
        stored.push({ record, delivery });
        return "issued" as const;
      },
      async consume() {
        return null;
      },
    },
  });

  const result = await workflow.issue({
    purpose: "setup",
    userId: "user-1",
    loginEmail: "user@wiserchat.ai",
    recoveryEmail: "user@personal.example",
    issuedBy: "admin-1",
    origin: "https://mail.wiserchat.ai",
  });

  const record = stored[0]?.record as Record<string, unknown>;
  const delivery = stored[0]?.delivery as Record<string, unknown>;
  assert.equal(record.tokenHash, "opaque-hash");
  assert.equal(delivery.to, "user@personal.example");
  assert.match(String(delivery.recoveryUrl), /raw-secret-token/);
  assert.deepEqual(result, {
    issuance: "issued",
    delivery: "queued",
    expiresAt: 86_401_000,
  });
});

test("a recovery token is expiring and single-use at the workflow boundary", async () => {
  let available = true;
  const workflow = createCredentialRecoveryWorkflow({
    now: () => 10_000,
    generateToken: () => "token",
    hashToken: async (token) => `hash:${token}`,
    store: {
      async issue() { return "issued" as const; },
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
      async issue(record, delivery) {
        stored.push({ record, delivery });
        return "issued" as const;
      },
      async consume() {
        return null;
      },
    },
  });

  await workflow.issue({
    purpose: "recovery",
    userId: "user-1",
    loginEmail: "user@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });

  const record = stored[0]?.record as Record<string, unknown>;
  assert.equal(record.purpose, "recovery");
  assert.equal(record.issuedBy, undefined);
});
