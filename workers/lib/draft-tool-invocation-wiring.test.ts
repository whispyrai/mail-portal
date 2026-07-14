import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agent = readFileSync(new URL("../agent/index.ts", import.meta.url), "utf8");
const mcp = readFileSync(new URL("../mcp/index.ts", import.meta.url), "utf8");

test("MCP Draft tools bind the exact session and typed JSON-RPC request", () => {
	for (const toolName of ["draft_reply", "create_draft"]) {
		const start = mcp.indexOf(`this.server.tool(\n\t\t\t"${toolName}"`);
		assert.notEqual(start, -1, toolName);
		const block = mcp.slice(start, start + 2_800);
		assert.match(block, /async \([^)]*}, extra\) =>/);
		assert.match(block, /sessionId: extra\.sessionId \?\? this\.getSessionId\(\)/);
		assert.match(block, /requestId: extra\.requestId/);
	}
});

test("Agent Draft tools bind one chat request and each AI SDK tool call", () => {
	assert.match(
		agent,
		/const requestId = options\?\.requestId \?\? crypto\.randomUUID\(\);[\s\S]{0,180}this\.#activeRuns\.begin\(\{[\s\S]{0,80}requestId,/,
	);
	assert.match(
		agent,
		/createEmailTools\([\s\S]{0,220}\{ kind: "agent", id: actorUserId \},[\s\S]{0,80}requestId,/,
	);
	for (const toolName of ["draft_email", "draft_reply"]) {
		const start = agent.indexOf(`${toolName}: defineTool({`);
		assert.notEqual(start, -1, toolName);
		const block = agent.slice(start, start + 2_300);
		assert.match(block, /\{ toolCallId }: ToolExecutionOptions/);
		assert.match(block, new RegExp(`toolName: "${toolName}"`));
		assert.match(block, /requestId,/);
		assert.match(block, /toolCallId,/);
	}
});
