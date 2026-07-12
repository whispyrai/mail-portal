import assert from "node:assert/strict";
import test from "node:test";
import { validateAiComposeDraftRequest } from "../../shared/ai-drafting.ts";

test("compose refinement validation is byte-aware and model-envelope-aware", () => {
	assert.deepEqual(
		validateAiComposeDraftRequest({
			prompt: "Make this clearer.",
			currentSubject: "Update",
			currentBody: `<p>${"context ".repeat(1_000)}</p>`,
			preserveSignature: true,
		}),
		{ ok: true },
	);
	assert.deepEqual(
		validateAiComposeDraftRequest({
			prompt: "Write it",
			currentBody: "م".repeat(20_000),
		}),
		{ ok: false, code: "request_too_large" },
	);
	assert.deepEqual(
		validateAiComposeDraftRequest({
			prompt: "Write it",
			currentBody: "<".repeat(5_000),
		}),
		{ ok: false, code: "draft_context_too_large" },
	);
	assert.deepEqual(
		validateAiComposeDraftRequest({
			prompt: '"'.repeat(8_000),
			currentBody: '"'.repeat(8_000),
		}),
		{ ok: false, code: "draft_context_too_large" },
	);
});
