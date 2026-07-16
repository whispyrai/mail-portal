import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const repairStart = source.indexOf("async repairInboundDerivedContent(");
const cleanupStart = source.indexOf(
  "async enqueueUnownedInboundDerivedContentCleanup(",
);
const terminalizerStart = source.indexOf(
  "async finalizeInboundDerivedContentRepairAttempt(",
  cleanupStart,
);
const repair = source.slice(repairStart, cleanupStart);
const terminalizerEnd = source.indexOf(
  "async getConversationIntelligenceEvidence",
  terminalizerStart,
);
const terminalizer = source.slice(terminalizerStart, terminalizerEnd);
const cleanupEnd = source.indexOf(
  "async finalizeInboundDerivedContentRepairAttempt(",
  cleanupStart,
);
const cleanup = source.slice(cleanupStart, cleanupEnd);
const terminalFailureStart = source.indexOf(
  "async recordInboundTerminalFailure(",
);
const terminalFailureEnd = source.indexOf(
  "async getInboundTerminalFailure(",
  terminalFailureStart,
);
const terminalFailure = source.slice(terminalFailureStart, terminalFailureEnd);

test("terminal-failure persistence rejects forged error codes before storage", () => {
  assert.notEqual(terminalFailureStart, -1);
  assert.notEqual(terminalFailureEnd, -1);
  assert.match(
    terminalFailure,
    /input\.errorCode !== "QUEUE_RETRY_EXHAUSTED"/,
  );
  assert.ok(
    terminalFailure.indexOf('input.errorCode !== "QUEUE_RETRY_EXHAUSTED"') <
      terminalFailure.indexOf("transactionSync"),
  );
});

test("derived-content repair is generation-fenced and changes only derived projection state", () => {
  assert.notEqual(repairStart, -1);
  assert.notEqual(cleanupStart, -1);
  assert.match(repair, /RecipientMemoryOrigins\.LIVE_INBOUND/);
  assert.match(repair, /state\.last_repair_marker_id === command\.markerId/);
  assert.match(repair, /state\.generation !== command\.expectedGeneration/);
  assert.match(repair, /transactionSync<InboundDerivedContentRepairResult>/);
  assert.match(repair, /delete\(schema\.attachments\)/);
  assert.match(repair, /delete\(schema\.emailBodyObjects\)/);
  assert.match(repair, /#enqueueR2DeletionSync\(/);
  assert.match(repair, /#adoptR2OwnershipSync\(/);
  assert.match(repair, /status: "cleanup_conflict"/);
  assert.match(
    repair,
    /update\(schema\.emails\)[\s\S]*\.set\(\{ body: command\.body \}\)/,
  );
  assert.match(repair, /generation = state\.generation \+ 1/);
  assert.doesNotMatch(repair, /folder_id:/);
  assert.doesNotMatch(repair, /read:/);
  assert.doesNotMatch(repair, /starred:/);
  assert.doesNotMatch(repair, /thread_id:/);
});

test("cleanup scheduling succeeds before repair acceptance", () => {
  assert.match(repair, /await this\.#scheduleAlarmAt\(Date\.now\(\) \+ 100\)/);
  assert.ok(
    repair.indexOf("await this.#scheduleAlarmAt(Date.now() + 100)") <
      repair.indexOf("transactionSync<InboundDerivedContentRepairResult>"),
  );
  assert.doesNotMatch(repair, /DERIVED_CONTENT_CLEANUP_SCHEDULE_FAILED/);
});

test("attempt-owned cleanup RPC validates the exact bounded namespace before durable enqueue", () => {
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupEnd, -1);
  assert.match(cleanup, /validateInboundDerivedContentCleanupProof\(input\)/);
  assert.match(cleanup, /await this\.env\.BUCKET\.head\(candidate\.r2Key\)/);
  assert.match(cleanup, /classifyInboundDerivedContentCleanup\(/);
  assert.match(cleanup, /select\(\)[\s\S]*from\(schema\.attachments\)/);
  assert.match(cleanup, /schema\.emailBodyObjects\.byte_length/);
  assert.match(cleanup, /classifyInboundDerivedContentCleanup\([\s\S]*owned/);
  assert.match(cleanup, /#enqueueR2DeletionSync\(/);
  assert.match(cleanup, /projectionAttemptId: input\.projectionAttemptId/);
  assert.ok(
    cleanup.indexOf("await this.#scheduleAlarmAt(Date.now() + 100)") <
      cleanup.indexOf("transactionSync"),
  );
  assert.match(cleanup, /queued: cleanup\.queued\.length/);
  assert.match(cleanup, /retained: cleanup\.retained/);
  assert.match(cleanup, /absent: cleanup\.absent/);
});

test("repair and guarded cleanup are safe in either interleaving", () => {
  const clearNewKeys = repair.indexOf("#adoptR2OwnershipSync(");
  const queueSuperseded = repair.indexOf("for (const key of supersededKeys)");
  assert.notEqual(clearNewKeys, -1);
  assert.ok(clearNewKeys < queueSuperseded);
  assert.match(repair, /command\.attemptId,[\s\S]*\[\.\.\.newKeys\]/);

  const ownershipRead = cleanup.indexOf("const owned = new Map");
  const cleanupInsert = cleanup.indexOf("#enqueueR2DeletionSync(");
  assert.notEqual(ownershipRead, -1);
  assert.ok(ownershipRead < cleanupInsert);
});

test("repair authenticates the complete command before entering its transaction", () => {
  assert.match(repair, /inboundDerivedContentRepairCommandFingerprint/);
  assert.ok(
    repair.indexOf("inboundDerivedContentRepairCommandFingerprint") <
      repair.indexOf("transactionSync<InboundDerivedContentRepairResult>"),
  );
	assert.match(repair, /const \{ commandFingerprint, \.\.\.commandWithoutFingerprint \} = command/);
	assert.match(repair, /commandWithoutFingerprint,[\s\S]*!== commandFingerprint/);
});

test("exact committed replay preserves ownership and stored generation", () => {
  const replayStart = repair.indexOf('existingAttempt.outcome === "committed"');
  const replayEnd = repair.indexOf("const finishAttempt", replayStart);
  const replay = repair.slice(replayStart, replayEnd);
  assert.match(replay, /status: "repaired"/);
  assert.match(replay, /generation: existingAttempt\.result_generation/);
  assert.doesNotMatch(replay, /already_repaired/);
});

test("attempt terminal state and projection mutation share one synchronous transaction", () => {
  const transactionStart = repair.indexOf(
    "transactionSync<InboundDerivedContentRepairResult>",
  );
  const attemptWrite = repair.indexOf(
    "insert(schema.inboundDerivedContentRepairAttempts)",
    transactionStart,
  );
  const projectionWrite = repair.indexOf(
    "update(schema.emails)",
    transactionStart,
  );
  assert.notEqual(attemptWrite, -1);
  assert.notEqual(projectionWrite, -1);
  assert.doesNotMatch(repair.slice(transactionStart), /await /);
});

test("terminalizer atomically returns committed generation or records absence as abandoned", () => {
  assert.notEqual(terminalizerStart, -1);
  assert.notEqual(terminalizerEnd, -1);
  assert.match(terminalizer, /transactionSync/);
  assert.match(terminalizer, /outcome: "committed"/);
  assert.match(terminalizer, /generation: existing\.result_generation/);
  assert.match(terminalizer, /outcome: "abandoned"/);
  assert.doesNotMatch(terminalizer, /command_json|commandJson/);
  assert.doesNotMatch(terminalizer, /outcome: "pending"/);
  assert.doesNotMatch(terminalizer, /await /);
  assert.match(
    terminalizer,
    /developers\.cloudflare\.com\/durable-objects\/api\/sqlite-storage-api\/#transactions/,
  );
});
