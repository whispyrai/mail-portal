import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	createAttachmentUploadCapacityLimiter,
	createAttachmentUploadRoutes,
	type AttachmentUploadBucket,
	type AttachmentUploadRouteDependencies,
} from "./attachment-uploads.ts";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

const MAILBOX_ID = "hello@wiserchat.ai";
const UPLOAD_ID = "95f6a780-cb27-4df2-a9da-49347f7c3d22";

function attachmentApp(
	bucket: AttachmentUploadBucket,
	overrides: Partial<Omit<AttachmentUploadRouteDependencies, "bucket">> = {},
) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authorizedMailboxId", MAILBOX_ID);
		await next();
	});
	app.route("/", createAttachmentUploadRoutes({
		bucket: () => bucket,
		revalidateAccess: async () => true,
		acquireCapacity: () => () => undefined,
		wait: async () => undefined,
		bodyIdleTimeoutMilliseconds: 30_000,
		bodyTotalTimeoutMilliseconds: 120_000,
		...overrides,
	}));
	return app;
}

test("a valid client-owned upload identity creates one immutable staging object", async () => {
	const writes: Array<{
		key: string;
		bytes: Uint8Array;
		options: Parameters<AttachmentUploadBucket["put"]>[2];
	}> = [];
	const bucket: AttachmentUploadBucket = {
		async head() {
			throw new Error("a successful first create must not read R2");
		},
		async put(key, value, options) {
			writes.push({ key, bytes: new Uint8Array(value), options });
			return { etag: "created-etag" };
		},
	};
	const app = attachmentApp(bucket);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf&type=application%2Fpdf`,
		{
			method: "PUT",
			headers: { "content-type": "application/pdf" },
			body: new Uint8Array([104, 101, 108, 108, 111]),
		},
	);

	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), {
		uploadId: UPLOAD_ID,
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: 5,
		replayed: false,
	});
	assert.equal(writes.length, 1);
	assert.equal(writes[0]?.key, `uploads/${MAILBOX_ID}/${UPLOAD_ID}`);
	assert.deepEqual(writes[0]?.bytes, new Uint8Array([104, 101, 108, 108, 111]));
	assert.deepEqual(writes[0]?.options.onlyIf, { etagDoesNotMatch: "*" });
	assert.deepEqual(writes[0]?.options.httpMetadata, { contentType: "application/pdf" });
	assert.equal(writes[0]?.options.customMetadata.filename, "proposal.pdf");
	assert.equal(writes[0]?.options.customMetadata.type, "application/pdf");
	assert.equal(writes[0]?.options.customMetadata.size, "5");
	assert.equal(
		writes[0]?.options.customMetadata.contentSha256,
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	);
	assert.match(writes[0]?.options.customMetadata.fingerprint ?? "", /^[a-f0-9]{64}$/);
});

test("upload filename normalization never splits an emoji at the character boundary", async () => {
	let storedFilename = "";
	const bucket: AttachmentUploadBucket = {
		async head() { return null; },
		async put(_key, _value, options) {
			storedFilename = options.customMetadata.filename;
			return { etag: "created" };
		},
	};
	const originalFilename = `${"a".repeat(254)}📄.pdf`;
	const response = await attachmentApp(bucket).request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=${encodeURIComponent(originalFilename)}`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);
	assert.equal(response.status, 201);
	assert.ok([...storedFilename].length <= 255);
	assert.match(storedFilename, /\.pdf$/);
	for (const character of storedFilename) {
		assert.equal(
			character.length === 1 && /[\uD800-\uDFFF]/.test(character),
			false,
		);
	}
});

test("an identical retry returns the original immutable staging reference", async () => {
	let stored: {
		bytes: Uint8Array;
		customMetadata: Record<string, string>;
		httpMetadata: { contentType: string };
	} | null = null;
	let successfulCreates = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			return stored;
		},
		async put(_key, value, options) {
			if (stored) return null;
			stored = {
				bytes: value.slice(0),
				customMetadata: { ...options.customMetadata },
				httpMetadata: { ...options.httpMetadata },
			};
			successfulCreates += 1;
			return { etag: "created-etag" };
		},
	};
	const app = attachmentApp(bucket);
	const upload = () => app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf&type=application%2Fpdf`,
		{
			method: "PUT",
			headers: { "content-type": "application/pdf" },
			body: new Uint8Array([104, 101, 108, 108, 111]),
		},
	);

	const created = await upload();
	const replayed = await upload();

	assert.equal(created.status, 201);
	assert.equal(replayed.status, 200);
	assert.deepEqual(await replayed.json(), {
		uploadId: UPLOAD_ID,
		filename: "proposal.pdf",
		mimetype: "application/pdf",
		size: 5,
		replayed: true,
	});
	assert.equal(successfulCreates, 1);
	assert.deepEqual(
		new Uint8Array(stored?.bytes ?? new ArrayBuffer(0)),
		new Uint8Array([104, 101, 108, 108, 111]),
	);
});

test("reusing an upload identity for a different file conflicts without overwriting", async () => {
	const cases = [
		{
			name: "filename",
			filename: "proposal-final.pdf",
			mimetype: "application/pdf",
			bytes: new Uint8Array([104, 101, 108, 108, 111]),
		},
		{
			name: "MIME type",
			filename: "proposal.pdf",
			mimetype: "text/plain",
			bytes: new Uint8Array([104, 101, 108, 108, 111]),
		},
		{
			name: "same-size bytes",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			bytes: new Uint8Array([104, 101, 108, 108, 112]),
		},
		{
			name: "size",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			bytes: new Uint8Array([104, 101, 108, 108, 111, 33]),
		},
	];
	for (const changed of cases) {
		let stored: {
			bytes: Uint8Array;
			customMetadata: Record<string, string>;
			httpMetadata: { contentType: string };
		} | null = null;
		let successfulCreates = 0;
		const bucket: AttachmentUploadBucket = {
			async head() {
				return stored;
			},
			async put(_key, value, options) {
				if (stored) return null;
				stored = {
					bytes: value.slice(0),
					customMetadata: { ...options.customMetadata },
					httpMetadata: { ...options.httpMetadata },
				};
				successfulCreates += 1;
				return { etag: "created-etag" };
			},
		};
		const app = attachmentApp(bucket);
		const upload = (filename: string, mimetype: string, bytes: Uint8Array) =>
			app.request(
				`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(mimetype)}`,
				{
					method: "PUT",
					headers: { "content-type": mimetype },
					body: bytes,
				},
			);

		assert.equal(
			(await upload(
				"proposal.pdf",
				"application/pdf",
				new Uint8Array([104, 101, 108, 108, 111]),
			)).status,
			201,
			changed.name,
		);
		const conflict = await upload(changed.filename, changed.mimetype, changed.bytes);

		assert.equal(conflict.status, 409, changed.name);
		assert.deepEqual(await conflict.json(), {
			error: "This upload identity already belongs to a different file.",
			code: "attachment_upload_conflict",
			uploadId: UPLOAD_ID,
		});
		assert.equal(successfulCreates, 1, changed.name);
		assert.deepEqual(
			new Uint8Array(stored?.bytes ?? new ArrayBuffer(0)),
			new Uint8Array([104, 101, 108, 108, 111]),
			changed.name,
		);
	}
});

test("a conditional-write loss with no readable winner fails closed without resurrection", async () => {
	let puts = 0;
	let gets = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			gets += 1;
			return null;
		},
		async put() {
			puts += 1;
			return null;
		},
	};
	const app = attachmentApp(bucket);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf&type=application%2Fpdf`,
		{
			method: "PUT",
			body: new Uint8Array([104, 101, 108, 108, 111]),
		},
	);

	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		error: "The attachment upload outcome could not be confirmed.",
	});
	assert.equal(puts, 1);
	assert.equal(gets, 1);
});

test("invalid and unsafe requests fail before any R2 access", async () => {
	let bucketCalls = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket);
	const cases = [
		{
			name: "malformed identity",
			uploadId: "not-a-uuid",
			filename: "proposal.pdf",
			body: new Uint8Array([1]),
			headers: {},
			status: 400,
			error: "Upload identity must be a canonical UUIDv4.",
		},
		{
			name: "uppercase identity alias",
			uploadId: UPLOAD_ID.toUpperCase(),
			filename: "proposal.pdf",
			body: new Uint8Array([1]),
			headers: {},
			status: 400,
			error: "Upload identity must be a canonical UUIDv4.",
		},
		{
			name: "non-v4 identity",
			uploadId: "95f6a780-cb27-1df2-a9da-49347f7c3d22",
			filename: "proposal.pdf",
			body: new Uint8Array([1]),
			headers: {},
			status: 400,
			error: "Upload identity must be a canonical UUIDv4.",
		},
		{
			name: "blocked extension",
			uploadId: UPLOAD_ID,
			filename: "script.exe",
			body: new Uint8Array([1]),
			headers: {},
			status: 400,
			error: ".exe files can't be emailed.",
		},
		{
			name: "empty body",
			uploadId: UPLOAD_ID,
			filename: "proposal.pdf",
			body: new Uint8Array(0),
			headers: {},
			status: 400,
			error: "proposal.pdf is empty.",
		},
		{
			name: "lying content length",
			uploadId: UPLOAD_ID,
			filename: "proposal.pdf",
			body: new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1),
			headers: { "content-length": "1" },
			status: 413,
			error: "File is over the 10 MB per-file limit.",
		},
	];
	for (const request of cases) {
		const response = await app.request(
			`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${request.uploadId}?filename=${encodeURIComponent(request.filename)}`,
			{
				method: "PUT",
				headers: request.headers,
				body: request.body,
			},
		);
		assert.equal(response.status, request.status, request.name);
		assert.deepEqual(await response.json(), { error: request.error }, request.name);
	}
	assert.equal(bucketCalls, 0);
});

test("unsafe MIME text is canonicalized before fingerprinting and storage", async () => {
	let storedType = "";
	const bucket: AttachmentUploadBucket = {
		async head() {
			return null;
		},
		async put(_key, _value, options) {
			storedType = options.customMetadata.type;
			assert.equal(options.httpMetadata.contentType, "application/octet-stream");
			return { etag: "created" };
		},
	};
	const app = attachmentApp(bucket);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf&type=${encodeURIComponent("TEXT/PLAIN\r\nX-Bad: yes")}`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);

	assert.equal(response.status, 201);
	assert.equal(storedType, "application/octet-stream");
	assert.equal((await response.json() as { mimetype: string }).mimetype, "application/octet-stream");
});

test("MIME metadata honors the SES 78-character delivery boundary", async () => {
	const storedTypes: string[] = [];
	const bucket: AttachmentUploadBucket = {
		async head() {
			return null;
		},
		async put(_key, _value, options) {
			storedTypes.push(options.customMetadata.type);
			return { etag: "created" };
		},
	};
	const app = attachmentApp(bucket);
	const atLimit = `application/${"a".repeat(66)}`;
	const overLimit = `application/${"a".repeat(67)}`;
	const upload = (uploadId: string, mimetype: string) => app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${uploadId}?filename=proposal.pdf&type=${encodeURIComponent(mimetype)}`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);

	const accepted = await upload(UPLOAD_ID, atLimit);
	const canonicalized = await upload(
		"895dbb44-e8ba-45d1-8d75-c88fbc61cb35",
		overLimit,
	);

	assert.equal(atLimit.length, 78);
	assert.equal(overLimit.length, 79);
	assert.equal(accepted.status, 201);
	assert.equal(canonicalized.status, 201);
	assert.deepEqual(storedTypes, [atLimit, "application/octet-stream"]);
	assert.equal(
		(await canonicalized.json() as { mimetype: string }).mimetype,
		"application/octet-stream",
	);
});

test("authorization is revalidated after ingestion and before any write", async () => {
	let bucketCalls = 0;
	let releases = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket, {
		revalidateAccess: async () => false,
		acquireCapacity: () => () => { releases += 1; },
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{ method: "PUT", body: new Uint8Array([1, 2, 3]) },
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.equal(bucketCalls, 0);
	assert.equal(releases, 1);
});

test("a thrown conditional write confirms a delayed winner without rewriting", async () => {
	let metadata: Record<string, string> | undefined;
	let puts = 0;
	let heads = 0;
	const waits: number[] = [];
	const bucket: AttachmentUploadBucket = {
		async head() {
			heads += 1;
			return heads === 1 ? null : { customMetadata: metadata };
		},
		async put(_key, _value, options) {
			puts += 1;
			metadata = { ...options.customMetadata };
			throw new Error("TooManyRequests");
		},
	};
	const app = attachmentApp(bucket, {
		wait: async (milliseconds) => { waits.push(milliseconds); },
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf&type=application%2Fpdf`,
		{ method: "PUT", body: new Uint8Array([1, 2, 3]) },
	);

	assert.equal(response.status, 200);
	assert.equal((await response.json() as { replayed: boolean }).replayed, true);
	assert.equal(puts, 1);
	assert.equal(heads, 2);
	assert.deepEqual(waits, [50]);
});

test("a thrown conditional write still reports a different immutable winner as conflict", async () => {
	let puts = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			return { customMetadata: { fingerprint: "different-winner" } };
		},
		async put() {
			puts += 1;
			throw new Error("TooManyRequests");
		},
	};
	const app = attachmentApp(bucket);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);

	assert.equal(response.status, 409);
	assert.equal((await response.json() as { code: string }).code, "attachment_upload_conflict");
	assert.equal(puts, 1);
});

test("ambiguous write and metadata failures return retryable 503 without resurrection", async () => {
	let puts = 0;
	let heads = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			heads += 1;
			throw new Error("R2 unavailable");
		},
		async put() {
			puts += 1;
			throw new Error("TooManyRequests");
		},
	};
	const app = attachmentApp(bucket);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);

	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		error: "The attachment upload outcome could not be confirmed.",
	});
	assert.equal(puts, 1);
	assert.equal(heads, 5);
});

test("module backpressure caps simultaneous full-body buffers and releases exactly once", () => {
	const acquire = createAttachmentUploadCapacityLimiter(4);
	const releases = [acquire(), acquire(), acquire(), acquire()];
	assert.equal(releases.every(Boolean), true);
	assert.equal(acquire(), null);
	releases[0]?.();
	releases[0]?.();
	const replacement = acquire();
	assert.equal(typeof replacement, "function");
	assert.equal(acquire(), null);
	replacement?.();
});

test("busy upload capacity rejects before consuming or touching storage", async () => {
	let bucketCalls = 0;
	let accessChecks = 0;
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket, {
		acquireCapacity: () => null,
		revalidateAccess: async () => { accessChecks += 1; return true; },
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{ method: "PUT", body: new Uint8Array([1]) },
	);

	assert.equal(response.status, 503);
	assert.equal(bucketCalls, 0);
	assert.equal(accessChecks, 0);
});

test("a stalled upload body is cancelled and releases capacity", async () => {
	let cancelled = false;
	let bucketCalls = 0;
	let releases = 0;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket, {
		acquireCapacity: () => () => { releases += 1; },
		bodyIdleTimeoutMilliseconds: 0,
	});
	const request = new Request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{
			method: "PUT",
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" },
	);

	const response = await app.request(request);

	assert.equal(response.status, 408);
	assert.deepEqual(await response.json(), {
		error: "Attachment upload stalled. Retry this same file.",
	});
	assert.equal(cancelled, true);
	assert.equal(releases, 1);
	assert.equal(bucketCalls, 0);
});

test("a slow-drip upload cannot reset the absolute body deadline", async () => {
	let cancelled = false;
	let bucketCalls = 0;
	let interval: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
			interval = setInterval(() => controller.enqueue(new Uint8Array([1])), 5);
		},
		cancel() {
			cancelled = true;
			if (interval) clearInterval(interval);
		},
	});
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket, {
		bodyIdleTimeoutMilliseconds: 100,
		bodyTotalTimeoutMilliseconds: 25,
	});
	const request = new Request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{
			method: "PUT",
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" },
	);

	const response = await app.request(request);

	assert.equal(response.status, 408);
	assert.equal(cancelled, true);
	assert.equal(bucketCalls, 0);
});

test("oversized streamed bodies are cancelled and never reach storage", async () => {
	let cancelled = false;
	let bucketCalls = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes));
			controller.enqueue(new Uint8Array([1]));
		},
		cancel() {
			cancelled = true;
		},
	});
	const bucket: AttachmentUploadBucket = {
		async head() {
			bucketCalls += 1;
			return null;
		},
		async put() {
			bucketCalls += 1;
			return { etag: "unexpected" };
		},
	};
	const app = attachmentApp(bucket);
	const request = new Request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${UPLOAD_ID}?filename=proposal.pdf`,
		{
			method: "PUT",
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" },
	);
	const response = await app.request(request);

	assert.equal(response.status, 413);
	assert.equal(cancelled, true);
	assert.equal(bucketCalls, 0);
});
