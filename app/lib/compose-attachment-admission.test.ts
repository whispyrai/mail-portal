import assert from "node:assert/strict";
import test from "node:test";
import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import { planComposeAttachmentAdmission } from "./compose-attachment-admission.ts";

const MB = 1024 * 1024;

test("mixed batches are admitted deterministically against shared count and file limits", () => {
	const current = Array.from({ length: 8 }, (_, index) => ({
		filename: `current-${index}.pdf`,
		size: MB,
		status: "ready",
	}));
	const plan = planComposeAttachmentAdmission(current, [
		{ filename: "too-large.pdf", size: ATTACHMENT_LIMITS.maxFileBytes + 1 },
		{ filename: "accepted-a.pdf", size: MB },
		{ filename: "accepted-b.pdf", size: MB },
		{ filename: "over-count.pdf", size: MB },
	]);

	assert.deepEqual(
		plan.decisions.map(({ accepted }) => accepted),
		[false, true, true, false],
	);
	assert.match(plan.decisions[0]?.error ?? "", /per-file limit/);
	assert.match(plan.decisions[3]?.error ?? "", /Too many files/);
	assert.equal(plan.capacity.length, ATTACHMENT_LIMITS.maxFiles);
});

test("rejected and failed chips do not consume capacity while accepted files consume total bytes in order", () => {
	const plan = planComposeAttachmentAdmission(
		[
			{ filename: "ready.pdf", size: 10 * MB, status: "ready" },
			{ filename: "uploading.pdf", size: 10 * MB, status: "uploading" },
			{ filename: "failed.pdf", size: 10 * MB, status: "error" },
			{ filename: "rejected.pdf", size: 10 * MB, status: "rejected" },
		],
		[
			{ filename: "fits.pdf", size: 5 * MB },
			{ filename: "over-total.pdf", size: 1 },
		],
	);

	assert.deepEqual(
		plan.decisions.map(({ accepted }) => accepted),
		[true, false],
	);
	assert.match(plan.decisions[1]?.error ?? "", /Attachments total/);
});

test("a second same-tick admission can use the first plan's synchronous capacity", () => {
	const first = planComposeAttachmentAdmission([], Array.from({ length: 9 }, (_, index) => ({
		filename: `first-${index}.pdf`,
		size: 1,
	})));
	const second = planComposeAttachmentAdmission(first.capacity, [
		{ filename: "tenth.pdf", size: 1 },
		{ filename: "eleventh.pdf", size: 1 },
	]);

	assert.deepEqual(second.decisions.map(({ accepted }) => accepted), [true, false]);
});
