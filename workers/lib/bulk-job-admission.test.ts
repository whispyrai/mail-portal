import assert from "node:assert/strict";
import test from "node:test";
import {
	BulkRecipientAttachmentUnavailableError,
	BULK_LIMITS,
	BULK_RESERVATION_TTL_MS,
	BULK_STALE_WRITER_VERIFY_MS,
	bulkAttachmentPreparationKey,
	bulkAdmissionFingerprint,
	bulkHtmlValidationError,
	bulkPersonalizedHtmlValidationError,
	bulkNextUtcDayAt,
	bulkUtcDay,
	completeBulkAdmission,
	ensureBulkQueueMembership,
	failBulkAdmission,
	planBulkDailyAdmission,
	planBulkDailyReservation,
	planBulkAdmissionReservation,
	planBulkRecipientEnqueueDisposition,
	planBulkAdmissionClaim,
	removeBulkQueueMembership,
} from "./bulk-job-admission.ts";
import { InlineImageMappingError } from "./inline-image-authority.ts";

test("bulk HTML rejects malformed markup and unsupported inline images before admission", () => {
	assert.equal(bulkHtmlValidationError("<p>Valid bulk HTML</p>"), null);
	assert.equal(bulkHtmlValidationError(undefined), null);
	assert.equal(bulkHtmlValidationError("<div>"), "Message HTML is malformed.");
	assert.equal(
		bulkHtmlValidationError('<img src="cid:missing@mail-portal.local">'),
		"An inline image in the message is missing its attachment (missing@mail-portal.local).",
	);
	assert.equal(
		bulkPersonalizedHtmlValidationError(
			'<img src="{{image_url}}">',
			[{ image_url: "https://example.com/image.png" }],
		),
		null,
	);
	assert.equal(
		bulkPersonalizedHtmlValidationError(
			'<img src="{{image_url}}">',
			[{ image_url: "cid:missing@mail-portal.local" }],
		),
		"An inline image in the message is missing its attachment (missing@mail-portal.local).",
	);
});

test("job attachment copies are isolated by preparation generation", () => {
	assert.equal(BULK_STALE_WRITER_VERIFY_MS, 20 * 60_000);
	assert.equal(
		bulkAttachmentPreparationKey("job-stable", 3, 1),
		"bulk-attachments/job-stable/generation-3/1",
	);
	assert.notEqual(
		bulkAttachmentPreparationKey("job-stable", 3, 1),
		bulkAttachmentPreparationKey("job-stable", 4, 1),
	);
});

test("content-free reservation closes the pre-admission recovery race", () => {
	const first = planBulkAdmissionReservation({
		existingReservation: null,
		existingAdmission: null,
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint: "fingerprint-1",
		total: 2,
		now: 1_000,
	});
	assert.equal(first.status, "reserved");
	if (first.status !== "reserved") return;
	assert.equal(first.record.expiresAt, 1_000 + BULK_RESERVATION_TTL_MS);
	assert.equal(first.replayed, false);

	assert.equal(
		planBulkAdmissionReservation({
			existingReservation: first.record,
			existingAdmission: null,
			operationId: first.record.operationId,
			actorUserId: first.record.actorUserId,
			fingerprint: first.record.fingerprint,
			total: first.record.total,
			now: first.record.expiresAt - 1,
		}).status,
		"reserved",
	);
	assert.equal(
		planBulkAdmissionReservation({
			existingReservation: first.record,
			existingAdmission: null,
			operationId: first.record.operationId,
			actorUserId: "user-2",
			fingerprint: first.record.fingerprint,
			total: first.record.total,
			now: first.record.expiresAt - 1,
		}).status,
		"forbidden",
	);
	const expired = planBulkAdmissionReservation({
		existingReservation: first.record,
		existingAdmission: null,
		operationId: first.record.operationId,
		actorUserId: first.record.actorUserId,
		fingerprint: first.record.fingerprint,
		total: first.record.total,
		now: first.record.expiresAt,
	});
	assert.equal(expired.status, "expired");
});

test("fresh bulk admissions share one bounded UTC-day ledger", () => {
	assert.equal(
		bulkUtcDay(Date.parse("2026-07-14T23:59:59.999Z")),
		"2026-07-14",
	);
	assert.equal(
		bulkNextUtcDayAt(Date.parse("2026-07-14T23:59:59.999Z")),
		Date.parse("2026-07-15T00:00:00.000Z"),
	);
	assert.deepEqual(
		planBulkDailyAdmission(null, Date.parse("2026-07-14T10:00:00.000Z"), 120),
		{
			status: "accepted",
			record: { utcDay: "2026-07-14", jobs: 1, recipients: 120 },
		},
	);
	assert.deepEqual(
		planBulkDailyAdmission(
			{ utcDay: "2026-07-14", jobs: 1, recipients: 120 },
			Date.parse("2026-07-14T12:00:00.000Z"),
			81,
		),
		{ status: "capacity" },
	);
	assert.deepEqual(
		planBulkDailyAdmission(
			{ utcDay: "2026-07-13", jobs: 20, recipients: 200 },
			Date.parse("2026-07-14T00:00:00.000Z"),
			1,
		),
		{
			status: "accepted",
			record: { utcDay: "2026-07-14", jobs: 1, recipients: 1 },
		},
	);
});

test("fresh content-free reservations have an independent daily ceiling", () => {
	const now = Date.parse("2026-07-14T12:00:00.000Z");
	assert.deepEqual(planBulkDailyReservation(null, now), {
		status: "accepted",
		record: { utcDay: "2026-07-14", reservations: 1 },
	});
	assert.deepEqual(
		planBulkDailyReservation(
			{
				utcDay: "2026-07-14",
				reservations: BULK_LIMITS.maxReservationsPerUtcDay,
			},
			now,
		),
		{ status: "capacity" },
	);
	assert.deepEqual(
		planBulkDailyReservation(
			{
				utcDay: "2026-07-14",
				reservations: BULK_LIMITS.maxReservationsPerActorPerUtcDay,
			},
			now,
			BULK_LIMITS.maxReservationsPerActorPerUtcDay,
		),
		{ status: "capacity" },
	);
});

test("the same bulk operation has one stable fingerprint and one claimed job", async () => {
	const fingerprint = await bulkAdmissionFingerprint({
		actorUserId: "user-1",
		subject: "Hello",
		text: "Hi {{company}}",
		recipients: [{ email: "A@EXAMPLE.COM", company: "Acme" }],
		attachmentUploadIds: ["up-1"],
	});
	assert.equal(
		fingerprint,
		"57461e1d1d597385e9ae27924feeb24a7a4f0f8caca8d02db84d9f6846d22cfd",
	);

	const claimed = planBulkAdmissionClaim({
		existing: null,
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint,
		total: 1,
		now: 1_000,
		createJobId: () => "job_stable",
	});

	assert.equal(claimed.status, "claimed");
	assert.deepEqual(claimed.record, {
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint,
		jobId: "job_stable",
		total: 1,
		status: "preparing",
		generation: 1,
		error: null,
		createdAt: 1_000,
		updatedAt: 1_000,
	});
});

test("bulk queue reconciliation preserves concurrent admissions", () => {
	assert.deepEqual(ensureBulkQueueMembership(["job-a", "job-b"], "job-b"), [
		"job-a",
		"job-b",
	]);
	assert.deepEqual(ensureBulkQueueMembership(["job-a"], "job-b"), [
		"job-a",
		"job-b",
	]);
	assert.deepEqual(removeBulkQueueMembership(["job-a", "job-b"], "job-a"), [
		"job-b",
	]);
	assert.deepEqual(
		removeBulkQueueMembership(["job-a", "job-b", "job-a"], "job-a"),
		["job-b"],
	);
});

test("a definitive preparation failure is durable and generation fenced", () => {
	const record = {
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint: "fingerprint-1",
		jobId: "job_stable",
		total: 2,
		status: "preparing" as const,
		generation: 3,
		error: null,
		createdAt: 1_000,
		updatedAt: 1_000,
	};

	assert.equal(
		failBulkAdmission(record, 2, "Attachments could not be prepared.", 2_000),
		null,
	);
	assert.deepEqual(
		failBulkAdmission(record, 3, "Attachments could not be prepared.", 2_000),
		{
			...record,
			status: "failed",
			error: "Attachments could not be prepared.",
			updatedAt: 2_000,
		},
	);
});

test("only the current preparing generation can commit a queued admission", () => {
	const record = {
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint: "fingerprint-1",
		jobId: "job_stable",
		total: 2,
		status: "preparing" as const,
		generation: 2,
		error: null,
		createdAt: 1_000,
		updatedAt: 1_000,
	};

	assert.equal(completeBulkAdmission(record, 1, 2_000), null);
	assert.deepEqual(completeBulkAdmission(record, 2, 2_000), {
		...record,
		status: "queued",
		updatedAt: 2_000,
	});
});

test("exact retries never create a second preparation writer", () => {
	const preparing = {
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint: "fingerprint-1",
		jobId: "job_stable",
		total: 2,
		status: "preparing" as const,
		generation: 1,
		error: null,
		createdAt: 1_000,
		updatedAt: 1_000,
	};
	const base = {
		operationId: preparing.operationId,
		actorUserId: preparing.actorUserId,
		fingerprint: preparing.fingerprint,
		total: preparing.total,
		createJobId: () => "job_must_not_change",
	};

	assert.equal(
		planBulkAdmissionClaim({ ...base, existing: preparing, now: 60_999 })
			.status,
		"preparing",
	);
	const expired = planBulkAdmissionClaim({
		...base,
		existing: preparing,
		now: 61_000,
	});
	assert.equal(expired.status, "preparing");
	assert.equal(expired.record.jobId, "job_stable");
	assert.equal(expired.record.generation, 1);

	const queued = {
		...preparing,
		status: "queued" as const,
	};
	assert.equal(
		planBulkAdmissionClaim({ ...base, existing: queued, now: 90_000 }).status,
		"replay",
	);
	assert.equal(
		planBulkAdmissionClaim({
			...base,
			existing: queued,
			fingerprint: "changed",
			now: 90_000,
		}).status,
		"conflict",
	);
});

test("an opaque operation identity cannot cross actors", () => {
	const existing = {
		operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		actorUserId: "user-1",
		fingerprint: "fingerprint-1",
		jobId: "job_stable",
		total: 1,
		status: "preparing" as const,
		generation: 1,
		error: null,
		createdAt: 1_000,
		updatedAt: 1_000,
	};

	assert.equal(
		planBulkAdmissionClaim({
			existing,
			operationId: existing.operationId,
			actorUserId: "user-2",
			fingerprint: existing.fingerprint,
			total: existing.total,
			now: 2_000,
			createJobId: () => "must-not-run",
		}).status,
		"forbidden",
	);
});

test("recipient object key order does not change the bulk fingerprint", async () => {
	const common = {
		actorUserId: "user-1",
		subject: "Hello",
		text: "Hi",
	};
	const first = await bulkAdmissionFingerprint({
		...common,
		recipients: [{ email: "a@example.com", company: "Acme" }],
	});
	const reordered = await bulkAdmissionFingerprint({
		...common,
		recipients: [{ company: "Acme", email: "a@example.com" }],
	});
	const reorderedRows = await bulkAdmissionFingerprint({
		...common,
		recipients: [
			{ email: "b@example.com", company: "Beta" },
			{ email: "a@example.com", company: "Acme" },
		],
	});

	assert.equal(first, reordered);
	assert.notEqual(first, reorderedRows);
});

test("recipient enqueue retries transient failures and consumes only definitive missing attachments", () => {
	assert.equal(
		planBulkRecipientEnqueueDisposition("not_committed", new Error("R2 timeout")),
		"retry",
	);
	assert.equal(
		planBulkRecipientEnqueueDisposition(
			"not_committed",
			new BulkRecipientAttachmentUnavailableError("proposal.pdf"),
		),
		"definitive_failure",
	);
	assert.equal(
		planBulkRecipientEnqueueDisposition(
			"not_committed",
			new InlineImageMappingError("Message HTML is invalid."),
		),
		"definitive_failure",
	);
	assert.equal(
		planBulkRecipientEnqueueDisposition("committed", new Error("response lost")),
		"committed",
	);
	assert.equal(
		planBulkRecipientEnqueueDisposition("conflict", new Error("intent changed")),
		"definitive_failure",
	);
});
