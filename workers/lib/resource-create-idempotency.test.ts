import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOURCE_CREATE_REPLAY_WINDOW_MS,
  resourceCreateFingerprint,
  resourceCreateOperationKey,
  resourceCreateReplayCutoff,
} from "./resource-create-idempotency.ts";

test("resource create keys are stable and isolated by actor, mailbox, kind, and operation", async () => {
  const base = {
    kind: "folder" as const,
    mailboxId: "TEAM@EXAMPLE.COM",
    actor: { kind: "user" as const, id: "usr_1" },
    operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
  };
  assert.equal(
    await resourceCreateOperationKey(base),
    await resourceCreateOperationKey({
      ...base,
      mailboxId: "team@example.com",
    }),
  );
  for (const changed of [
    { ...base, mailboxId: "other@example.com" },
    { ...base, actor: { kind: "user" as const, id: "usr_2" } },
    { ...base, kind: "label" as const },
    { ...base, operationId: "92e968b7-3120-41a7-b839-f42b77c477bc" },
  ]) {
    assert.notEqual(
      await resourceCreateOperationKey(base),
      await resourceCreateOperationKey(changed),
    );
  }
});

test("resource fingerprints follow validated semantic intent", async () => {
  const first = await resourceCreateFingerprint({
    kind: "label",
    payload: ["VIP", "vip", "red"],
  });
  assert.equal(
    first,
    await resourceCreateFingerprint({
      kind: "label",
      payload: ["VIP", "vip", "red"],
    }),
  );
  assert.notEqual(
    first,
    await resourceCreateFingerprint({
      kind: "label",
      payload: ["VIP", "vip", "blue"],
    }),
  );
  assert.notEqual(
    first,
    await resourceCreateFingerprint({
      kind: "folder",
      payload: ["vip", "VIP"],
    }),
  );
});

test("terminal replay cutoff is exactly thirty days", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  assert.equal(
    resourceCreateReplayCutoff(now),
    new Date(now - RESOURCE_CREATE_REPLAY_WINDOW_MS).toISOString(),
  );
});
