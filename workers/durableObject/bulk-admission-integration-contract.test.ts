import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = source.indexOf("async enqueueBulkJob(");
const end = source.indexOf("async getBulkJob(", start);
const admission = source.slice(start, end);
const preparationStart = source.indexOf("async #processBulkAdmissionPreparation");
const preparationEnd = source.indexOf("async enqueueBulkJob(", preparationStart);
const preparation = source.slice(preparationStart, preparationEnd);
const alarmStart = source.indexOf("async alarm()", end);
const alarmEnd = source.indexOf(
	"// ── Deterministic inbound Automation Rules",
	alarmStart,
);
const alarm = source.slice(alarmStart, alarmEnd);

test("bulk admission durably claims the immutable job before the alarm owns R2", () => {
	const claim = admission.indexOf("planBulkAdmissionClaim");
	const admissionWrite = admission.indexOf("kv.put(admissionKey, planned.record)");
	const jobWrite = admission.indexOf("`bulk:job:${planned.record.jobId}`", admissionWrite);
	const rowsWrite = admission.indexOf(
		"`bulk:rows:${planned.record.jobId}`",
		jobWrite,
	);

	assert.ok(start >= 0 && end > start);
	assert.ok(claim >= 0 && admissionWrite > claim && jobWrite > admissionWrite && rowsWrite > jobWrite);
	assert.doesNotMatch(admission, /this\.env\.BUCKET\.(?:get|put|delete)/);
	assert.doesNotMatch(admission, /#expireBulkPreparationsSync/);
	assert.match(admission, /#scheduleAlarmAt\(Date\.now\(\) \+ 100\)/);
});

test("fresh admission atomically consumes one matching live reservation", () => {
	const reservationRead = admission.indexOf("BULK_RESERVATION_PREFIX");
	const reservationValidation = admission.indexOf(
		"reservation.expiresAt <= now",
		reservationRead,
	);
	const admissionWrite = admission.indexOf(
		"kv.put(admissionKey, planned.record)",
		reservationValidation,
	);
	const reservationDelete = admission.indexOf(
		"`${BULK_RESERVATION_PREFIX}${input.operationId}`",
		admissionWrite,
	);
	assert.ok(
		reservationRead >= 0 &&
			reservationValidation > reservationRead &&
			admissionWrite > reservationValidation &&
			reservationDelete > admissionWrite,
	);
	assert.match(
		admission.slice(admissionWrite, reservationDelete + 80),
		/kv\.delete\(\s*`\$\{BULK_RESERVATION_PREFIX\}\$\{input\.operationId\}`,?\s*\)/,
	);
	assert.match(admission, /status: "reservation_invalid" as const/);
	assert.match(admission, /const rejectCapacity[\s\S]*kv\.delete/);
});

test("new reservations are daily bounded while exact replay bypasses the quota", () => {
	const reserveStart = source.indexOf("async reserveBulkOperation");
	const reserveEnd = source.indexOf("async cancelBulkReservation", reserveStart);
	const reserve = source.slice(reserveStart, reserveEnd);
	const replayReturn = reserve.indexOf(
		'planned.status !== "reserved" || planned.replayed',
	);
	const dailyPlan = reserve.indexOf("planBulkDailyReservation", replayReturn);
	assert.ok(replayReturn >= 0 && dailyPlan > replayReturn);
	assert.match(reserve, /BULK_DAILY_RESERVATION_KEY/);
});

test("the bounded alarm creates a cleanup-backed generation copy before ownership commit", () => {
	assert.match(
		preparation,
		/this\.env\.BUCKET\.get\(sourceKey\)/,
	);
	const intent = admission.indexOf("generationCleanupIntentId =");
	const write = preparation.indexOf("this.env.BUCKET.put");
	assert.ok(intent >= 0 && write >= 0);
	assert.match(admission, /bulkAttachmentPreparationKey/);
	assert.match(admission, /protectAdmissionKey: admissionKey/);
	assert.match(admission, /protectGeneration: planned\.record\.generation/);
	assert.match(preparation, /ownerId: `\$\{job\.id\}:staging`/);
	assert.match(preparation, /completeBulkAdmission/);
	assert.match(alarm, /#processBulkAdmissionPreparation\(\)/);
	assert.match(preparation, /15-minute hard wall-time limit/);
	assert.match(
		alarm,
		/const idempotencyKey = `bulk:\$\{job\.id\}:\$\{job\.cursor\}`/,
	);
});

test("bulk alarm never overwrites a concurrent queue append", () => {
	assert.doesNotMatch(alarm, /storage\.put\(BULK_QUEUE_KEY, queue\)/);
	assert.match(
		source,
		/#commitBulkTerminalSync[\s\S]*removeBulkQueueMembership/,
	);
	assert.match(admission, /#repairBulkQueueMembership\(claim\.record\.jobId\)/);
});

test("exact HTTP retry only re-arms the one alarm-owned preparation", () => {
	assert.match(admission, /claim\.status === "preparing"[\s\S]*#scheduleAlarmAt\(Date\.now\(\) \+ 100\)/);
	assert.doesNotMatch(admission, /generation:\s*existing\.generation \+ 1/);
	assert.match(preparation, /#markBulkCleanupDueSync/);
});

test("fresh admission counts the active bulk outbox and daily ledger while replay bypasses capacity", () => {
	assert.match(
		source,
		/WHERE source = 'bulk' AND status IN \('queued', 'sending', 'retrying'\)/,
	);
	assert.match(admission, /BULK_LIMITS\.maxOutstandingRecipients/);
	assert.match(admission, /planBulkDailyAdmission/);
	const existingCheck = admission.indexOf("if (!existingAdmission)");
	const capacityCheck = admission.indexOf(
		"BULK_LIMITS.maxActiveJobs",
		existingCheck,
	);
	const claimPlan = admission.indexOf("planBulkAdmissionClaim", capacityCheck);
	assert.ok(
		existingCheck >= 0 &&
			capacityCheck > existingCheck &&
			claimPlan > capacityCheck,
	);
});

test("manual bulk retries share the same future-send ceiling", () => {
	assert.match(
		source,
		/#assertBulkRetryCapacitySync[\s\S]*#bulkOutstandingRecipientCountSync\(\)[\s\S]*BULK_LIMITS\.maxOutstandingRecipients/,
	);
	assert.match(source, /retryUnknown\([\s\S]*#assertBulkRetryCapacitySync/);
	assert.match(source, /retryFailed\([\s\S]*#assertBulkRetryCapacitySync/);
});

test("recipient attachment bytes have a durable cleanup intent before R2 and transfer with outbox commit", () => {
	const preparation = source.indexOf("#createBulkRecipientPreparationSync");
	const intent = source.indexOf("#createBulkCleanupIntentSync", preparation);
	const recipientPut = alarm.indexOf("this.env.BUCKET.put");
	assert.ok(preparation >= 0 && intent > preparation && recipientPut >= 0);
	assert.match(
		alarm,
		/#ensureBulkMaintenanceAlarm\(\)[\s\S]*this\.env\.BUCKET\.put/,
	);
	assert.match(
		alarm,
		/#enqueueOutboundInternal[\s\S]*#finishBulkRecipientPreparationSync/,
	);
	assert.match(source, /completeBulkCleanupClaim/);
	assert.match(source, /retryBulkCleanupClaim/);
});

test("bulk progress and cleanup have independent alarm repair", () => {
	assert.match(
		source,
		/#bulkMaintenanceAtSync[\s\S]*head\.nextEnqueueAt \?\? head\.createdAt/,
	);
	assert.doesNotMatch(alarm, /await Promise\.all\(/);
	assert.match(
		source,
		/claim\.intent\.verifyAt[\s\S]*deleteConfirmedAt: deletedAt/,
	);
});

test("terminal replay truth is scheduled for a full retention window without a count cap", () => {
	const terminalStart = source.indexOf("#recordBulkTerminalSync");
	const pruneStart = source.indexOf("#pruneBulkTerminalSync", terminalStart);
	const retention = source.slice(
		terminalStart,
		source.indexOf("#expireBulkPreparationsSync", pruneStart),
	);
	assert.doesNotMatch(retention, /\.slice\(-/);
	assert.match(retention, /completedAt \+ BULK_LIMITS\.terminalRetentionMs/);
	assert.match(alarm, /#pruneBulkTerminalSync\(alarmNow\)/);
});

test("bulk progress returns a strict public projection rather than the stored job", () => {
	const getStart = source.indexOf("async getBulkJob(");
	const getEnd = source.indexOf("async getBulkJobByOperation", getStart);
	const getter = source.slice(getStart, getEnd);
	assert.match(getter, /BULK_JOB_ID_PATTERN/);
	assert.match(getter, /BULK_LIMITS\.maxRecipients \+ 1/);
	assert.doesNotMatch(getter, /slice\(0, 10\)/);
	assert.doesNotMatch(getter, /return job/);
	assert.doesNotMatch(getter, /subject:|html:|text:|actorUserId:|attachments:/);
});

test("opaque operation recovery is actor-private and content-free", () => {
	const recoveryStart = source.indexOf("async getBulkJobByOperation");
	const recoveryEnd = source.indexOf("#bulkRecipientPreparationKey", recoveryStart);
	const recovery = source.slice(recoveryStart, recoveryEnd);
	assert.match(recovery, /job\.actorUserId !== actorUserId/);
	assert.match(recovery, /jobId: admission\.jobId/);
	assert.match(recovery, /state: "reserved"/);
	assert.match(recovery, /#scheduleAlarmAt\(Date\.now\(\) \+ 100\)/);
	assert.doesNotMatch(recovery, /subject:|html:|text:|recipients:|attachments:/);
});

test("bulk boundaries emit content-free success, retry, and failure events", () => {
	assert.match(source, /\[bulk-send\]/);
	assert.match(source, /operation:\s*"bulk_admission_prepare"/);
	assert.match(source, /operation:\s*"bulk_attachment_cleanup"/);
	assert.match(source, /operation:\s*"bulk_recipient_enqueue"/);
	assert.match(source, /operation:\s*"bulk_job_authorization"/);
	assert.match(source, /operation:\s*"bulk_job_terminal"/);
	assert.match(source, /operation:\s*"bulk_alarm_pass"/);
	assert.match(source, /stage:\s*"idempotency_lookup"/);
	assert.match(source, /durationMs/);
	assert.doesNotMatch(source, /\[bulk-send\][\s\S]{0,240}(?:subject|recipient|filename|attachmentData):/);
});
