import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const deleteStart = source.indexOf("async deleteEmail(id: string)");
const deleteEnd = source.indexOf("async discardDraft(", deleteStart);
const deleteEmail = source.slice(deleteStart, deleteEnd);
const discardEnd = source.indexOf("#applyDraftUpdate(", deleteEnd);
const discardDraft = source.slice(deleteEnd, discardEnd);
const cleanupStart = source.indexOf("async #processR2DeletionOutbox(");
const cleanupEnd = source.indexOf("async alarm(): Promise<void>", cleanupStart);
const cleanup = source.slice(cleanupStart, cleanupEnd);
const createInboundStart = source.indexOf("async createInboundEmail(");
const createInboundEnd = source.indexOf(
  "// ── Truthful outbound delivery",
  createInboundStart,
);
const createInbound = source.slice(createInboundStart, createInboundEnd);
const reconciliationSource = readFileSync(
  new URL("../inbound-reconciliation.ts", import.meta.url),
  "utf8",
);
const repairReconcilerSource = readFileSync(
  new URL("../lib/inbound-derived-content-repair-attempt.ts", import.meta.url),
  "utf8",
);

test("live-inbound deletion cannot mutate tombstone or outbox when alarm scheduling fails", () => {
  const alarm = deleteEmail.indexOf(
    "await this.#scheduleAlarmAt(Date.now() + 100)",
  );
  const transaction = deleteEmail.indexOf("this.ctx.storage.transactionSync");
  const tombstone = deleteEmail.indexOf(
    "insert(schema.emailDeletionTombstones)",
  );
  const outbox = deleteEmail.indexOf("this.#enqueueR2DeletionSync(");
  assert.notEqual(alarm, -1);
  assert.notEqual(transaction, -1);
  assert.ok(alarm < transaction);
  assert.ok(transaction < tombstone);
  assert.ok(transaction < outbox);
  assert.doesNotMatch(deleteEmail.slice(alarm, transaction), /catch/);
});

test("draft discard commits authoritative deletion and R2 cleanup ownership atomically", () => {
  const transaction = discardDraft.indexOf("this.ctx.storage.transactionSync");
  const operation = discardDraft.indexOf("this.#markDraftCreateOperation(");
  const retention = discardDraft.indexOf("this.#refreshTerminalDraftSaveRetention(");
  const outbox = discardDraft.indexOf("this.#enqueueR2DeletionSync({");
  const emailDelete = discardDraft.indexOf(".delete(schema.emails)");
  const activity = discardDraft.indexOf('"draft_discarded"');
  const transactionEnd = discardDraft.indexOf("});", activity);
  const alarm = discardDraft.indexOf("await this.#scheduleAlarmAt", transactionEnd);
  const alarmCatch = discardDraft.indexOf("catch (error)", alarm);

  assert.ok(transaction >= 0);
  for (const boundary of [operation, retention, outbox, emailDelete, activity]) {
    assert.ok(boundary > transaction && boundary < transactionEnd);
  }
  assert.ok(alarm > transactionEnd);
  assert.ok(alarmCatch > alarm);
  assert.match(discardDraft.slice(alarmCatch), /durable attachment cleanup pending/);
  assert.match(discardDraft, /return \{ status: "discarded" as const \}/);
});

test("deletion-outbox failures persist and log only bounded error codes", () => {
  assert.match(cleanup, /last_error: "R2_DELETION_FAILED"/);
  assert.match(cleanup, /errorCode: "R2_DELETION_OUTBOX_FAILED"/);
  const failureLogStart = cleanup.indexOf(
    'console.error("[mail-cleanup] R2 deletion batch failed"',
  );
  const failureLog = cleanup.slice(
    failureLogStart,
    cleanup.indexOf("\n\t\t\t\t});", failureLogStart) + "\n\t\t\t\t});".length,
  );
  assert.doesNotMatch(
    failureLog,
    /error\.message|String\(error\)|errorMessage/,
  );
  assert.doesNotMatch(failureLog, /r2Key|r2_key/);
});

test("normal inbound acceptance transaction owns discarded derived-object cleanup", () => {
  const alarm = createInbound.indexOf(
    "await this.#scheduleAlarmAt(Date.now() + 100)",
  );
  const transaction = createInbound.indexOf(
    "transactionSync<InboundProjectionResult>",
  );
  const classify = createInbound.indexOf(
    "classifyInboundProjectionDerivedContent",
  );
  const outbox = createInbound.indexOf("this.#enqueueUnownedR2DeletionSync(");
  assert.notEqual(alarm, -1);
  assert.notEqual(transaction, -1);
  assert.ok(alarm < transaction);
  assert.ok(transaction < classify);
  assert.ok(classify < outbox);
  assert.doesNotMatch(createInbound.slice(alarm, transaction), /catch/);
  assert.match(createInbound, /#adoptR2OwnershipSync\(/);
  assert.match(createInbound, /status: "cleanup_conflict"/);
  assert.match(createInbound, /cleanupKeys/);
});

test("scheduled reconciliation terminalizes repair attempts before cleanup intents", () => {
  const repairAttempts = reconciliationSource.indexOf(
    "reconcilePendingInboundRepairAttempts(",
  );
  const cleanupIntents = reconciliationSource.indexOf(
    "reconcileInboundCleanupIntents(",
  );
  assert.notEqual(repairAttempts, -1);
  assert.ok(repairAttempts < cleanupIntents);
});

test("repair-attempt reconciliation never directly deletes derived R2 objects", () => {
  assert.doesNotMatch(
    repairReconcilerSource,
    /env\.BUCKET\.delete|deleteAttemptObjects/,
  );
  assert.match(
    repairReconcilerSource,
    /enqueueUnownedInboundDerivedContentCleanup\(\{[\s\S]*objects/,
  );
});
