import assert from "node:assert/strict";
import test from "node:test";
import {
	LABEL_COLORS,
	normalizeLabelName,
	validateLabelDefinition,
	validateLabelMutationTargets,
} from "./labels.ts";

test("label names normalize case and whitespace while preserving display text", () => {
	assert.deepEqual(validateLabelDefinition("  Waiting   On Client ", "blue"), {
		name: "Waiting On Client",
		normalizedName: "waiting on client",
		color: "blue",
	});
	assert.equal(normalizeLabelName("WÁITING  ON CLIENT"), "wáiting on client");
});

test("labels reject empty, oversized, and unconstrained colors", () => {
	assert.throws(() => validateLabelDefinition("   ", "blue"), /name/i);
	assert.throws(() => validateLabelDefinition("x".repeat(65), "blue"), /64/);
	assert.throws(() => validateLabelDefinition("Priority", "#ff0000"), /color/i);
	assert.equal(LABEL_COLORS.includes("purple"), true);
});

test("label mutation targets are explicit, unique, and bounded", () => {
	const targets = validateLabelMutationTargets([
		{ emailId: "email-1", folderId: "inbox" },
		{ emailId: "email-2", folderId: "inbox", conversationId: "thread-2" },
	]);
	assert.equal(targets.length, 2);
	assert.throws(
		() => validateLabelMutationTargets([
			{ emailId: "email-1", folderId: "inbox" },
			{ emailId: "email-1", folderId: "inbox" },
		]),
		/duplicate/i,
	);
	assert.throws(
		() => validateLabelMutationTargets(Array.from({ length: 101 }, (_, index) => ({
			emailId: `email-${index}`,
			folderId: "inbox",
		}))),
		/100/,
	);
});
