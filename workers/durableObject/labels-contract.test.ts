import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const mutationStart = source.indexOf("async mutateLabels(");
const mutationEnd = source.indexOf("\n\tasync createFolder", mutationStart);
const mutation = source.slice(mutationStart, mutationEnd);

test("label mutation defends its authoritative mailbox boundary", () => {
	assert.ok(mutationStart >= 0 && mutationEnd > mutationStart);
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
