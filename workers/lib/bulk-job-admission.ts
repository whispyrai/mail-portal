import { validateInlineImageMappings } from "../../shared/inline-image-mappings.ts";
import { escapeHtml } from "./email-helpers.ts";
import { InlineImageMappingError } from "./inline-image-authority.ts";

export const BULK_ADMISSION_LEASE_MS = 60_000;
export const BULK_PREPARATION_MAX_AGE_MS = 10 * 60_000;
export const BULK_STALE_WRITER_VERIFY_MS = 2 * BULK_PREPARATION_MAX_AGE_MS;
export const BULK_RESERVATION_TTL_MS = 10 * 60_000;

export const BULK_LIMITS = {
	requestBytes: 256 * 1_024,
	maxRecipients: 200,
	maxColumns: 50,
	columnNameChars: 64,
	recipientValueChars: 1_024,
	emailChars: 320,
	actorIdChars: 300,
	fromNameChars: 200,
	subjectChars: 998,
	bodyChars: 64 * 1_024,
	maxActiveJobs: 3,
	maxOutstandingRecipients: 400,
	maxAdmissionsPerUtcDay: 20,
	maxRecipientsPerUtcDay: 200,
	maxCleanupJobs: 100,
	maxPendingReservations: 20,
	maxPendingReservationsPerActor: 3,
	maxReservationRecords: 1_000,
	maxReservationsPerActorPerUtcDay: 40,
	maxReservationsPerUtcDay: 200,
	terminalRetentionMs: 30 * 24 * 60 * 60_000,
	cleanupLeaseMs: 60_000,
	recipientCleanupDelayMs: 10 * 60_000,
} as const;

export const BULK_JOB_ID_PATTERN =
	/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const BULK_OPERATION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BulkAdmissionRecord = {
	operationId: string;
	actorUserId: string;
	fingerprint: string;
	jobId: string;
	total: number;
	status: "preparing" | "queued" | "failed";
	generation: number;
	leaseExpiresAt: number | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
};

export type BulkAdmissionReservation = {
	operationId: string;
	actorUserId: string;
	fingerprint: string;
	total: number;
	createdAt: number;
	expiresAt: number;
};

export type BulkReservationResult =
	| { status: "reserved"; record: BulkAdmissionReservation; replayed: boolean }
	| { status: "admitted"; record: BulkAdmissionRecord }
	| { status: "capacity"; retryAt: number }
	| { status: "expired" }
	| { status: "conflict" }
	| { status: "forbidden" };

export type BulkEnqueueResult =
	| {
			status: "accepted";
			jobId: string;
			total: number;
			replayed: boolean;
			admissionStatus: "preparing" | "queued";
	  }
	| {
			status: "conflict";
			jobId: string;
			total: number;
	  }
	| {
			status: "rejected";
			code:
				| "invalid_bulk_request"
				| "bulk_admission_failed"
				| "bulk_reservation_expired";
			error: string;
			jobId?: string;
	  }
	| {
			status: "capacity";
			code: "bulk_capacity_reached";
			error: string;
			reason: "active_backlog" | "cleanup_backlog" | "daily_limit";
			retryAt: number;
	  };

export type BulkDailyAdmissionRecord = {
	utcDay: string;
	jobs: number;
	recipients: number;
};

export type BulkDailyReservationRecord = {
	utcDay: string;
	reservations: number;
};

export class BulkRecipientAttachmentUnavailableError extends Error {
	constructor(filename: string) {
		super(`Attachment "${filename}" is no longer available.`);
		this.name = "BulkRecipientAttachmentUnavailableError";
	}
}

export function bulkHtmlValidationError(html: string | undefined): string | null {
	if (html === undefined) return null;
	const result = validateInlineImageMappings(html, []);
	return result.ok ? null : result.error;
}

export function renderBulkTemplate(
	template: string,
	recipient: Readonly<Record<string, string>>,
	escapeValues: boolean,
): string {
	return template.replace(
		/\{\{\s*([\w.-]+)\s*\}\}/g,
		(_full, key: string) => {
			const value = recipient[key] ?? "";
			return escapeValues ? escapeHtml(value) : value;
		},
	);
}

export function bulkPersonalizedHtmlValidationError(
	html: string | undefined,
	recipients: ReadonlyArray<Readonly<Record<string, string>>>,
): string | null {
	if (html === undefined) return null;
	for (const recipient of recipients) {
		const error = bulkHtmlValidationError(
			renderBulkTemplate(html, recipient, true),
		);
		if (error) return error;
	}
	return null;
}

export function planBulkRecipientEnqueueDisposition(
	reconciliationStatus: "committed" | "not_committed",
	error: unknown,
): "committed" | "definitive_failure" | "retry" {
	if (reconciliationStatus === "committed") return "committed";
	return error instanceof BulkRecipientAttachmentUnavailableError ||
		error instanceof InlineImageMappingError
		? "definitive_failure"
		: "retry";
}

export function bulkUtcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

export function bulkNextUtcDayAt(now: number): number {
	const current = new Date(now);
	return Date.UTC(
		current.getUTCFullYear(),
		current.getUTCMonth(),
		current.getUTCDate() + 1,
	);
}

export function planBulkDailyAdmission(
	existing: BulkDailyAdmissionRecord | null,
	now: number,
	recipients: number,
):
	| { status: "accepted"; record: BulkDailyAdmissionRecord }
	| { status: "capacity" } {
	const utcDay = bulkUtcDay(now);
	const current =
		existing?.utcDay === utcDay ? existing : { utcDay, jobs: 0, recipients: 0 };
	if (
		current.jobs + 1 > BULK_LIMITS.maxAdmissionsPerUtcDay ||
		current.recipients + recipients > BULK_LIMITS.maxRecipientsPerUtcDay
	) {
		return { status: "capacity" };
	}
	return {
		status: "accepted",
		record: {
			utcDay,
			jobs: current.jobs + 1,
			recipients: current.recipients + recipients,
		},
	};
}

export function planBulkDailyReservation(
	existing: BulkDailyReservationRecord | null,
	now: number,
	limit: number = BULK_LIMITS.maxReservationsPerUtcDay,
):
	| { status: "accepted"; record: BulkDailyReservationRecord }
	| { status: "capacity" } {
	const utcDay = bulkUtcDay(now);
	const current =
		existing?.utcDay === utcDay
			? existing
			: { utcDay, reservations: 0 };
	if (current.reservations >= limit) {
		return { status: "capacity" };
	}
	return {
		status: "accepted",
		record: { utcDay, reservations: current.reservations + 1 },
	};
}

type BulkFingerprintInput = {
	actorUserId: string;
	subject: string;
	html?: string;
	text?: string;
	recipients: Record<string, string>[];
	attachmentUploadIds?: string[];
};

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export async function bulkAdmissionFingerprint(
	input: BulkFingerprintInput,
): Promise<string> {
	const canonical = stableJson({
		actorUserId: input.actorUserId,
		attachmentUploadIds: input.attachmentUploadIds ?? [],
		html: input.html ?? null,
		recipients: input.recipients,
		subject: input.subject,
		text: input.text ?? null,
	});
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function planBulkAdmissionReservation(input: {
	existingReservation: BulkAdmissionReservation | null;
	existingAdmission: BulkAdmissionRecord | null;
	operationId: string;
	actorUserId: string;
	fingerprint: string;
	total: number;
	now: number;
}): BulkReservationResult {
	const {
		existingReservation,
		existingAdmission,
		operationId,
		actorUserId,
		fingerprint,
		total,
		now,
	} = input;
	if (existingAdmission) {
		if (existingAdmission.actorUserId !== actorUserId) {
			return { status: "forbidden" };
		}
		if (
			existingAdmission.fingerprint !== fingerprint ||
			existingAdmission.total !== total
		) {
			return { status: "conflict" };
		}
		return { status: "admitted", record: existingAdmission };
	}
	if (existingReservation) {
		if (existingReservation.actorUserId !== actorUserId) {
			return { status: "forbidden" };
		}
		if (
			existingReservation.fingerprint !== fingerprint ||
			existingReservation.total !== total
		) {
			return { status: "conflict" };
		}
		if (existingReservation.expiresAt <= now) {
			return { status: "expired" };
		}
		return { status: "reserved", record: existingReservation, replayed: true };
	}
	return {
		status: "reserved",
		replayed: false,
		record: {
			operationId,
			actorUserId,
			fingerprint,
			total,
			createdAt: now,
			expiresAt: now + BULK_RESERVATION_TTL_MS,
		},
	};
}

export function bulkAttachmentPreparationKey(
	jobId: string,
	generation: number,
	index: number,
): string {
	return `bulk-attachments/${jobId}/generation-${generation}/${index}`;
}

export function ensureBulkQueueMembership(
	queue: readonly string[],
	jobId: string,
): string[] {
	return queue.includes(jobId) ? [...queue] : [...queue, jobId];
}

export function removeBulkQueueMembership(
	queue: readonly string[],
	jobId: string,
): string[] {
	return queue.filter((candidate) => candidate !== jobId);
}

export function planBulkAdmissionClaim(input: {
	existing: BulkAdmissionRecord | null;
	operationId: string;
	actorUserId: string;
	fingerprint: string;
	total: number;
	now: number;
	createJobId: () => string;
}):
	| { status: "claimed"; record: BulkAdmissionRecord }
	| { status: "preparing"; record: BulkAdmissionRecord }
	| { status: "replay"; record: BulkAdmissionRecord }
	| { status: "conflict"; record: BulkAdmissionRecord }
	| { status: "forbidden"; record: BulkAdmissionRecord }
	| { status: "failed"; record: BulkAdmissionRecord } {
	const { existing, operationId, fingerprint, total, now } = input;
	if (!existing) {
		return {
			status: "claimed",
				record: {
					operationId,
					actorUserId: input.actorUserId,
				fingerprint,
				jobId: input.createJobId(),
				total,
				status: "preparing",
				generation: 1,
				leaseExpiresAt: now + BULK_ADMISSION_LEASE_MS,
				error: null,
				createdAt: now,
				updatedAt: now,
			},
		};
	}
	if (existing.actorUserId !== input.actorUserId) {
		return { status: "forbidden", record: existing };
	}
	if (existing.fingerprint !== fingerprint || existing.total !== total) {
		return { status: "conflict", record: existing };
	}
	if (existing.status === "queued") {
		return { status: "replay", record: existing };
	}
	if (existing.status === "failed") {
		return { status: "failed", record: existing };
	}
	// Preparation is owned only by the Mailbox alarm. HTTP retries re-arm that
	// one bounded lane and can never create a concurrent R2 writer.
	return { status: "preparing", record: existing };
}

export function completeBulkAdmission(
	existing: BulkAdmissionRecord,
	generation: number,
	now: number,
): BulkAdmissionRecord | null {
	if (existing.status !== "preparing" || existing.generation !== generation) {
		return null;
	}
	return {
		...existing,
		status: "queued",
		leaseExpiresAt: null,
		updatedAt: now,
	};
}

export function failBulkAdmission(
	existing: BulkAdmissionRecord,
	generation: number,
	error: string,
	now: number,
): BulkAdmissionRecord | null {
	if (existing.status !== "preparing" || existing.generation !== generation) {
		return null;
	}
	return {
		...existing,
		status: "failed",
		leaseExpiresAt: null,
		error,
		updatedAt: now,
	};
}
