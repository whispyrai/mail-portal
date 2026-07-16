// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { mailTelemetryLogRef } from "./mail-telemetry.ts";
import { extractThreadTokens } from "./thread-token.ts";
import {
	attachmentKey,
	attachmentKeyPrefix,
	type StoredAttachment,
} from "./attachments.ts";
import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";
import type { RecipientMemoryOrigin } from "../../shared/recipient-suggestions.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";
import { normalizeObservedSenderName } from "./people/index.ts";
import type { PushPayload } from "./push/types.ts";
import {
	MAX_INBOUND_EMAIL_BYTES,
	type InboundDerivedContentManifest,
	type InboundDerivedContentRepairAttemptIdentity,
	type InboundDerivedContentRepairAttemptTerminal,
	type InboundDerivedContentRepairCommand,
	type InboundDerivedContentRepairResult,
	type InboundProjectionCommand,
	type InboundProjectionResult,
	type StoredEmailBodyObject,
} from "./inbound-projection-contract.ts";
import type { InboundDerivedContentCleanupInput } from "./inbound-derived-content-cleanup.ts";

export const MAX_EMAIL_SIZE = MAX_INBOUND_EMAIL_BYTES;

type StoredEmail = {
	id: string;
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	read?: boolean;
	body: string;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string;
	message_id: string | null;
	raw_headers: string;
	recipient_memory_origin: RecipientMemoryOrigin;
	/** Exact live RFC/token thread identity allowed to wake Snoozed mail. */
	snooze_wake_thread_id: string | null;
	follow_up_reply_mailbox_address: string | null;
	automation_trigger?: "live_inbound";
	push_notification?: PushPayload;
};

export type { StoredEmailBodyObject } from "./inbound-projection-contract.ts";

type AttachmentBucket = {
  put(
    key: string,
		value: ArrayBuffer | string | ReadableStream,
	): Promise<unknown>;
	delete(key: string | string[]): Promise<unknown>;
	createMultipartUpload?(key: string): Promise<MultipartUpload>;
};

type UploadedPart = {
	partNumber: number;
	etag: string;
};

type MultipartUpload = {
	uploadPart(partNumber: number, value: ArrayBuffer): Promise<UploadedPart>;
	abort(): Promise<void>;
	complete(parts: UploadedPart[]): Promise<unknown>;
};

const R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return Boolean(
		value &&
		typeof value === "object" &&
		"getReader" in value &&
		typeof value.getReader === "function",
	);
}

async function putUnknownLengthStream(
	bucket: AttachmentBucket,
	key: string,
	stream: ReadableStream<Uint8Array>,
	expectedSize: number | (() => number),
): Promise<unknown> {
	if (!bucket.createMultipartUpload) return bucket.put(key, stream);

	let multipart: MultipartUpload | null = null;
	const reader = stream.getReader();
	try {
		multipart = await bucket.createMultipartUpload(key);
		const parts: UploadedPart[] = [];
		let partNumber = 1;
		let buffer = new Uint8Array(R2_MULTIPART_PART_BYTES);
		let bufferedBytes = 0;
		let totalBytes = 0;

		while (true) {
			const result = await reader.read();
			if (result.done) break;
			let offset = 0;
			while (offset < result.value.byteLength) {
				const copiedBytes = Math.min(
					buffer.byteLength - bufferedBytes,
					result.value.byteLength - offset,
				);
				buffer.set(
					result.value.subarray(offset, offset + copiedBytes),
					bufferedBytes,
				);
				bufferedBytes += copiedBytes;
				offset += copiedBytes;
				totalBytes += copiedBytes;
				if (bufferedBytes === buffer.byteLength) {
					parts.push(await multipart.uploadPart(partNumber++, buffer.buffer));
					buffer = new Uint8Array(R2_MULTIPART_PART_BYTES);
					bufferedBytes = 0;
				}
			}
		}

		const finalExpectedSize =
			typeof expectedSize === "function" ? expectedSize() : expectedSize;
		if (totalBytes !== finalExpectedSize) {
			throw Object.assign(
				new Error(
					`Decoded stream produced ${totalBytes} bytes; expected ${finalExpectedSize}`,
				),
				{ code: "R2_DERIVED_UPLOAD_INTEGRITY_FAILED" },
			);
		}

		if (bufferedBytes > 0) {
			parts.push(
				await multipart.uploadPart(
					partNumber,
					buffer.buffer.slice(0, bufferedBytes),
				),
			);
		}
		if (parts.length === 0) {
			await multipart.abort();
			multipart = null;
			return bucket.put(key, new ArrayBuffer(0));
		}
		const completed = await multipart.complete(parts);
		multipart = null;
		return completed;
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		if (multipart) {
			try {
				await multipart.abort();
			} catch {
				console.error("[mail-store] multipart upload abort failed", {
					errorCode: "R2_MULTIPART_ABORT_FAILED",
					operation: "derived_object_upload_abort",
					status: "degraded",
				});
			}
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export type MailboxEmailStore = {
	createEmail(
		folder: string,
		email: StoredEmail,
		attachments: StoredAttachment[],
		actor?: undefined,
		mailboxAddress?: string,
	): Promise<unknown>;
	createInboundEmail?(
		command: InboundProjectionCommand,
	): Promise<InboundProjectionResult>;
	resolveCanonicalThreadId(messageIds: string[]): Promise<string | null>;
	getEmail(id: string): Promise<unknown | null>;
	hasEmail?(id: string): Promise<boolean>;
	isEmailDeleted?(id: string): Promise<boolean>;
	recordInboundTerminalFailure?(input: {
		id: string;
		queueRef: string;
		attempts: number;
		errorCode: "QUEUE_RETRY_EXHAUSTED";
	}): Promise<"deleted" | "ledgered" | "stored">;
	getInboundTerminalFailure?(id: string): Promise<{
		queueRef: string;
		attempts: number;
		errorCode: "QUEUE_RETRY_EXHAUSTED";
		recordedAt: string;
	} | null>;
	getInboundDerivedContentManifest?(
		id: string,
	): Promise<InboundDerivedContentManifest>;
	repairInboundDerivedContent?(
		command: InboundDerivedContentRepairCommand,
	): Promise<InboundDerivedContentRepairResult>;
	finalizeInboundDerivedContentRepairAttempt?(
		identity: InboundDerivedContentRepairAttemptIdentity,
	): Promise<InboundDerivedContentRepairAttemptTerminal>;
	enqueueUnownedInboundDerivedContentCleanup?(
		input: InboundDerivedContentCleanupInput,
	): Promise<{ queued: number; retained: number; absent: number }>;
};

export type EmailStorageDependencies = {
  bucket: AttachmentBucket;
  mailbox: MailboxEmailStore;
};

export function assertR2DerivedUploadSize(
	result: unknown,
	expectedSize: number,
): void {
	const actualSize =
		result &&
		typeof result === "object" &&
		"size" in result &&
		typeof result.size === "number"
			? result.size
			: null;
	if (actualSize !== expectedSize) {
		throw Object.assign(
			new Error(
				actualSize === null
					? "R2 did not return verifiable object metadata"
					: `R2 stored ${actualSize} bytes; expected ${expectedSize}`,
			),
			{ code: "R2_DERIVED_UPLOAD_INTEGRITY_FAILED" },
		);
	}
}

export async function putVerifiedEmailObject(
	dependencies: EmailStorageDependencies,
	input: {
		key: string;
		value: ArrayBuffer | string | ReadableStream;
		expectedSize: number | (() => number);
		messageId: string;
		objectType: "attachment" | "body";
	},
): Promise<void> {
	const startedAt = Date.now();
	const objectType = input.objectType === "attachment" ? "attachment" : "body";
	const [messageRef, objectRef] = await Promise.all([
		mailTelemetryLogRef("message", input.messageId),
		mailTelemetryLogRef("object", input.key),
	]);
	console.log("[mail-store] derived object upload started", {
		messageRef,
		objectRef,
		objectType,
		operation: "derived_object_upload",
		status: "started",
	});
	try {
		const result = isReadableStream(input.value)
			? await putUnknownLengthStream(
					dependencies.bucket,
					input.key,
					input.value,
					input.expectedSize,
				)
			: await dependencies.bucket.put(input.key, input.value);
		const expectedSize = Number(
			typeof input.expectedSize === "function"
				? input.expectedSize()
				: input.expectedSize,
		);
		assertR2DerivedUploadSize(result, expectedSize);
			console.log("[mail-store] derived object upload completed", {
				byteLength: expectedSize,
				durationMs: Date.now() - startedAt,
				messageRef,
				objectRef,
			objectType,
			operation: "derived_object_upload",
			status: "succeeded",
		});
	} catch (error) {
		console.error("[mail-store] derived object upload failed", {
			durationMs: Date.now() - startedAt,
			errorCode:
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "R2_DERIVED_UPLOAD_INTEGRITY_FAILED"
					? "R2_DERIVED_UPLOAD_INTEGRITY_FAILED"
					: "R2_DERIVED_UPLOAD_FAILED",
				messageRef,
				objectRef,
			objectType,
			operation: "derived_object_upload",
			status: "failed",
		});
		throw error;
	}
}

export async function emailExists(
	mailbox: MailboxEmailStore,
	id: string,
): Promise<boolean> {
	return mailbox.hasEmail
		? mailbox.hasEmail(id)
		: Boolean(await mailbox.getEmail(id));
}

export function isEmailDeletedDuringProjection(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "EMAIL_DELETED_DURING_PROJECTION",
	);
}

export function isEmailTerminalDuringProjection(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EMAIL_TERMINAL_DURING_PROJECTION",
  );
}

export interface StoredEmailSignal {
	conversationKey: string;
	inboundMessageId: string;
	inboundMessageDate: string;
}

export type StoreEmailProjectionOptions = {
	folder: string;
	date: string;
	messageId: string;
	read?: boolean;
	threadId?: string;
	wakeSnoozedOnReply?: boolean;
	followUpMailboxAddress?: string;
	mailboxAddress?: string;
	recipientMemoryOrigin: RecipientMemoryOrigin;
	pushNotification?: PushPayload;
	pushNotificationFor?: (parsed: Email) => PushPayload;
	/** Explicit authority to capture an immutable inbound Automation run. */
	automationTrigger?: "live_inbound";
	/** Optional write-generation fence for import-only attachment identities. */
	attachmentIdNamespace?: string;
	allowTerminalRecovery?: boolean;
};

type StoreParsedEmailOptions = StoreEmailProjectionOptions;

export class InboundProjectionOutcomeError extends Error {
	readonly projectionResult: InboundProjectionResult;
	readonly projectionStatus: Exclude<
		InboundProjectionResult["status"],
		"duplicate" | "stored"
	>;

	constructor(projectionResult: InboundProjectionResult) {
		const projectionStatus = projectionResult.status as Exclude<
			InboundProjectionResult["status"],
			"duplicate" | "stored"
		>;
		const details = {
			cleanup_conflict: {
				code: "INBOUND_DERIVED_CONTENT_CLEANUP_CONFLICT",
				message: "Derived content deletion already started; retry projection",
			},
			deleted: {
				code: "EMAIL_DELETED_DURING_PROJECTION",
				message: "Email was deleted while its projection was in flight",
			},
			terminal: {
				code: "EMAIL_TERMINAL_DURING_PROJECTION",
				message: "Inbound delivery is already terminal",
			},
		}[projectionStatus];
		super(details.message);
		this.name = "InboundProjectionOutcomeError";
		this.projectionResult = projectionResult;
		this.projectionStatus = projectionStatus;
		Object.assign(this, { code: details.code });
	}
}

function validatedInboundProjectionResult(
	value: unknown,
): InboundProjectionResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Mailbox inbound projection response is invalid");
	}
	const result = value as Record<string, unknown>;
	if (
		!(["cleanup_conflict", "deleted", "duplicate", "stored", "terminal"] as const)
			.includes(result.status as never) ||
		!(result.cleanupKeys === undefined ||
			(Array.isArray(result.cleanupKeys) &&
				result.cleanupKeys.every((key) => typeof key === "string")))
	) {
		throw new Error("Mailbox inbound projection response is invalid");
	}
	return {
		status: result.status as InboundProjectionResult["status"],
		...(result.cleanupKeys === undefined
			? {}
			: { cleanupKeys: [...(result.cleanupKeys as string[])] }),
	};
}

function messageIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const bracketed = Array.from(
    value.matchAll(/<([^>]+)>/g),
    (match) => match[1],
  ).filter((messageId): messageId is string => Boolean(messageId));
  return bracketed.length > 0
    ? bracketed
    : value.trim().split(/\s+/).filter(Boolean);
}

function addresses(entries: Email["to"]): string[] {
  return (entries ?? []).flatMap((entry) =>
    entry.address ? [entry.address.toLowerCase()] : [],
  );
}

function boundedRfcThreadCandidates(
	references: string[],
	inReplyTo: string | null,
): string[] {
	const root = references[0];
	const recent = references.slice(-48);
	return [
		...new Set(
			[root, ...recent, inReplyTo].filter((value): value is string =>
				Boolean(value),
			),
		),
	].slice(0, 50);
}

export async function storeEmailProjection(
	dependencies: EmailStorageDependencies,
	parsed: Email,
	options: StoreEmailProjectionOptions,
	attachmentData: StoredAttachment[],
	bodyObjects: StoredEmailBodyObject[] = [],
	projectionAttempt?: Pick<
		InboundProjectionCommand,
		"projectionAttemptId" | "derivedContentProof"
	>,
): Promise<
	StoredEmailSignal & {
		status: "duplicate" | "stored";
		cleanupKeys?: string[];
	}
> {
	const { folder, date, messageId, read } = options;
	const inReplyTo = messageIds(parsed.inReplyTo)[0] ?? null;
	const references = messageIds(parsed.references);
	const tokenThreadIds = extractThreadTokens(references, inReplyTo);
	const tokenThreadId = tokenThreadIds.length === 1 ? tokenThreadIds[0]! : null;
	const rfcReplyIds = boundedRfcThreadCandidates(references, inReplyTo);
	const canonicalReplyThreadId =
		tokenThreadIds.length > 1
			? null
			: (tokenThreadId ??
				(rfcReplyIds.length > 0
					? await dependencies.mailbox.resolveCanonicalThreadId(rfcReplyIds)
					: null));
	const threadId = options.threadId ?? canonicalReplyThreadId ?? messageId;
	const snoozeWakeThreadId = options.wakeSnoozedOnReply
		? canonicalReplyThreadId
		: null;
	const pushNotification =
		options.pushNotification ?? options.pushNotificationFor?.(parsed);

	const email = {
		id: messageId,
		subject: parsed.subject ?? "",
		sender: parsed.from?.address?.toLowerCase() ?? "",
		sender_name: normalizeObservedSenderName(parsed.from?.name),
		recipient: addresses(parsed.to).join(", "),
		cc: addresses(parsed.cc).join(", ") || null,
		bcc: addresses(parsed.bcc).join(", ") || null,
		date,
		read,
		body: parsed.html ?? parsed.text ?? "",
		in_reply_to: inReplyTo,
		email_references: references.length > 0 ? JSON.stringify(references) : null,
		thread_id: threadId,
		message_id: messageIds(parsed.messageId)[0] ?? null,
		raw_headers: JSON.stringify(parsed.headers),
		recipient_memory_origin: options.recipientMemoryOrigin,
		snooze_wake_thread_id: snoozeWakeThreadId,
		follow_up_reply_mailbox_address:
			options.followUpMailboxAddress?.toLowerCase() ?? null,
		automation_trigger: options.automationTrigger,
		push_notification: pushNotification,
	};
	let result: unknown;
	if (options.recipientMemoryOrigin === "live_inbound") {
		if (
			!dependencies.mailbox.createInboundEmail ||
			!options.mailboxAddress ||
			email.automation_trigger !== "live_inbound" ||
			!email.push_notification
		) {
			throw Object.assign(
				new Error("Live inbound projection contract is incomplete"),
				{ code: "MAILBOX_INBOUND_PROJECTION_UNSUPPORTED" },
			);
		}
		result = validatedInboundProjectionResult(
			await dependencies.mailbox.createInboundEmail({
				folder,
				email: {
					...email,
					recipient_memory_origin: options.recipientMemoryOrigin,
					automation_trigger: email.automation_trigger,
					push_notification: email.push_notification,
				},
				attachments: attachmentData,
				bodyObjects,
				mailboxAddress: options.mailboxAddress,
				allowTerminalRecovery: options.allowTerminalRecovery ?? false,
				...projectionAttempt,
			}),
		);
	} else {
		result = await dependencies.mailbox.createEmail(
			folder,
			email,
			attachmentData,
			undefined,
			options.mailboxAddress,
		);
	}
	if (
		result &&
		typeof result === "object" &&
		"status" in result &&
		(["cleanup_conflict", "deleted", "terminal"] as const).includes(
			result.status as never,
		)
	) {
		throw new InboundProjectionOutcomeError(result as InboundProjectionResult);
	}
	return {
		conversationKey: threadId,
		inboundMessageId: messageId,
		inboundMessageDate: date,
		status:
			result &&
			typeof result === "object" &&
			"status" in result &&
			result.status === "duplicate"
				? "duplicate"
				: "stored",
		cleanupKeys:
			result &&
			typeof result === "object" &&
			"cleanupKeys" in result &&
			Array.isArray(result.cleanupKeys) &&
			result.cleanupKeys.every((key) => typeof key === "string")
				? [...result.cleanupKeys]
				: undefined,
	};
}

export async function removeUncommittedEmailObjects(
  dependencies: EmailStorageDependencies,
  messageId: string,
  objectKeys: string[],
  originalError: unknown,
): Promise<never> {
  const messageRef = await mailTelemetryLogRef("message", messageId);
  let emailWasStored: boolean;
  try {
    emailWasStored = await emailExists(dependencies.mailbox, messageId);
  } catch {
    console.error(
      "[mail-store] failed persistence verification completed",
      {
        errorCode: "MAILBOX_VERIFICATION_FAILED",
        messageRef,
        operation: "derived_object_cleanup",
        status: "preserved",
      },
    );
    throw originalError;
  }

  if (!emailWasStored) {
    const cleanupResults = await Promise.allSettled(
      objectKeys.map((key) => dependencies.bucket.delete(key)),
    );
    const cleanupFailures = cleanupResults.filter(
      (result) => result.status === "rejected",
    ).length;
    if (cleanupFailures > 0) {
      console.error(
        "[mail-store] failed to remove R2 objects after persistence error",
        {
          cleanupFailures,
          errorCode: "DERIVED_OBJECT_CLEANUP_FAILED",
          messageRef,
          operation: "derived_object_cleanup",
          status: "degraded",
        },
      );
    }
  }
  throw originalError;
}

/**
 * Persist one parsed email through the shared live-receive and import path.
 * Callers choose identity, folder, date, read state, provenance, and an optional
 * imported thread id; this module owns attachment storage and the stored row shape.
 */
export async function storeParsedEmail(
	dependencies: EmailStorageDependencies,
	parsed: Email,
	options: StoreParsedEmailOptions,
): Promise<StoredEmailSignal> {
	const { folder, date, messageId, read } = options;
	if (
		options.attachmentIdNamespace !== undefined &&
		!/^[a-z0-9_-]{16,100}$/i.test(options.attachmentIdNamespace)
	)
		throw new Error("Attachment identity namespace is invalid");
	const attachmentData: StoredAttachment[] = [];
	const attachmentKeys: string[] = [];

	try {
		for (const [attachmentIndex, attachment] of parsed.attachments.entries()) {
			const attachmentId = options.attachmentIdNamespace
				? `${messageId}-${options.attachmentIdNamespace}-${attachmentIndex}`
				: `${messageId}-${attachmentIndex}`;
			const filename = safeAttachmentStorageFilename(
				attachment.filename ?? "untitled",
				attachmentKeyPrefix(messageId, attachmentId),
			);
			const key = attachmentKey(messageId, attachmentId, filename);
			attachmentKeys.push(key);
			const byteLength =
				typeof attachment.content === "string"
					? new TextEncoder().encode(attachment.content).byteLength
					: attachment.content.byteLength;
			await putVerifiedEmailObject(dependencies, {
				key,
				value: attachment.content,
				expectedSize: byteLength,
				messageId,
				objectType: "attachment",
			});
			const disposition = attachment.disposition ?? "attachment";
			attachmentData.push({
				id: attachmentId,
				email_id: messageId,
				filename,
				mimetype: attachment.mimeType,
				size: byteLength,
				content_id: contentIdForDisposition(disposition, attachment.contentId),
				disposition,
				r2_key: key,
			});
		}

		const stored = await storeEmailProjection(
			dependencies,
			parsed,
			options,
			attachmentData,
		);
		return {
			conversationKey: stored.conversationKey,
			inboundMessageId: stored.inboundMessageId,
			inboundMessageDate: stored.inboundMessageDate,
		};
	} catch (error) {
		return removeUncommittedEmailObjects(
			dependencies,
			messageId,
			attachmentKeys,
			error,
		);
	}
}
