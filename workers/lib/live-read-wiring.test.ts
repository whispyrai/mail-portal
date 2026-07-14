import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
const agentSource = readFileSync(new URL("../agent/index.ts", import.meta.url), "utf8");
const agentAuthorizationSource = readFileSync(
	new URL("./agent-frame-authorization.ts", import.meta.url),
	"utf8",
);
const mcpSource = readFileSync(new URL("../mcp/index.ts", import.meta.url), "utf8");

test("protected HTTP reads revalidate the signed-in credential generation", () => {
	assert.match(appSource, /resolveLiveSessionUser/);
	assert.match(appSource, /phase:\s*"after_response"/);
	assert.match(appSource, /replaceWithPrivateResponse/);
	assert.match(appSource, /isAcceptedAgentWebSocket/);
	assert.match(appSource, /c\.req\.method !== "GET" && c\.req\.method !== "HEAD"/);
	assert.match(appSource, /hasExactLiveMailboxAccess/);
	assert.doesNotMatch(appSource, /if \(path\.startsWith\("\/agents\/"\)\) return/);
	assert.match(
		appSource,
		/await next\(\)[\s\S]{0,2200}path\.startsWith\("\/agents\/"\)[\s\S]{0,500}hasExactLiveMailboxAccess/,
	);
});

test("agent connections bind session generation and wrap every mail read", () => {
	assert.match(appSource, /X-Mail-Actor-Session-Version/);
	assert.match(agentSource, /actorSessionVersion/);
	assert.match(agentAuthorizationSource, /actorSessionVersion === undefined/);
	assert.match(agentSource, /this\.onMessage = async/);
	assert.match(agentSource, /this\.onConnect = async/);
	assert.match(agentSource, /runAuthorizedAgentFrame/);
	assert.match(agentSource, /runAuthorizedAgentAdmission/);
	assert.match(agentSource, /unauthorizedAgentConnectionIds/);
	assert.match(agentSource, /reconcileActor/);
	assert.match(agentSource, /reconcileMailbox/);
	assert.match(agentAuthorizationSource, /options\.close\(4403/);
	for (const call of [
		"toolListEmails",
		"toolGetEmail",
		"toolGetThread",
		"toolSearchEmails",
	]) {
		assert.match(
			agentSource,
			new RegExp(`runLiveAuthorizedRead\\([\\s\\S]{0,500}${call}`),
			call,
		);
	}
	for (const call of ["toolDraftEmail", "toolDraftReply"]) {
		assert.match(
			agentSource,
			new RegExp(`runLiveAuthorizedMutation\\([\\s\\S]{0,500}${call}`),
			call,
		);
	}
});

test("MCP wraps every mail-content read with post-read authorization", () => {
	assert.match(
		mcpSource,
		/runMailboxRead[\s\S]{0,800}runLiveAuthorizedRead/,
	);
	assert.match(
		mcpSource,
		/listExactLiveMailboxes[\s\S]{0,500}listedMailboxIds/,
	);
	for (const call of [
		"toolListEmails",
		"toolGetEmail",
		"toolGetThread",
		"toolSearchEmails",
	]) {
		assert.match(
			mcpSource,
			new RegExp(`runMailboxRead\\([\\s\\S]{0,500}${call}`),
			call,
		);
	}
	for (const call of ["toolDraftReply", "toolDraftEmail", "toolUpdateDraft"]) {
		assert.match(
			mcpSource,
			new RegExp(`runMailboxMutation\\([\\s\\S]{0,500}${call}`),
			call,
		);
	}
	for (const call of [
		"listQuizzes",
		"listResults",
		"getAttemptById",
		"getQuestion",
	]) {
		assert.match(
			mcpSource,
			new RegExp(`runQuizRead\\([\\s\\S]{0,800}${call}`),
			call,
		);
	}
});
