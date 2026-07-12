import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("new-mail AI supports iterative authored-content refinement", () => {
	const compose = read("./ComposeEmail.tsx");
	const assistant = read("./ComposeAiAssistant.tsx");
	const queries = read("../queries/emails.ts");
	const api = read("../services/api.ts");

	assert.match(
		compose,
		/composeOptions\.mode === "new" && !composeOptions\.draftEmail/,
	);
	assert.match(compose, /lazy\(\(\) => import\("\.\/ComposeAiAssistant"\)\)/);
	assert.match(compose, /applyAiBody=\{applyAiBody\}/);
	assert.doesNotMatch(compose, /useAiDraftCompose/);
	assert.match(assistant, /extractAiAuthoredContent\(body\)/);
	assert.match(assistant, /validateAiComposeDraftRequest\(request\)/);
	assert.doesNotMatch(assistant, /authoredBody\.slice/);
	assert.match(assistant, /preserveSignature: hasComposeSignature\(body\)/);
	assert.match(assistant, /\/<img\\b\/i\.test\(authoredBody\)/);
	assert.match(
		assistant,
		/editableSnapshotRef\.current\.subject !== requestedSnapshot\.subject/,
	);
	assert.match(assistant, /Nothing was replaced/);
	assert.match(assistant, /hasDraftContext \? "Refine" : "Generate"/);
	assert.match(assistant, /\["Polish",/);
	assert.match(assistant, /\["Shorter",/);
	assert.match(assistant, /\["More formal",/);
	assert.match(assistant, /\["Friendlier",/);
	assert.match(
		assistant,
		/if \(!originMailboxId \|\| !nextPrompt \|\| requestPendingRef\.current\) return/,
	);
	assert.match(assistant, /requestPendingRef\.current = true/);
	assert.match(assistant, /finally \{\s*requestPendingRef\.current = false/);
	assert.match(
		assistant,
		/if \(requestPendingRef\.current \|\| aiCompose\.isPending\) return/,
	);
	assert.match(assistant, /disabled=\{aiCompose\.isPending\}/);
	assert.match(
		assistant,
		/if \(typeof draft\.body === "string"\) applyAiBody\(draft\.body\)/,
	);
	assert.doesNotMatch(assistant, /onClose\(\);\s*\} catch/);

	assert.match(queries, /AiComposeDraftRequest/);
	assert.match(api, /AiComposeDraftRequest/);
	assert.match(api, /post<\{ subject\?: string; body: string \}>/);
});
