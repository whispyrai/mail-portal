import { Hono, type Context } from "hono";
import {
	ATTACHMENT_LIMITS,
	attachmentExtension,
	isBlockedAttachment,
	validateSingleFile,
} from "../../shared/attachments.ts";
import { attachmentKeyPrefix, uploadKey } from "../lib/attachments.ts";
import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";
import { isCanonicalAttachmentUploadId } from "../lib/attachment-upload-id.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";
import { safeSesAttachmentMimeType } from "../lib/mime-type.ts";

type AppContext = Context<MailboxContext>;

const FUTURE_UUID_ATTACHMENT_PREFIX = attachmentKeyPrefix(
	"00000000-0000-4000-8000-000000000000",
	"00000000-0000-4000-8000-000000000000",
);

export type AttachmentUploadObject = {
	customMetadata?: Record<string, string>;
	httpMetadata?: { contentType?: string };
};

export type AttachmentUploadBucket = {
	head(key: string): Promise<AttachmentUploadObject | null>;
	put(
		key: string,
		value: Uint8Array<ArrayBuffer>,
		options: {
			onlyIf: { etagDoesNotMatch: "*" };
			httpMetadata: { contentType: string };
			customMetadata: Record<string, string>;
			sha256: ArrayBuffer;
		},
	): Promise<{ etag: string } | null>;
};

export type AttachmentUploadRouteDependencies = {
	bucket(c: AppContext): AttachmentUploadBucket;
	revalidateAccess(c: AppContext): Promise<boolean>;
	acquireCapacity(): (() => void) | null;
	wait(milliseconds: number): Promise<void>;
	bodyIdleTimeoutMilliseconds: number;
	bodyTotalTimeoutMilliseconds: number;
};

class AttachmentUploadTooLargeError extends Error {}
class AttachmentUploadBodyTimeoutError extends Error {}

export function createAttachmentUploadCapacityLimiter(maximumConcurrent: number) {
	let active = 0;
	return (): (() => void) | null => {
		if (active >= maximumConcurrent) return null;
		active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active -= 1;
		};
	};
}

async function readBoundedBody(
	request: Request,
	maximumBytes: number,
	idleTimeoutMilliseconds: number,
	totalTimeoutMilliseconds: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array(0);
	let bytes: Uint8Array<ArrayBuffer> | undefined;
	let size = 0;
	const deadline = Date.now() + totalTimeoutMilliseconds;
	try {
		while (true) {
			const remainingMilliseconds = deadline - Date.now();
			if (remainingMilliseconds <= 0) {
				await reader.cancel("Attachment upload body deadline expired").catch(() => undefined);
				throw new AttachmentUploadBodyTimeoutError();
			}
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let part: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
			try {
				part = await Promise.race([
					reader.read(),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new AttachmentUploadBodyTimeoutError()),
							Math.min(idleTimeoutMilliseconds, remainingMilliseconds),
						);
					}),
				]);
			} catch (error) {
				if (error instanceof AttachmentUploadBodyTimeoutError) {
					await reader.cancel("Attachment upload body stalled").catch(() => undefined);
				}
				throw error;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
			if (part.done) break;
			if (size + part.value.byteLength > maximumBytes) {
				await reader.cancel("Attachment exceeds the per-file limit").catch(() => undefined);
				throw new AttachmentUploadTooLargeError();
			}
			bytes ??= new Uint8Array(maximumBytes);
			bytes.set(part.value, size);
			size += part.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	return bytes?.subarray(0, size) ?? new Uint8Array(0);
}

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function uploadFingerprint(
	filename: string,
	mimetype: string,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<{ contentSha256: ArrayBuffer; contentSha256Hex: string; fingerprint: string }> {
	const contentSha256 = await crypto.subtle.digest("SHA-256", bytes);
	const contentSha256Hex = hex(contentSha256);
	const canonical = JSON.stringify([
		filename,
		mimetype,
		bytes.byteLength,
		contentSha256Hex,
	]);
	const fingerprint = hex(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
	);
	return { contentSha256, contentSha256Hex, fingerprint };
}

type WinnerClassification = "replayed" | "conflict" | "unknown";

async function classifyWinner(
	bucket: AttachmentUploadBucket,
	key: string,
	fingerprint: string,
	attempts: number,
	wait: (milliseconds: number) => Promise<void>,
): Promise<WinnerClassification> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		let existing: AttachmentUploadObject | null = null;
		try {
			existing = await bucket.head(key);
		} catch {
			// A failed metadata read leaves the write outcome ambiguous. Retry only
			// within this bounded confirmation window and never issue a second write.
		}
		const existingFingerprint = existing?.customMetadata?.fingerprint;
		if (existingFingerprint === fingerprint) return "replayed";
		if (existingFingerprint) return "conflict";
		if (existing) return "unknown";
		if (attempt + 1 < attempts) {
			await wait(50 * 2 ** attempt);
		}
	}
	return "unknown";
}

export function createAttachmentUploadRoutes(
	dependencies: AttachmentUploadRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.put(
		"/api/v1/mailboxes/:mailboxId/attachment-uploads/:uploadId",
		async (c) => {
			const mailboxId = c.var.authorizedMailboxId;
			if (!mailboxId) {
				return c.json({ error: "Mailbox authorization context is missing." }, 500);
			}
			const uploadId = c.req.param("uploadId") ?? "";
			if (!isCanonicalAttachmentUploadId(uploadId)) {
				return c.json({ error: "Upload identity must be a canonical UUIDv4." }, 400);
			}
			const filename = c.req.query("filename") || "untitled";
			const safeFilename = safeAttachmentStorageFilename(
				filename,
				FUTURE_UUID_ATTACHMENT_PREFIX,
			);
			const mimetype = safeSesAttachmentMimeType(
				(c.req.query("type") || "application/octet-stream").slice(0, 255),
			);
			if (isBlockedAttachment(safeFilename)) {
				return c.json(
					{ error: `.${attachmentExtension(safeFilename) || "this"} files can't be emailed.` },
					400,
				);
			}
			const releaseCapacity = dependencies.acquireCapacity();
			if (!releaseCapacity) {
				return c.json(
					{ error: "Attachment upload capacity is busy. Retry this same file." },
					503,
				);
			}
			try {
				let bytes: Uint8Array<ArrayBuffer>;
				try {
					// Workers have a fixed isolate memory ceiling. Consume the request as a
					// single bounded allocation. Module-level backpressure caps simultaneous
					// buffers because one isolate serves concurrent requests.
					// https://developers.cloudflare.com/workers/platform/limits/#memory
					// Workers HTTP requests have unlimited wall time while the client stays
					// connected, so a per-read idle deadline prevents stalled bodies from
					// pinning every bounded upload slot indefinitely.
					// https://developers.cloudflare.com/workers/platform/limits/#duration
					bytes = await readBoundedBody(
						c.req.raw,
						ATTACHMENT_LIMITS.maxFileBytes,
						dependencies.bodyIdleTimeoutMilliseconds,
						dependencies.bodyTotalTimeoutMilliseconds,
					);
				} catch (error) {
					if (error instanceof AttachmentUploadTooLargeError) {
						return c.json(
							{
								error: `File is over the ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MB per-file limit.`,
							},
							413,
						);
					}
					if (error instanceof AttachmentUploadBodyTimeoutError) {
						return c.json(
							{ error: "Attachment upload stalled. Retry this same file." },
							408,
						);
					}
					throw error;
				}
				const validationError = validateSingleFile({
					filename: safeFilename,
					size: bytes.byteLength,
				});
				if (validationError) return c.json({ error: validationError }, 400);
				const digest = await uploadFingerprint(safeFilename, mimetype, bytes);
				let authorized: boolean;
				try {
					authorized = await dependencies.revalidateAccess(c);
				} catch {
					return c.json({ error: "Mailbox authorization could not be confirmed." }, 503);
				}
				if (!authorized) return c.json({ error: "Forbidden" }, 403);
				const customMetadata = {
					filename: safeFilename,
					type: mimetype,
					size: String(bytes.byteLength),
					contentSha256: digest.contentSha256Hex,
					fingerprint: digest.fingerprint,
				};
				const bucket = dependencies.bucket(c);
				const key = uploadKey(mailboxId, uploadId);
				let written: { etag: string } | null = null;
				let writeThrew = false;
				try {
					written = await bucket.put(key, bytes, {
						onlyIf: { etagDoesNotMatch: "*" },
						httpMetadata: { contentType: mimetype },
						customMetadata,
						sha256: digest.contentSha256,
					});
				} catch {
					writeThrew = true;
				}
				if (!written) {
					const classification = await classifyWinner(
						bucket,
						key,
						digest.fingerprint,
						writeThrew ? 5 : 1,
						dependencies.wait,
					);
					if (classification === "replayed") {
						return c.json({
							uploadId,
							filename: safeFilename,
							mimetype,
							size: bytes.byteLength,
							replayed: true,
						});
					}
					if (classification === "conflict") {
						return c.json(
							{
								error: "This upload identity already belongs to a different file.",
								code: "attachment_upload_conflict",
								uploadId,
							},
							409,
						);
					}
					return c.json(
						{ error: "The attachment upload outcome could not be confirmed." },
						503,
					);
				}
				return c.json(
					{
						uploadId,
						filename: safeFilename,
						mimetype,
						size: bytes.byteLength,
						replayed: false,
					},
					201,
				);
			} finally {
				releaseCapacity();
			}
		},
	);
	return routes;
}

export const attachmentUploadRoutes = createAttachmentUploadRoutes({
	bucket: (c) => c.env.BUCKET,
	revalidateAccess: hasLiveMailboxContentAccess,
	acquireCapacity: createAttachmentUploadCapacityLimiter(4),
	wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	bodyIdleTimeoutMilliseconds: 30_000,
	bodyTotalTimeoutMilliseconds: 120_000,
});
