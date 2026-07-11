import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relative: string) {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const sidebar = read("./Sidebar.tsx");
const list = read("../routes/email-list.tsx");
const panel = read("./EmailPanel.tsx");
const toolbar = read("./email-panel/EmailPanelToolbar.tsx");

test("Snoozed is a first-class mailbox folder with list and detail actions", () => {
	assert.match(sidebar, /Folders\.SNOOZED/);
	assert.match(list, /Nothing is snoozed/);
	assert.match(list, /email\.snoozed_until/);
	assert.match(list, /Return snoozed mail now/);
	assert.match(list, /<SnoozeDialog/);
	assert.match(panel, /candidate\.id !== Folders\.SNOOZED/);
	assert.match(panel, /<SnoozeDialog/);
	assert.match(toolbar, /aria-label="Snooze mail"/);
	assert.match(toolbar, /aria-label="Return snoozed mail now"/);
});

test("Snooze remains keyboard and touch accessible", () => {
	assert.match(list, /case "snooze"/);
	assert.match(list, /snoozeScopeAffectsRow\(scope, selectedRow\)/);
	assert.match(list, /setKeyboardTargetId\(null\);\s*closePanel\(\)/);
	assert.match(list, /Keep core actions discoverable and touch-accessible/);
	assert.match(list, /className="flex items-center shrink-0"/);
	assert.doesNotMatch(list, /Secondary actions remain hover-only/);
});
