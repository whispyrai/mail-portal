import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("new-mail AI supports iterative authored-content refinement", () => {
	const compose = read("./ComposeEmail.tsx");
	const queries = read("../queries/emails.ts");
	const api = read("../services/api.ts");

	assert.match(
		compose,
		/composeOptions\.mode === "new" && !composeOptions\.draftEmail/,
	);
	assert.match(compose, /extractAiAuthoredContent\(body\)/);
	assert.match(
		compose,
		/validateAiComposeDraftRequest\(request\)/,
	);
	assert.doesNotMatch(compose, /aiAuthoredBody\.slice/);
	assert.match(compose, /preserveSignature: hasComposeSignature\(body\)/);
	assert.match(compose, /\/<img\\b\/i\.test\(aiAuthoredBody\)/);
	assert.match(compose, /aiEditableSnapshotRef\.current\.subject !== requestedSnapshot\.subject/);
	assert.match(compose, /Nothing was replaced/);
	assert.match(compose, /hasAiDraftContext \? "Refine" : "Generate"/);
	assert.match(compose, /\["Polish",/);
	assert.match(compose, /\["Shorter",/);
	assert.match(compose, /\["More formal",/);
	assert.match(compose, /\["Friendlier",/);
	assert.match(compose, /if \(!originMailboxId \|\| !prompt \|\| aiRequestPendingRef\.current\) return/);
	assert.match(compose, /aiRequestPendingRef\.current = true/);
	assert.match(compose, /finally \{\s*aiRequestPendingRef\.current = false/);
	assert.match(compose, /disabled=\{aiComposeMut\.isPending\}/);
	assert.match(compose, /if \(typeof draft\.body === "string"\) applyAiBody\(draft\.body\)/);
	assert.doesNotMatch(compose, /setShowAiPrompt\(false\);\s*setAiPrompt\(""\);\s*\} catch/);

	assert.match(queries, /AiComposeDraftRequest/);
	assert.match(api, /AiComposeDraftRequest/);
	assert.match(api, /post<\{ subject\?: string; body: string \}>/);
});
