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
const createDirectStart = source.indexOf("async createDirectInboundEmail(");
const createDirectEnd = source.indexOf(
  "async createImportedEmail(",
  createDirectStart,
);
const createDirect = source.slice(createDirectStart, createDirectEnd);
const createEmailStart = source.indexOf("async createEmail(");
const createEmail = source.slice(createEmailStart, createInboundEnd);
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
  const alarm = createEmail.indexOf(
    "await this.#scheduleAlarmAt(Date.now() + 100)",
  );
  const transaction = createEmail.indexOf(
    "transactionSync<InboundProjectionResult>",
  );
  const classify = createEmail.indexOf(
    "classifyInboundProjectionDerivedContent",
  );
  const outbox = createEmail.indexOf("this.#enqueueUnownedR2DeletionSync(");
  assert.notEqual(alarm, -1);
  assert.notEqual(transaction, -1);
  assert.ok(alarm < transaction);
  assert.ok(transaction < classify);
  assert.ok(classify < outbox);
  assert.doesNotMatch(createEmail.slice(alarm, transaction), /catch/);
  assert.match(createEmail, /#adoptR2OwnershipSync\(/);
  assert.match(createEmail, /status: "cleanup_conflict"/);
  assert.match(createEmail, /cleanupKeys/);
});

test("live-inbound projection expiry is checked at admission and again before its transaction", () => {
  const archiveAdmissionCheck = createInbound.indexOf(
    "assertInboundProjectionDeadlineIsActive(command.projectionExpiresAt)",
  );
  const directAdmissionCheck = createDirect.indexOf(
    "assertInboundProjectionDeadlineIsActive(command.projectionExpiresAt)",
  );
  const alarm = createEmail.indexOf(
    "await this.#scheduleAlarmAt(Date.now() + 100)",
  );
  const transactionCheck = createEmail.indexOf(
    "assertInboundProjectionDeadlineIsActive(",
  );
  const transaction = createEmail.indexOf(
    "transactionSync<InboundProjectionResult>",
  );

  assert.ok(archiveAdmissionCheck >= 0);
  assert.ok(directAdmissionCheck >= 0);
  assert.ok(alarm >= 0);
  assert.ok(transactionCheck > alarm);
  assert.ok(transactionCheck < transaction);
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
