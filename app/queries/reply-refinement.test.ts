import assert from "node:assert/strict";
import test from "node:test";
import { buildReplyRefinementMutationOptions } from "./reply-refinement.ts";

test("reply refinement mutation forwards the pinned request and abort signal without retry", async () => {
	const controller = new AbortController();
	let received: unknown;
	const options = buildReplyRefinementMutationOptions(
		async (mailboxId, sourceEmailId, request, signal) => {
			received = { mailboxId, sourceEmailId, request, signal };
			return { state: "stale" };
		},
	);
	const request = {
		mode: "reply" as const,
		prompt: "Confirm the timeline.",
		currentBody: "<p>Friday works.</p>",
		preserveSignature: true,
	};

	assert.equal(options.retry, false);
	assert.deepEqual(
		await options.mutationFn({
			mailboxId: "team@example.com",
			sourceEmailId: "message-1",
			request,
			signal: controller.signal,
			requestToken: 7,
		}),
		{ state: "stale" },
	);
	assert.deepEqual(received, {
		mailboxId: "team@example.com",
		sourceEmailId: "message-1",
		request,
		signal: controller.signal,
	});
});
