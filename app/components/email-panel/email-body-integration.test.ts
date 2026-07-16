import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../EmailPanel.tsx", import.meta.url), "utf8");
const messageBody = await readFile(new URL("./EmailMessageBody.tsx", import.meta.url), "utf8");
const threadMessage = await readFile(new URL("./ThreadMessage.tsx", import.meta.url), "utf8");
const singleMessage = await readFile(new URL("./SingleMessageView.tsx", import.meta.url), "utf8");
const toolbar = await readFile(new URL("./EmailPanelToolbar.tsx", import.meta.url), "utf8");

test("EmailPanel owns one selected body query and only expanded nonselected queries", () => {
	assert.match(panel, /if \(email\.body_external\) ids\.add\(email\.id\)/);
	assert.match(panel, /message\.id !== email\.id[\s\S]*message\.body_external[\s\S]*expandedMessages\.has\(message\.id\)/);
	assert.match(panel, /useQueries\(\{[\s\S]*activeExternalBodyIds\.map/);
	assert.doesNotMatch(threadMessage, /useEmailBody|useQuery|useQueries/);
	assert.doesNotMatch(singleMessage, /useEmailBody|useQuery|useQueries/);
});

test("shared message body never falls back to an external preview and exposes exact recovery", () => {
	assert.match(messageBody, /email\.body_external \? bodyState\?\.data : email\.body/);
	assert.match(messageBody, /Loading complete message from \{senderLabel\}/);
	assert.match(messageBody, /The complete message from \{senderLabel\} could not be loaded/);
	assert.match(messageBody, /aria-label=\{`Retry loading complete message from \$\{senderLabel\}`\}/);
	assert.match(threadMessage, /<EmailMessageBody/);
	assert.match(singleMessage, /<EmailMessageBody/);
});

test("Forward is both disabled and handler-guarded until the selected body is authoritative", () => {
	assert.match(panel, /if \(!authoritativeSelectedEmail\) return/);
	assert.match(panel, /originalEmail: authoritativeSelectedEmail/);
	assert.match(toolbar, /disabled=\{!canForward\}/);
	assert.match(toolbar, /Forward unavailable:/);
});
