import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	classMethodText,
	parseTypescriptSource,
} from "../testing/typescript-source.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const mutation = classMethodText(
	parseTypescriptSource(source, "index.ts"),
	"mutateLabels",
);

test("label mutation defends its authoritative mailbox boundary", () => {
	assert.match(mutation, /validateLabelMutationTargets\(input\.targets\)/);
	assert.match(mutation, /#visibleFolderId\(target\.folderId\)/);
	assert.match(mutation, /#conversationScope\(target\.conversationId, folderId\)/);
	assert.match(
		mutation,
		/\[\s*"queued",\s*"sending",\s*"retrying",?\s*\]/,
	);
	assert.match(mutation, /outbound_delivery_active/);
});

test("label changes are transactional, attributed, and remove only junction rows", () => {
	assert.match(mutation, /storage\.transactionSync/);
	assert.match(mutation, /#recordActivity/);
	assert.match(mutation, /label_applied/);
	assert.match(mutation, /label_removed/);
	assert.match(mutation, /delete\(schema\.emailLabels\)/);
	assert.doesNotMatch(mutation, /delete\(schema\.emails\)/);
});
