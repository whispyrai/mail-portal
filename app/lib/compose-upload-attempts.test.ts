import assert from "node:assert/strict";
import test from "node:test";
import { recoverComposeAttachments } from "./compose-attachment-policy.ts";
import { ComposeUploadAttemptRegistry } from "./compose-upload-attempts.ts";

test("retry aborts the old request and stale completion cannot own the local id", () => {
	const attempts = new ComposeUploadAttemptRegistry();
	const first = attempts.begin("local-1");
	const retry = attempts.begin("local-1");

	assert.equal(first.signal.aborted, true);
	assert.equal(attempts.isCurrent("local-1", first.token), false);
	assert.equal(attempts.isCurrent("local-1", retry.token), true);
	attempts.finish("local-1", first.token);
	assert.equal(attempts.isCurrent("local-1", retry.token), true);
});

test("remove, reset, and unmount-style abortAll invalidate every active attempt", () => {
	const attempts = new ComposeUploadAttemptRegistry();
	const removed = attempts.begin("removed");
	attempts.abort("removed");
	assert.equal(removed.signal.aborted, true);
	assert.equal(attempts.isCurrent("removed", removed.token), false);

	const first = attempts.begin("first");
	const second = attempts.begin("second");
	attempts.abortAll();
	assert.equal(first.signal.aborted, true);
	assert.equal(second.signal.aborted, true);
	assert.equal(attempts.isCurrent("first", first.token), false);
	assert.equal(attempts.isCurrent("second", second.token), false);
});

test("a recovered upload retries under a fresh owner and rejects the stale completion", () => {
	const attempts = new ComposeUploadAttemptRegistry();
	const file = new File(["draft"], "draft.pdf", { type: "application/pdf" });
	const localId = "recovered-upload";
	const stale = attempts.begin(localId);
	attempts.abortAll();
	let attachment = recoverComposeAttachments([
		{
			localId,
			filename: file.name,
			mimetype: file.type,
			size: file.size,
			status: "uploading",
			disposition: "attachment",
			file,
		},
	])[0];
	assert.ok(attachment);
	assert.equal(attachment.status, "error");

	const retry = attempts.begin(localId);
	assert.ok(retry.token > stale.token);
	attachment = { ...attachment, status: "uploading", error: undefined };
	const settle = (token: number, uploadId: string) => {
		if (!attempts.isCurrent(localId, token)) return;
		attachment = {
			...attachment,
			status: "ready",
			error: undefined,
			uploadId,
		};
		attempts.finish(localId, token);
	};

	settle(stale.token, "stale-upload");
	assert.equal(attachment.status, "uploading");
	settle(retry.token, "retry-upload");
	assert.deepEqual(
		{
			status: attachment.status,
			uploadId: attachment.uploadId,
			file: attachment.file,
		},
		{ status: "ready", uploadId: "retry-upload", file },
	);
});
