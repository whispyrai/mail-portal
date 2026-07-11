import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryRequestProcessor } from "./recovery-request.ts";

test("claimed account recovery is sent only to the directory-controlled stored address", async () => {
  const issued: Array<Record<string, unknown>> = [];
  const synced: Array<Record<string, unknown>> = [];
  const processor = createRecoveryRequestProcessor({
    throttle: async () => true,
    findUser: async () => ({
      id: "usr_member",
      email: "member@wiserchat.ai",
      recoveryEmail: "old@personal.example",
      ownershipConfirmedAt: 123,
    }),
    resolveDirectoryAddress: () => "owner@personal.example",
    async syncRecoveryAddress(userId, recoveryEmail) {
      synced.push({ userId, recoveryEmail });
    },
    async issue(input) {
      issued.push(input);
    },
  });

  await processor.process({
    email: "MEMBER@WISERCHAT.AI",
    ip: "203.0.113.9",
    origin: "https://mail.wiserchat.ai",
  });

  assert.deepEqual(synced, [
    { userId: "usr_member", recoveryEmail: "owner@personal.example" },
  ]);
  assert.equal(issued[0]?.purpose, "recovery");
  assert.equal(issued[0]?.recoveryEmail, "owner@personal.example");
  assert.equal(issued[0]?.issuedBy, undefined);
});

test("unknown, unclaimed, unmapped, and throttled requests remain silent", async () => {
  let issues = 0;
  for (const scenario of [
    "unknown",
    "unclaimed",
    "unmapped",
    "throttled",
  ] as const) {
    const processor = createRecoveryRequestProcessor({
      throttle: async () => scenario !== "throttled",
      findUser: async () =>
        scenario === "unknown"
          ? null
          : {
              id: "usr_member",
              email: "member@wiserchat.ai",
              recoveryEmail: null,
              ownershipConfirmedAt: scenario === "unclaimed" ? null : 123,
            },
      resolveDirectoryAddress: () => {
        if (scenario === "unmapped") throw new Error("not configured");
        return "owner@personal.example";
      },
      async syncRecoveryAddress() {},
      async issue() {
        issues += 1;
      },
    });

    await assert.doesNotReject(() =>
      processor.process({
        email: "member@wiserchat.ai",
        ip: "203.0.113.9",
        origin: "https://mail.wiserchat.ai",
      }),
    );
  }
  assert.equal(issues, 0);
});
