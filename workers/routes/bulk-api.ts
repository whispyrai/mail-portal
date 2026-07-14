import type { Context } from "hono";
import { z } from "zod";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import {
	bulkAdmissionFingerprint,
	bulkPersonalizedHtmlValidationError,
	BULK_JOB_ID_PATTERN,
	BULK_LIMITS,
	BULK_OPERATION_ID_PATTERN,
} from "../lib/bulk-job-admission.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

const BulkRecipient = z
	.record(
		z.string().trim().min(1).max(BULK_LIMITS.columnNameChars),
		z.string().max(BULK_LIMITS.recipientValueChars),
	)
	.superRefine((recipient, context) => {
		if (Object.keys(recipient).length > BULK_LIMITS.maxColumns) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Each recipient can have at most ${BULK_LIMITS.maxColumns} columns.`,
			});
		}
		if (
			typeof recipient.email !== "string" ||
			recipient.email.length > BULK_LIMITS.emailChars
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Every recipient needs a bounded email value.",
			});
		}
	});

const BulkSendBody = z
	.object({
		operationId: z.string().uuid(),
		subject: z.string().min(1).max(BULK_LIMITS.subjectChars),
		html: z.string().max(BULK_LIMITS.bodyChars).optional(),
		text: z.string().max(BULK_LIMITS.bodyChars).optional(),
		recipients: z.array(BulkRecipient).min(1).max(BULK_LIMITS.maxRecipients),
		attachmentUploadIds: z
			.array(z.string().uuid())
			.max(ATTACHMENT_LIMITS.maxFiles)
			.optional(),
	})
	.strict();

class BulkRequestTooLargeError extends Error {}

function logBulkRoute(
	level: "info" | "warn" | "error",
	event: Record<string, unknown>,
): void {
	console[level]("[bulk-send] route completed", event);
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (
			Number.isFinite(parsedLength) &&
			parsedLength > BULK_LIMITS.requestBytes
		) {
			throw new BulkRequestTooLargeError();
		}
	}
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > BULK_LIMITS.requestBytes) {
				await reader.cancel().catch(() => undefined);
				throw new BulkRequestTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

export async function handleReserveBulkOperation(c: AppContext) {
	const startedAt = Date.now();
	const mailboxId = c.req.param("mailboxId") ?? "";
	const operationId = c.req.param("operationId") ?? "";
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (!BULK_OPERATION_ID_PATTERN.test(operationId)) {
		return c.json({ error: "Bulk operation not found" }, 404);
	}

	let payload: unknown;
	try {
		payload = await boundedJsonBody(c.req.raw);
	} catch (error) {
		const tooLarge = error instanceof BulkRequestTooLargeError;
		logBulkRoute("warn", {
			operation: "bulk_reservation",
			route: "reserve",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: "validation_failure",
			errorCode: tooLarge ? "bulk_request_too_large" : "malformed_json",
			httpStatus: tooLarge ? 413 : 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: tooLarge
					? `Bulk request exceeds the ${BULK_LIMITS.requestBytes / 1_024} KB limit.`
					: "Invalid bulk request: malformed JSON",
				code: tooLarge ? "bulk_request_too_large" : "invalid_bulk_request",
			},
			tooLarge ? 413 : 400,
		);
	}
	const parsed = BulkSendBody.safeParse(payload);
	const htmlError = parsed.success
		? bulkPersonalizedHtmlValidationError(
				parsed.data.html,
				parsed.data.recipients,
			)
		: null;
	if (
		!parsed.success ||
		parsed.data.operationId !== operationId ||
		(!parsed.data.html && !parsed.data.text) ||
		htmlError
	) {
		logBulkRoute("warn", {
			operation: "bulk_reservation",
			route: "reserve",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: "validation_failure",
			errorCode: "invalid_bulk_request",
			httpStatus: 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: htmlError
					? `Invalid bulk reservation request: ${htmlError}`
					: "Invalid bulk reservation request.",
				code: "invalid_bulk_request",
			},
			400,
		);
	}

	try {
		const fingerprint = await bulkAdmissionFingerprint({
			actorUserId: session.sub,
			subject: parsed.data.subject,
			html: parsed.data.html,
			text: parsed.data.text,
			recipients: parsed.data.recipients,
			attachmentUploadIds: parsed.data.attachmentUploadIds,
		});
		const result = await c.var.mailboxStub.reserveBulkOperation({
			operationId,
			actorUserId: session.sub,
			fingerprint,
			total: parsed.data.recipients.length,
		});
		if (result.status === "admitted") {
			logBulkRoute("info", {
				operation: "bulk_reservation",
				route: "reserve",
				mailboxId,
				actorUserId: session.sub,
				operationId,
				jobId: result.record.jobId,
				result: "admitted_replay",
				httpStatus: 200,
				durationMs: Date.now() - startedAt,
			});
			return c.json({
				state: "admitted",
				jobId: result.record.jobId,
				total: result.record.total,
				admissionStatus: result.record.status,
			});
		}
		if (result.status === "reserved") {
			logBulkRoute("info", {
				operation: "bulk_reservation",
				route: "reserve",
				mailboxId,
				actorUserId: session.sub,
				operationId,
				result: result.replayed ? "replayed" : "created",
				httpStatus: 202,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					state: "reserved",
					expiresAt: new Date(result.record.expiresAt).toISOString(),
				},
				202,
			);
		}
		if (result.status === "capacity") {
			const retrySeconds = Math.max(
				1,
				Math.min(86_400, Math.ceil((result.retryAt - Date.now()) / 1_000)),
			);
			c.header("Retry-After", String(retrySeconds));
			logBulkRoute("info", {
				operation: "bulk_reservation",
				route: "reserve",
				mailboxId,
				actorUserId: session.sub,
				operationId,
				result: "capacity",
				retryDecision: "retry_after",
				httpStatus: 429,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error: "This Mailbox has too many pending bulk confirmations. Retry later.",
					code: "bulk_reservation_capacity",
					retryAt: new Date(result.retryAt).toISOString(),
				},
				429,
			);
		}
		const httpStatus =
			result.status === "expired"
				? 410
				: result.status === "conflict"
					? 409
					: 404;
		logBulkRoute("warn", {
			operation: "bulk_reservation",
			route: "reserve",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: result.status,
			httpStatus,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error:
					result.status === "expired"
						? "This bulk operation reservation expired. Start a new submission."
						: "Bulk operation is unavailable.",
				code:
					result.status === "expired"
						? "bulk_reservation_expired"
						: "bulk_reservation_unavailable",
			},
			httpStatus,
		);
	} catch (error) {
		logBulkRoute("error", {
			operation: "bulk_reservation",
			route: "reserve",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: "unconfirmed",
			errorName: error instanceof Error ? error.name : "UnknownError",
			retryDecision: "recover",
			httpStatus: 503,
			durationMs: Date.now() - startedAt,
		});
		c.header("Retry-After", "3");
		return c.json(
			{
				error: "The bulk reservation outcome could not be confirmed.",
				code: "bulk_reservation_unconfirmed",
			},
			503,
		);
	}
}

export async function handleCancelBulkReservation(c: AppContext) {
	const startedAt = Date.now();
	const mailboxId = c.req.param("mailboxId") ?? "";
	const operationId = c.req.param("operationId") ?? "";
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (!BULK_OPERATION_ID_PATTERN.test(operationId)) {
		return c.json({ error: "Bulk operation not found" }, 404);
	}
	try {
		const result = await c.var.mailboxStub.cancelBulkReservation(
			operationId,
			session.sub,
		);
		const unavailable = result.status === "forbidden";
		logBulkRoute(unavailable ? "warn" : "info", {
			operation: "bulk_reservation_cancel",
			route: "cancel-reservation",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			jobId: result.status === "admitted" ? result.jobId : undefined,
			result: unavailable ? "unavailable" : result.status,
			httpStatus: unavailable ? 404 : 200,
			durationMs: Date.now() - startedAt,
		});
		return unavailable
			? c.json({ error: "Bulk operation not found" }, 404)
			: c.json(result);
	} catch (error) {
		logBulkRoute("error", {
			operation: "bulk_reservation_cancel",
			route: "cancel-reservation",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: "failure",
			errorName: error instanceof Error ? error.name : "UnknownError",
			retryDecision: "recover",
			httpStatus: 503,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{ error: "Bulk reservation cancellation is temporarily unavailable." },
			503,
		);
	}
}

export async function handleCreateBulkJob(c: AppContext) {
	const startedAt = Date.now();
	const mailboxId = c.req.param("mailboxId") ?? "";
	const session = c.get("session");
	if (!session) {
		logBulkRoute("warn", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			result: "unauthorized",
			httpStatus: 401,
			durationMs: Date.now() - startedAt,
		});
		return c.json({ error: "Unauthorized" }, 401);
	}

	let payload: unknown;
	try {
		payload = await boundedJsonBody(c.req.raw);
	} catch (error) {
		if (error instanceof BulkRequestTooLargeError) {
			logBulkRoute("warn", {
				operation: "bulk_admission",
				route: "create",
				mailboxId,
				actorUserId: session.sub,
				result: "validation_failure",
				errorCode: "bulk_request_too_large",
				httpStatus: 413,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error: `Bulk request exceeds the ${BULK_LIMITS.requestBytes / 1_024} KB limit.`,
					code: "bulk_request_too_large",
				},
				413,
			);
		}
		logBulkRoute("warn", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			result: "validation_failure",
			errorCode: "malformed_json",
			httpStatus: 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: "Invalid bulk request: malformed JSON",
				code: "invalid_bulk_request",
			},
			400,
		);
	}
	const parsed = BulkSendBody.safeParse(payload);
	if (!parsed.success) {
		logBulkRoute("warn", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			result: "validation_failure",
			errorCode: "invalid_bulk_request",
			httpStatus: 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: `Invalid bulk request: ${parsed.error.issues[0]?.message ?? "Invalid request"}`,
				code: "invalid_bulk_request",
			},
			400,
		);
	}
	if (!parsed.data.html && !parsed.data.text) {
		logBulkRoute("warn", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			operationId: parsed.data.operationId,
			result: "validation_failure",
			errorCode: "missing_body",
			httpStatus: 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: "Provide an HTML or text body.",
				code: "invalid_bulk_request",
			},
			400,
		);
	}
	const htmlError = bulkPersonalizedHtmlValidationError(
		parsed.data.html,
		parsed.data.recipients,
	);
	if (htmlError) {
		logBulkRoute("warn", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			operationId: parsed.data.operationId,
			result: "validation_failure",
			errorCode: "invalid_bulk_html",
			httpStatus: 400,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				error: `Invalid bulk request: ${htmlError}`,
				code: "invalid_bulk_request",
			},
			400,
		);
	}

	try {
		const settingsObject = await c.env.BUCKET.get(
			`mailboxes/${mailboxId}.json`,
		);
		const settings = settingsObject
			? await settingsObject.json<{ fromName?: string }>()
			: {};
		const fromName = settings.fromName || mailboxId.split("@")[0];
		const result = await c.var.mailboxStub.enqueueBulkJob({
			operationId: parsed.data.operationId,
			actorUserId: session.sub,
			fromEmail: mailboxId,
			fromName,
			subject: parsed.data.subject,
			html: parsed.data.html,
			text: parsed.data.text,
			recipients: parsed.data.recipients,
			attachmentUploadIds: parsed.data.attachmentUploadIds,
		});
		if (result.status === "conflict") {
			logBulkRoute("warn", {
				operation: "bulk_admission",
				route: "create",
				mailboxId,
				actorUserId: session.sub,
				operationId: parsed.data.operationId,
				jobId: result.jobId,
				result: "conflict",
				httpStatus: 409,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error:
						"This bulk operation identity was already used for different content.",
					code: "bulk_admission_conflict",
					jobId: result.jobId,
				},
				409,
			);
		}
		if (result.status === "rejected") {
			const rejectedStatus =
				result.code === "bulk_reservation_expired" ? 410 : 400;
			logBulkRoute("warn", {
				operation: "bulk_admission",
				route: "create",
				mailboxId,
				actorUserId: session.sub,
				operationId: parsed.data.operationId,
				jobId: result.jobId,
				result: "rejected",
				errorCode: result.code,
				httpStatus: rejectedStatus,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error: result.error,
					code: result.code,
					...(result.jobId ? { jobId: result.jobId } : {}),
				},
				rejectedStatus,
			);
		}
		if (result.status === "capacity") {
			const retrySeconds = Math.max(
				1,
				Math.min(86_400, Math.ceil((result.retryAt - Date.now()) / 1_000)),
			);
			c.header("Retry-After", String(retrySeconds));
			logBulkRoute("info", {
				operation: "bulk_admission",
				route: "create",
				mailboxId,
				actorUserId: session.sub,
				operationId: parsed.data.operationId,
				result: "capacity",
				reason: result.reason,
				retryDecision: "retry_after",
				httpStatus: 429,
				durationMs: Date.now() - startedAt,
			});
			return c.json(
				{
					error: result.error,
					code: result.code,
					reason: result.reason,
					retryAt: new Date(result.retryAt).toISOString(),
				},
				429,
			);
		}
		logBulkRoute("info", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			operationId: parsed.data.operationId,
			jobId: result.jobId,
			result: "completed",
			admissionStatus: result.admissionStatus,
			replayed: result.replayed,
			httpStatus: 202,
			durationMs: Date.now() - startedAt,
		});
		return c.json(
			{
				jobId: result.jobId,
				total: result.total,
				replayed: result.replayed,
				admissionStatus: result.admissionStatus,
			},
			202,
		);
	} catch (error) {
		logBulkRoute("error", {
			operation: "bulk_admission",
			route: "create",
			mailboxId,
			actorUserId: session.sub,
			operationId: parsed.data.operationId,
			result: "unconfirmed",
			errorCode: "bulk_admission_unconfirmed",
			errorName: error instanceof Error ? error.name : "UnknownError",
			retryDecision: "exact_retry",
			httpStatus: 503,
			durationMs: Date.now() - startedAt,
		});
		c.header("Retry-After", "3");
		return c.json(
			{
				error:
					"The bulk job outcome could not be confirmed. Retry this exact submission safely.",
				code: "bulk_admission_unconfirmed",
			},
			503,
		);
	}
}

export async function handleRecoverBulkOperation(c: AppContext) {
	const startedAt = Date.now();
	const mailboxId = c.req.param("mailboxId") ?? "";
	const operationId = c.req.param("operationId") ?? "";
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (!BULK_OPERATION_ID_PATTERN.test(operationId)) {
		return c.json({ error: "Bulk operation not found" }, 404);
	}
	try {
		const recovered = await c.var.mailboxStub.getBulkJobByOperation(
			operationId,
			session.sub,
		);
		logBulkRoute("info", {
			operation: "bulk_operation_recovery",
			route: "recover",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			jobId: recovered?.state === "admitted" ? recovered.jobId : undefined,
			result: recovered?.state ?? "miss",
			httpStatus:
				recovered?.state === "reserved"
					? 202
					: recovered?.state === "expired"
						? 410
						: recovered
							? 200
							: 404,
			durationMs: Date.now() - startedAt,
		});
		if (!recovered) return c.json({ error: "Bulk operation not found" }, 404);
		if (recovered.state === "reserved") {
			return c.json(
				{
					state: "reserved",
					expiresAt: new Date(recovered.expiresAt).toISOString(),
				},
				202,
			);
		}
		if (recovered.state === "expired") {
			return c.json(
				{
					error: "Bulk operation reservation expired.",
					code: "bulk_reservation_expired",
				},
				410,
			);
		}
		return c.json(recovered);
	} catch (error) {
		logBulkRoute("error", {
			operation: "bulk_operation_recovery",
			route: "recover",
			mailboxId,
			actorUserId: session.sub,
			operationId,
			result: "failure",
			errorName: error instanceof Error ? error.name : "UnknownError",
			httpStatus: 503,
			durationMs: Date.now() - startedAt,
		});
		c.header("Retry-After", "3");
		return c.json(
			{ error: "Bulk operation recovery is temporarily unavailable." },
			503,
		);
	}
}

export async function handleGetBulkJob(c: AppContext) {
	const jobId = c.req.param("jobId") ?? "";
	if (!BULK_JOB_ID_PATTERN.test(jobId)) {
		return c.json({ error: "Job not found" }, 404);
	}
	const job = await c.var.mailboxStub.getBulkJob(jobId);
	return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
}
