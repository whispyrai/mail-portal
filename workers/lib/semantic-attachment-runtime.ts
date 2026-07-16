import { attachmentKey } from "./attachments.ts";
import {
	SemanticAttachmentExtractionError,
	extractSemanticAttachmentText,
	semanticAttachmentAdmission,
	semanticAttachmentFingerprint,
	semanticAttachmentText,
} from "./semantic-attachment.ts";
import {
	SemanticRichDocumentProviderError,
	type SemanticRichDocumentConverter,
} from "./semantic-attachment-converter.ts";
import { preflightSemanticRichDocument } from "./semantic-rich-document.ts";
import type {
	SemanticAttachmentExtractionCompletion,
	SemanticAttachmentExtractionLease,
} from "./semantic-index.ts";

// Head, conditional get, and body read each have a 10-second budget. The lease
// also needs room for hashing and the fenced Durable Object commit.
const LEASE_MS = 90_000;
const R2_TIMEOUT_MS = 10_000;
const CONVERSION_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 30_000;

type SemanticR2Head = {
	size: number;
	version: string;
	etag: string;
};

type SemanticR2Object = SemanticR2Head & {
	arrayBuffer(): Promise<ArrayBuffer>;
};

export type SemanticAttachmentRuntimeMailbox = {
	leaseSemanticAttachmentExtraction(
		leaseToken: string,
		nowMs: number,
		leaseMs: number,
	): Promise<SemanticAttachmentExtractionLease | null>;
	completeSemanticAttachmentExtraction(
		completion: SemanticAttachmentExtractionCompletion,
	): Promise<boolean>;
	rejectSemanticAttachmentExtraction(input: {
		attachmentId: string;
		leaseToken: string;
		rejectedAt: number;
		errorCode: string;
		terminal: boolean;
	}): Promise<boolean>;
	retrySemanticAttachmentExtraction(input: {
		attachmentId: string;
		leaseToken: string;
		failedAt: number;
		nextAttemptAt: number;
		errorCode: string;
	}): Promise<boolean>;
};

export type SemanticAttachmentRuntimeBucket = {
	head(key: string): Promise<SemanticR2Head | null>;
	get(key: string, etag: string): Promise<SemanticR2Object | null>;
};

function bounded<T>(work: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Semantic attachment R2 operation timed out")),
			R2_TIMEOUT_MS,
		);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function runtimeErrorCode(error: unknown): string {
	if (error instanceof SemanticRichDocumentProviderError) return error.code;
	if (error instanceof SemanticConversionTimeoutError) return "conversion_timeout";
	if (error instanceof Error && error.name) {
		return `r2_${error.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 64);
	}
	return "r2_error";
}

class SemanticConversionTimeoutError extends Error {
	constructor() {
		super("Semantic attachment conversion timed out");
		this.name = "SemanticConversionTimeoutError";
	}
}

function boundedConversion(work: Promise<string>): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new SemanticConversionTimeoutError()),
			CONVERSION_TIMEOUT_MS,
		);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(
					error instanceof SemanticAttachmentExtractionError ||
						error instanceof SemanticRichDocumentProviderError
						? error
						: new SemanticRichDocumentProviderError("provider_error"),
				);
			},
		);
	});
}

export async function advanceSemanticAttachmentExtraction(input: {
	mailbox: SemanticAttachmentRuntimeMailbox;
	bucket: SemanticAttachmentRuntimeBucket;
	converter?: SemanticRichDocumentConverter;
	now?: () => number;
	createLeaseToken?: () => string;
}): Promise<boolean> {
	const now = input.now ?? Date.now;
	const createLeaseToken = input.createLeaseToken ?? (() => crypto.randomUUID());
	const lease = await input.mailbox.leaseSemanticAttachmentExtraction(
		createLeaseToken(),
		now(),
		LEASE_MS,
	);
	if (!lease) return false;
	const admission = semanticAttachmentAdmission(lease.filename, lease.mimetype);
	if (!admission) {
		await input.mailbox.rejectSemanticAttachmentExtraction({
			attachmentId: lease.attachmentId,
			leaseToken: lease.leaseToken,
			rejectedAt: now(),
			errorCode: "unsupported_format",
			terminal: false,
		});
		return true;
	}
	const fail = (error: unknown) => input.mailbox.retrySemanticAttachmentExtraction({
		attachmentId: lease.attachmentId,
		leaseToken: lease.leaseToken,
		failedAt: now(),
		nextAttemptAt: now() + Math.min(
			RETRY_DELAY_MS * 2 ** Math.max(lease.attemptCount - 1, 0),
			15 * 60 * 1_000,
		),
		errorCode: runtimeErrorCode(error),
	});

	try {
		const key = lease.r2Key ?? attachmentKey(
			lease.messageId,
			lease.attachmentId,
			lease.filename,
		);
		const head = await bounded(input.bucket.head(key));
		if (!head) {
			await fail(new Error("missing_object"));
			return true;
		}
		if (head.size !== lease.declaredSize || head.size > admission.maxBytes) {
			await input.mailbox.rejectSemanticAttachmentExtraction({
				attachmentId: lease.attachmentId,
				leaseToken: lease.leaseToken,
				rejectedAt: now(),
				errorCode: head.size > admission.maxBytes ? "size_exceeded" : "size_mismatch",
				terminal: head.size !== lease.declaredSize,
			});
			return true;
		}
		const object = await bounded(input.bucket.get(key, head.etag));
		if (
			!object ||
			object.version !== head.version ||
			object.etag !== head.etag ||
			object.size !== head.size
		) {
			await fail(new Error("object_changed"));
			return true;
		}
		const bytes = await bounded(object.arrayBuffer());
		if (bytes.byteLength !== object.size) {
			await input.mailbox.rejectSemanticAttachmentExtraction({
				attachmentId: lease.attachmentId,
				leaseToken: lease.leaseToken,
				rejectedAt: now(),
				errorCode: "size_mismatch",
				terminal: true,
			});
			return true;
		}
		let extracted: { format: typeof admission.format; text: string };
		if (admission.kind === "direct") {
			extracted = extractSemanticAttachmentText({
				filename: lease.filename,
				mimetype: lease.mimetype,
				declaredSize: lease.declaredSize,
				bytes,
			});
		} else {
			await preflightSemanticRichDocument({ format: admission.format, bytes });
			if (!input.converter) {
				throw new SemanticRichDocumentProviderError("provider_error");
			}
			extracted = {
				format: admission.format,
				text: semanticAttachmentText(
					await boundedConversion(
						input.converter.convert({
							filename: lease.filename,
							mimetype: admission.mimetype,
							format: admission.format,
							bytes,
						}),
					),
				),
			};
		}
		const fingerprint = await semanticAttachmentFingerprint({
			bytes,
			format: extracted.format,
		});
		await input.mailbox.completeSemanticAttachmentExtraction({
			attachmentId: lease.attachmentId,
			messageId: lease.messageId,
			attachmentVersion: lease.attachmentVersion,
			leaseToken: lease.leaseToken,
			completedAt: now(),
			byteSha256: fingerprint.byteSha256,
			sourceFingerprint: fingerprint.sourceFingerprint,
			r2Version: object.version,
			r2Etag: object.etag,
			actualSize: object.size,
			text: extracted.text,
		});
		return true;
	} catch (error) {
		if (error instanceof SemanticAttachmentExtractionError) {
			await input.mailbox.rejectSemanticAttachmentExtraction({
				attachmentId: lease.attachmentId,
				leaseToken: lease.leaseToken,
				rejectedAt: now(),
				errorCode: error.code,
				terminal: error.code === "size_mismatch",
			});
			return true;
		}
		await fail(error);
		return true;
	}
}
