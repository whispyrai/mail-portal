import assert from "node:assert/strict";
import test from "node:test";
import { streamText, tool, stepCountIs } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { isTerminalAgentStreamFailure } from "../lib/agent-stream-lifecycle.ts";

test("a later-step setup error is terminal despite AI SDK onFinish", async () => {
	const usage = {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 2, text: 2, reasoning: 0 },
	};
	let calls = 0;
	const model = new MockLanguageModelV3({
		doStream: async () => {
			calls += 1;
			if (calls === 2) throw new Error("second failed");
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: "stream-start", warnings: [] },
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "inspect",
							input: "{}",
						},
						{
							type: "finish",
							usage,
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
						},
					],
				}),
				warnings: [],
			};
		},
	});
	let finish: Parameters<NonNullable<Parameters<typeof streamText>[0]["onFinish"]>>[0] | undefined;
	let streamError: unknown;
	const result = streamText({
		model,
		messages: [{ role: "user", content: "hi" }],
		tools: {
			inspect: tool({
				inputSchema: z.object({}),
				execute: async () => ({ ok: true }),
			}),
		},
		stopWhen: stepCountIs(3),
		onError: ({ error }) => { streamError = error; },
		onFinish: (event) => { finish = event; },
	});
	const body = await result.toUIMessageStreamResponse().text();
	const rootFinishReason = await result.finishReason;

	assert.equal(calls, 2);
	assert.match(String((streamError as Error).message), /second failed/);
	assert.match(body, /"type":"error"/);
	assert.equal(finish?.finishReason, "tool-calls");
	assert.equal(finish?.totalUsage.inputTokens, undefined);
	assert.equal(finish?.totalUsage.outputTokens, undefined);
	assert.equal(finish?.steps[0]?.usage.inputTokens, 10);
	assert.equal(rootFinishReason, "other");
	assert.equal(isTerminalAgentStreamFailure({
		finishReason: finish?.finishReason,
		streamError,
		totalUsage: finish!.totalUsage,
	}), true);
});

test("a provider error finish is terminal even though AI SDK invokes onFinish", async () => {
	const model = new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "stream-start", warnings: [] },
					{ type: "error", error: new Error("provider failed") },
				],
			}),
			warnings: [],
		}),
	});
	let finish: Parameters<NonNullable<Parameters<typeof streamText>[0]["onFinish"]>>[0] | undefined;
	let streamError: unknown;
	const result = streamText({
		model,
		messages: [{ role: "user", content: "hi" }],
		onError: ({ error }) => { streamError = error; },
		onFinish: (event) => { finish = event; },
	});
	const body = await result.toUIMessageStreamResponse().text();
	const rootFinishReason = await result.finishReason;

	assert.match(String((streamError as Error).message), /provider failed/);
	assert.match(body, /"finishReason":"error"/);
	assert.equal(rootFinishReason, "error");
	assert.equal(finish?.finishReason, "error");
	assert.equal(finish?.totalUsage.inputTokens, undefined);
	assert.equal(finish?.totalUsage.outputTokens, undefined);
	assert.equal(isTerminalAgentStreamFailure({
		finishReason: finish?.finishReason,
		streamError,
		totalUsage: finish!.totalUsage,
	}), true);
});
