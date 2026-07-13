import assert from "node:assert/strict";
import test from "node:test";
import type { SemanticAttachmentExtractionLease } from "./semantic-index.ts";
import {
	advanceSemanticAttachmentExtraction,
	type SemanticAttachmentRuntimeMailbox,
} from "./semantic-attachment-runtime.ts";

const documentBytes = new TextEncoder().encode("The signed contract arrives Tuesday.").buffer as ArrayBuffer;

function setup(overrides?: {
	lease?: SemanticAttachmentExtractionLease | null;
	head?: { size: number; version: string; etag: string } | null;
	object?: { size: number; version: string; etag: string; bytes: ArrayBuffer } | null;
}) {
	const lease = overrides?.lease === undefined ? {
		attachmentId: "attachment-1",
		messageId: "message-1",
		attachmentVersion: 2,
		filename: "contract.md",
		mimetype: "text/markdown",
		declaredSize: documentBytes.byteLength,
		leaseToken: "lease",
		attemptCount: 1,
	} : overrides.lease;
	const completed: unknown[] = [];
	const rejected: unknown[] = [];
	const retried: unknown[] = [];
	const leaseDurations: number[] = [];
	const mailbox: SemanticAttachmentRuntimeMailbox = {
		async leaseSemanticAttachmentExtraction(_leaseToken, _nowMs, leaseMs) {
			leaseDurations.push(leaseMs);
			return lease;
		},
		async completeSemanticAttachmentExtraction(input) {
			completed.push(input);
			return true;
		},
		async rejectSemanticAttachmentExtraction(input) {
			rejected.push(input);
			return true;
		},
		async retrySemanticAttachmentExtraction(input) {
			retried.push(input);
			return true;
		},
	};
	const head = overrides?.head === undefined
		? { size: documentBytes.byteLength, version: "version-1", etag: "etag-1" }
		: overrides.head;
	const object = overrides?.object === undefined
		? { ...head!, bytes: documentBytes }
		: overrides.object;
	return {
		mailbox,
		bucket: {
			async head() { return head; },
			async get(_key: string, etag: string) {
				if (!object || object.etag !== etag) return null;
				return { ...object, async arrayBuffer() { return object.bytes; } };
			},
		},
		completed,
		rejected,
		retried,
		leaseDurations,
	};
}

test("attachment runtime conditionally reads exact R2 bytes and completes fenced plain text", async () => {
	const state = setup();
	assert.equal(await advanceSemanticAttachmentExtraction({
		mailbox: state.mailbox,
		bucket: state.bucket,
		now: () => 1_000,
		createLeaseToken: () => "lease",
	}), true);
	assert.equal(state.completed.length, 1);
	assert.deepEqual(state.rejected, []);
	assert.deepEqual(state.retried, []);
	assert.match(JSON.stringify(state.completed[0]), /signed contract arrives Tuesday/);
	assert.doesNotMatch(JSON.stringify(state.completed[0]), /attachments\//);
	assert.deepEqual(state.leaseDurations, [60_000]);
});

test("attachment runtime fails closed on size and format policy outcomes", async () => {
	const sizeMismatch = setup({
		head: { size: documentBytes.byteLength + 1, version: "version-1", etag: "etag-1" },
	});
	await advanceSemanticAttachmentExtraction({
		mailbox: sizeMismatch.mailbox,
		bucket: sizeMismatch.bucket,
		now: () => 1_000,
	});
	assert.match(JSON.stringify(sizeMismatch.rejected), /size_mismatch/);

	const html = setup({
		lease: {
			attachmentId: "attachment-1",
			messageId: "message-1",
			attachmentVersion: 2,
			filename: "page.html",
			mimetype: "text/html",
			declaredSize: documentBytes.byteLength,
			leaseToken: "lease",
			attemptCount: 1,
		},
	});
	await advanceSemanticAttachmentExtraction({
		mailbox: html.mailbox,
		bucket: html.bucket,
		now: () => 1_000,
	});
	assert.match(JSON.stringify(html.rejected), /unsupported_format/);
	assert.deepEqual(html.completed, []);

	const emptyBytes = new TextEncoder().encode("  \n").buffer as ArrayBuffer;
	const empty = setup({
		lease: {
			attachmentId: "attachment-1",
			messageId: "message-1",
			attachmentVersion: 2,
			filename: "empty.txt",
			mimetype: "text/plain",
			declaredSize: emptyBytes.byteLength,
			leaseToken: "lease",
			attemptCount: 1,
		},
		head: { size: emptyBytes.byteLength, version: "version-1", etag: "etag-1" },
		object: {
			size: emptyBytes.byteLength,
			version: "version-1",
			etag: "etag-1",
			bytes: emptyBytes,
		},
	});
	await advanceSemanticAttachmentExtraction({
		mailbox: empty.mailbox,
		bucket: empty.bucket,
		now: () => 1_000,
	});
	assert.deepEqual(empty.rejected, [{
		attachmentId: "attachment-1",
		leaseToken: "lease",
		rejectedAt: 1_000,
		errorCode: "empty_output",
		terminal: false,
	}]);
	assert.deepEqual(empty.completed, []);
});

test("missing or replaced R2 objects retry without committing evidence", async () => {
	for (const state of [
		setup({ head: null }),
		setup({ object: { size: documentBytes.byteLength, version: "version-2", etag: "etag-2", bytes: documentBytes } }),
	]) {
		await advanceSemanticAttachmentExtraction({
			mailbox: state.mailbox,
			bucket: state.bucket,
			now: () => 1_000,
		});
		assert.equal(state.retried.length, 1);
		assert.deepEqual(state.completed, []);
	}
});

test("attachment runtime bounds a stalled R2 operation and retries without evidence", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const state = setup();
	const operation = advanceSemanticAttachmentExtraction({
		mailbox: state.mailbox,
		bucket: {
			...state.bucket,
			async head() {
				return new Promise(() => {});
			},
		},
		now: () => 1_000,
	});
	await Promise.resolve();
	await Promise.resolve();
	context.mock.timers.tick(10_000);
	assert.equal(await operation, true);
	assert.deepEqual(state.completed, []);
	assert.deepEqual(state.rejected, []);
	assert.deepEqual(state.retried, [{
		attachmentId: "attachment-1",
		leaseToken: "lease",
		failedAt: 1_000,
		nextAttemptAt: 31_000,
		errorCode: "r2_error",
	}]);
});
