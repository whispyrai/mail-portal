import assert from "node:assert/strict";
import test from "node:test";
import { resolveAmbiguousInboundRepair } from "./ambiguous-inbound-repair.ts";
import { DerivedEmailConsumerError } from "./streaming-email.ts";

test("a committed terminal attempt truthfully resolves an ambiguous repair", async () => {
  assert.deepEqual(
    await resolveAmbiguousInboundRepair({
      repairError: new Error("RPC disconnected"),
      async finalizeAttempt() {
        return { outcome: "committed", generation: 5 };
      },
    }),
    { status: "repaired", generation: 5, ambiguousCommit: true },
  );
});

const terminalNonCommitOutcomes: Array<"abandoned" | "rejected"> = [
  "abandoned",
  "rejected",
];
for (const outcome of terminalNonCommitOutcomes) {
  test(`${outcome} terminal attempt proves the repair did not commit`, async () => {
    await assert.rejects(
      resolveAmbiguousInboundRepair({
        repairError: new Error("RPC disconnected"),
        async finalizeAttempt() {
          return { outcome };
        },
      }),
      (error: unknown) =>
        error instanceof DerivedEmailConsumerError &&
        error.commitState === "not_committed",
    );
  });
}

test("terminalizer failure preserves staged objects as unverified", async () => {
  await assert.rejects(
    resolveAmbiguousInboundRepair({
      repairError: new Error("RPC disconnected"),
      async finalizeAttempt() {
        throw new Error("terminal state unavailable");
      },
    }),
    (error: unknown) =>
      error instanceof DerivedEmailConsumerError &&
      error.commitState === "unverified",
  );
});

test("empty-proof same-marker attempts are distinguished by terminal identity", async () => {
  const committed = await resolveAmbiguousInboundRepair({
    repairError: new Error("RPC disconnected"),
    async finalizeAttempt() {
      return { outcome: "committed", generation: 8 };
    },
  });
  assert.deepEqual(committed, {
    status: "repaired",
    generation: 8,
    ambiguousCommit: true,
  });

  await assert.rejects(
    resolveAmbiguousInboundRepair({
      repairError: new Error("RPC disconnected"),
      async finalizeAttempt() {
        return { outcome: "abandoned" };
      },
    }),
    (error: unknown) =>
      error instanceof DerivedEmailConsumerError &&
      error.commitState === "not_committed",
  );
});
