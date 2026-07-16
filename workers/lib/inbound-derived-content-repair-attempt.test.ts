import assert from "node:assert/strict";
import test from "node:test";
import type { InboundDerivedContentRepairAttemptTerminal } from "./inbound-projection-contract.ts";
import {
  INBOUND_REPAIR_ATTEMPT_BATCH_SIZE,
  INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
  exactDerivedContentProofMatches,
  isInboundDerivedContentRepairAttempt,
  pendingRepairAttemptKey,
  persistPendingRepairAttempt,
  readRepairAttemptResolution,
  reconcilePendingInboundRepairAttempts,
  resolveRepairAttempt,
  resolvedRepairAttemptKey,
  type InboundDerivedContentRepairAttempt,
  type InboundDerivedContentRepairResolution,
} from "./inbound-derived-content-repair-attempt.ts";

function attempt(
  _label: string,
  createdAt = "2026-07-15T09:00:00.000Z",
): InboundDerivedContentRepairAttempt {
  const ordinal = ++attemptOrdinal;
  const id = `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
  const ingressId = `ingress-${ordinal}`;
  return {
    schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
    kind: "inbound_derived_content_repair_attempt",
    status: "pending",
    attemptId: id,
    ingressId,
    mailboxId: "hello@wiserchat.ai",
    expectedGeneration: 4,
    markerId: "marker_12345678",
    commandFingerprint: "a".repeat(64),
    createdAt,
    proof: {
      attachments: [{
        r2Key: `attachments/${ingressId}/${id}/${ingressId}-0/report.pdf`,
        byteLength: 8,
      }],
      bodyObjects: [{
        r2Key: `email-bodies/${ingressId}/${id}/0.body`,
        byteLength: 13,
      }],
    },
  };
}

let attemptOrdinal = 0;

function resolution(
  value: InboundDerivedContentRepairAttempt,
  result: "discarded" | "owned",
): InboundDerivedContentRepairResolution {
  return {
    schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
    kind: "inbound_derived_content_repair_resolution",
    status: "resolved",
    resolution: result,
    attempt: value,
  };
}

function harness(input?: {
  terminal?: InboundDerivedContentRepairAttemptTerminal;
  terminalError?: boolean;
  failResolutionWrite?: boolean;
  writeResolutionThenThrow?: boolean;
  failCleanupRpc?: boolean;
  failPendingDelete?: boolean;
  cleanupResult?: { queued: number; retained: number; absent: number };
}) {
  const objects = new Map<string, string>();
  const cleanupProofs: Array<Array<{ r2Key: string; byteLength: number }>> = [];
  let listLimit = 0;
  let finalizerCalls = 0;
  const raw = {
    async list(options: { prefix: string; limit: number; cursor?: string }) {
      listLimit = options.limit;
      const keys = [...objects.keys()].filter((key) =>
        key.startsWith(options.prefix),
      );
      const offset = Number(options.cursor ?? 0);
      const page = keys.slice(offset, offset + options.limit);
      const next = offset + page.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated: next < keys.length,
        ...(next < keys.length ? { cursor: String(next) } : {}),
      };
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            etag: `etag-${key.length}`,
            async text() {
              return value;
            },
          };
    },
    async put(
      key: string,
      value: string,
      options?: {
        httpMetadata?: { contentType: string };
        customMetadata?: Record<string, string>;
        onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
      },
    ) {
      if (
        options?.onlyIf?.etagDoesNotMatch === "*" &&
        objects.has(key)
      ) return null;
      if (input?.failResolutionWrite && key.includes("/resolved/")) {
        throw new Error("resolution unavailable");
      }
      objects.set(key, value);
      if (input?.writeResolutionThenThrow && key.includes("/resolved/")) {
        throw new Error("ambiguous resolution response");
      }
      return {};
    },
    async delete(key: string) {
      if (input?.failPendingDelete && key.includes("/pending/")) {
        throw new Error("pending delete unavailable");
      }
      objects.delete(key);
    },
  };
  const env = {
    RAW_MAIL_BUCKET: raw,
    MAILBOX: {
      idFromName(value: string) {
        return value;
      },
      get() {
        return {
          async finalizeInboundDerivedContentRepairAttempt() {
            finalizerCalls += 1;
            if (input?.terminalError) {
              throw new Error("terminal state unavailable");
            }
            return input?.terminal ?? { outcome: "abandoned" };
          },
          async enqueueUnownedInboundDerivedContentCleanup(value: {
            objects: Array<{ r2Key: string; byteLength: number }>;
          }) {
            if (input?.failCleanupRpc) throw new Error("cleanup unavailable");
            cleanupProofs.push(value.objects);
            return input?.cleanupResult ?? {
              queued: value.objects.length,
              retained: 0,
              absent: 0,
            };
          },
        };
      },
    },
  } satisfies Parameters<typeof reconcilePendingInboundRepairAttempts>[0];
  return {
    objects,
    raw,
    cleanupProofs,
    listLimit: () => listLimit,
    finalizerCalls: () => finalizerCalls,
    putAttempt(value: InboundDerivedContentRepairAttempt) {
      objects.set(
        pendingRepairAttemptKey(value.ingressId, value.attemptId),
        JSON.stringify(value),
      );
    },
    env,
  };
}

test("exact proof comparison includes object kind, exact key, and byte length", () => {
  const proof = {
    attachments: [{ r2Key: "a", byteLength: 8 }],
    bodyObjects: [{ r2Key: "b", byteLength: 13 }],
  };
  assert.equal(exactDerivedContentProofMatches(proof, proof), true);
  assert.equal(
    exactDerivedContentProofMatches(proof, {
      attachments: [{ r2Key: "other", byteLength: 8 }],
      bodyObjects: proof.bodyObjects,
    }),
    false,
  );
  assert.equal(
    exactDerivedContentProofMatches(proof, {
      attachments: [{ r2Key: "a", byteLength: 9 }],
      bodyObjects: proof.bodyObjects,
    }),
    false,
  );
  assert.equal(
    exactDerivedContentProofMatches(proof, {
      attachments: proof.bodyObjects,
      bodyObjects: proof.attachments,
    }),
    false,
  );
});

test("repair-attempt proof accepts only the exact UUID-owned namespace", () => {
  const value = attempt("valid");
  assert.equal(isInboundDerivedContentRepairAttempt(value), true);
  const invalid = [
    { ...value, privatePayload: "poison" },
    { ...value, proof: { ...value.proof, privatePayload: "poison" } },
    {
      ...value,
      proof: {
        ...value.proof,
        attachments: [{
          ...value.proof.attachments[0]!,
          privatePayload: "poison",
        }],
      },
    },
    { ...value, attemptId: "attempt_12345678" },
    { ...value, ingressId: `${value.ingressId}/other` },
    {
      ...value,
      proof: {
        ...value.proof,
        bodyObjects: [{
          ...value.proof.bodyObjects[0]!,
          r2Key: `email-bodies/another-message/${value.attemptId}/0.body`,
        }],
      },
    },
    {
      ...value,
      proof: {
        ...value.proof,
        bodyObjects: [{
          ...value.proof.bodyObjects[0]!,
          r2Key: `email-bodies/${value.ingressId}/00000000-0000-4000-8000-999999999999/0.body`,
        }],
      },
    },
    {
      ...value,
      proof: {
        attachments: value.proof.attachments,
        bodyObjects: [{
          ...value.proof.attachments[0]!,
        }],
      },
    },
    {
      ...value,
      proof: {
        attachments: value.proof.attachments,
        bodyObjects: [{
          r2Key: `email-bodies/${value.ingressId}/${value.attemptId}/01.body`,
          byteLength: 13,
        }],
      },
    },
    {
      ...value,
      proof: {
        ...value.proof,
        bodyObjects: [{ ...value.proof.bodyObjects[0]!, byteLength: Number.MAX_SAFE_INTEGER + 1 }],
      },
    },
  ];
  for (const candidate of invalid) {
    assert.equal(isInboundDerivedContentRepairAttempt(candidate), false);
  }
});

test("repair-attempt persistence and resolution reads reject poisoned records", async () => {
  const value = attempt("poisoned-ledger");
  const poisonedAttempts = [
    { ...value, privatePayload: "poison" },
    {
      ...value,
      proof: {
        ...value.proof,
        attachments: [{
          ...value.proof.attachments[0]!,
          privatePayload: "poison",
        }],
      },
    },
  ];
  let writes = 0;
  for (const poisoned of poisonedAttempts) {
    assert.equal(
      await persistPendingRepairAttempt(
        {
          async put() {
            writes += 1;
            return {};
          },
          async get() {
            return null;
          },
        },
        poisoned,
      ),
      false,
    );
  }
  assert.equal(writes, 0);

  const poisonedResolution = {
    ...resolution(value, "owned"),
    privatePayload: "poison",
  };
  assert.equal(
    await readRepairAttemptResolution(
      {
        async get() {
          return {
            async text() {
              return JSON.stringify(poisonedResolution);
            },
          };
        },
      },
      value.ingressId,
      value.attemptId,
      value.commandFingerprint,
    ),
    null,
  );
});

test("repair-attempt proof rejects duplicate and aggregate-overflow entries", () => {
  const value = attempt("bounds");
  assert.equal(isInboundDerivedContentRepairAttempt({
    ...value,
    proof: {
      attachments: value.proof.attachments,
      bodyObjects: [{ ...value.proof.attachments[0]! }],
    },
  }), false);
  assert.equal(isInboundDerivedContentRepairAttempt({
    ...value,
    proof: {
      attachments: [],
      bodyObjects: Array.from({ length: 513 }, (_, index) => ({
        r2Key: `email-bodies/${value.ingressId}/${value.attemptId}/${index}.body`,
        byteLength: index,
      })),
    },
  }), false);
});

test("pending intent must be readable and exact before repair can proceed", async () => {
  const value = attempt("attempt_12345678");
  assert.equal(
    await persistPendingRepairAttempt(
      {
        async put() {
          throw new Error("ambiguous write");
        },
        async get() {
          return null;
        },
      },
      value,
    ),
    false,
  );
});

test("reconciliation leaves an unresolved attempt untouched before grace", async () => {
  const value = attempt("young_12345678", "2026-07-15T09:58:00.000Z");
  const state = harness({ terminal: { outcome: "committed", generation: 5 } });
  state.putAttempt(value);

  assert.deepEqual(
    await reconcilePendingInboundRepairAttempts(state.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    }),
    { scanned: 1, resolved: 0 },
  );
  assert.equal(state.finalizerCalls(), 0);
  assert.equal(
    state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
    true,
  );
});

test("committed terminal attempt becomes owned without deleting derived objects", async () => {
  const value = attempt("owned_12345678");
  const state = harness({ terminal: { outcome: "committed", generation: 5 } });
  state.putAttempt(value);

  assert.deepEqual(
    await reconcilePendingInboundRepairAttempts(state.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    }),
    { scanned: 1, resolved: 1 },
  );
  assert.equal(state.finalizerCalls(), 1);
  assert.deepEqual(state.cleanupProofs, []);
  assert.equal(
    state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
    false,
  );
});

for (const terminal of ["abandoned", "rejected"] satisfies Array<
  "abandoned" | "rejected"
>) {
  test(`${terminal} terminal attempt is resolved and cleaned after grace`, async () => {
    const value = attempt(`${terminal}_12345678`);
    const state = harness({ terminal: { outcome: terminal } });
    state.putAttempt(value);

    assert.deepEqual(
      await reconcilePendingInboundRepairAttempts(state.env, {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
      }),
      { scanned: 1, resolved: 1 },
    );
    assert.deepEqual(state.cleanupProofs, [[
      ...value.proof.attachments,
      ...value.proof.bodyObjects,
    ]]);
  });
}

test("an exact immutable conditional loser is accepted", async () => {
  const value = attempt("exact_loser_12345678");
  const state = harness();
  assert.equal(await resolveRepairAttempt(state.raw, value, "owned"), true);
  assert.equal(await resolveRepairAttempt(state.raw, value, "owned"), true);
});

test("an ambiguous resolution response is accepted only after exact reread", async () => {
  const value = attempt("ambiguous_write_12345678");
  const state = harness({ writeResolutionThenThrow: true });
  assert.equal(await resolveRepairAttempt(state.raw, value, "owned"), true);
});

test("a conflicting immutable resolution never deletes staged objects", async () => {
  const value = attempt("conflict_12345678");
  const competitor = {
    ...value,
    commandFingerprint: "b".repeat(64),
  };
  const state = harness({ terminal: { outcome: "abandoned" } });
  state.putAttempt(value);
  state.objects.set(
    resolvedRepairAttemptKey(value.ingressId, value.attemptId),
    JSON.stringify(resolution(competitor, "discarded")),
  );

  assert.deepEqual(
    await reconcilePendingInboundRepairAttempts(state.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    }),
    { scanned: 1, resolved: 0 },
  );
  assert.deepEqual(state.cleanupProofs, []);
  assert.equal(
    state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
    true,
  );
});

test("transient terminal, resolution, cleanup-RPC, and pending-delete failures leave pending state", async () => {
  for (const failure of [
    { terminalError: true },
    { failResolutionWrite: true },
    { failCleanupRpc: true },
    { failPendingDelete: true },
  ]) {
    const value = attempt(`transient_${Object.keys(failure)[0]}_12345678`);
    const state = harness(failure);
    state.putAttempt(value);
    await reconcilePendingInboundRepairAttempts(state.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });
    assert.equal(
      state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
      true,
      Object.keys(failure)[0],
    );
  }
});

test("ambiguous or incomplete guarded-cleanup result keeps the pending ledger", async () => {
  const value = attempt("ambiguous-cleanup-result");
  const state = harness({
    terminal: { outcome: "abandoned" },
    cleanupResult: { queued: 1, retained: 0, absent: 0 },
  });
  state.putAttempt(value);
  await reconcilePendingInboundRepairAttempts(state.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.equal(
    state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
    true,
  );
});

test("an existing discarded resolution is not final until cleanup is authoritatively accepted", async () => {
  const value = attempt("resolved-discarded");
  const state = harness({ failCleanupRpc: true });
  state.putAttempt(value);
  state.objects.set(
    resolvedRepairAttemptKey(value.ingressId, value.attemptId),
    JSON.stringify(resolution(value, "discarded")),
  );
  await reconcilePendingInboundRepairAttempts(state.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.equal(
    state.objects.has(pendingRepairAttemptKey(value.ingressId, value.attemptId)),
    true,
  );
});

test("an existing owned resolution removes only the pending ledger", async () => {
  const value = attempt("resolved-owned");
  const state = harness();
  state.putAttempt(value);
  state.objects.set(
    resolvedRepairAttemptKey(value.ingressId, value.attemptId),
    JSON.stringify(resolution(value, "owned")),
  );
  const result = await reconcilePendingInboundRepairAttempts(state.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.deepEqual(result, { scanned: 1, resolved: 1 });
  assert.deepEqual(state.cleanupProofs, []);
});

test("reconciliation enforces its batch bound", async () => {
  const state = harness();
  for (let index = 0; index < INBOUND_REPAIR_ATTEMPT_BATCH_SIZE + 5; index += 1) {
    state.putAttempt(attempt(`batch_${String(index).padStart(8, "0")}`));
  }
  const result = await reconcilePendingInboundRepairAttempts(state.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });
  assert.equal(state.listLimit(), INBOUND_REPAIR_ATTEMPT_BATCH_SIZE);
  assert.equal(result.scanned, INBOUND_REPAIR_ATTEMPT_BATCH_SIZE);
  assert.equal(result.resolved, INBOUND_REPAIR_ATTEMPT_BATCH_SIZE);
});

test("reconciliation logs no exact keys when guarded cleanup fails", async () => {
  const value = attempt("logging_12345678");
  const state = harness({ failCleanupRpc: true });
  state.putAttempt(value);
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    await reconcilePendingInboundRepairAttempts(state.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });
  } finally {
    console.error = original;
  }
  assert.equal(
    JSON.stringify(logs).includes(value.proof.attachments[0]!.r2Key),
    false,
  );
  assert.equal(
    JSON.stringify(logs).includes(value.proof.bodyObjects[0]!.r2Key),
    false,
  );
});
