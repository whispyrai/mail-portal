import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_WORKSPACE_PREFERENCES,
	LIST_PANE_WIDTH_PRESETS,
	MIN_CONVERSATION_PANE_WIDTH,
	MAX_LIST_PANE_WIDTH,
	MIN_LIST_PANE_WIDTH,
	SPLIT_VIEW_MIN_WIDTH,
	normalizeListPaneWidth,
	parseWorkspacePreferences,
	readWorkspacePreferences,
	writeWorkspacePreferences,
} from "./workspace-preferences.ts";

test("workspace preferences have an explicit, versioned default contract", () => {
	assert.deepEqual(DEFAULT_WORKSPACE_PREFERENCES, {
		version: 1,
		mailDensity: "comfortable",
		listPaneWidth: 400,
		conversationIntelligenceExpanded: false,
	});
	assert.deepEqual(LIST_PANE_WIDTH_PRESETS, [
		{ value: 320, label: "Narrow" },
		{ value: 400, label: "Standard" },
		{ value: 520, label: "Wide" },
	]);
	assert.equal(MIN_LIST_PANE_WIDTH, 320);
	assert.equal(MAX_LIST_PANE_WIDTH, 640);
	assert.equal(MIN_CONVERSATION_PANE_WIDTH, 480);
	assert.equal(SPLIT_VIEW_MIN_WIDTH, 801);
	assert.equal(normalizeListPaneWidth(319), 320);
	assert.equal(normalizeListPaneWidth(401.6), 402);
	assert.equal(normalizeListPaneWidth(700), 640);
	assert.equal(normalizeListPaneWidth(Number.NaN), 400);
});

test("the parser accepts only the complete version 1 schema", () => {
	const valid = {
		version: 1,
		mailDensity: "compact",
		listPaneWidth: 520,
		conversationIntelligenceExpanded: true,
	};

	assert.deepEqual(parseWorkspacePreferences(valid), valid);
	for (const invalid of [
		null,
		{ ...valid, version: 2 },
		{ ...valid, mailDensity: "dense" },
		{ ...valid, listPaneWidth: MIN_LIST_PANE_WIDTH - 1 },
		{ ...valid, listPaneWidth: MAX_LIST_PANE_WIDTH + 1 },
		{ ...valid, listPaneWidth: 400.5 },
		{ ...valid, conversationIntelligenceExpanded: "true" },
		{ ...valid, surprise: true },
		{
			version: 1,
			mailDensity: "compact",
			listPaneWidth: 520,
		},
	]) {
		assert.equal(parseWorkspacePreferences(invalid), null);
	}
});

test("browser-local persistence falls back safely and emits one strict payload", () => {
	const entries = new Map<string, string>();
	const storage = {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value);
		},
	};

	assert.deepEqual(readWorkspacePreferences(storage), DEFAULT_WORKSPACE_PREFERENCES);
	writeWorkspacePreferences(
		{
			version: 1,
			mailDensity: "compact",
			listPaneWidth: 520,
			conversationIntelligenceExpanded: true,
		},
		storage,
	);
	assert.deepEqual(readWorkspacePreferences(storage), {
		version: 1,
		mailDensity: "compact",
		listPaneWidth: 520,
		conversationIntelligenceExpanded: true,
	});
	const validSerialized = entries.get("mail-portal.workspace-preferences");
	writeWorkspacePreferences(
		{
			version: 1,
			mailDensity: "compact",
			listPaneWidth: 900,
			conversationIntelligenceExpanded: true,
		},
		storage,
	);
	assert.equal(
		entries.get("mail-portal.workspace-preferences"),
		validSerialized,
		"invalid runtime values must never replace valid persisted preferences",
	);

	entries.clear();
	entries.set("mail-portal.workspace-preferences", "not json");
	assert.deepEqual(readWorkspacePreferences(storage), DEFAULT_WORKSPACE_PREFERENCES);
	assert.doesNotThrow(() =>
		writeWorkspacePreferences(DEFAULT_WORKSPACE_PREFERENCES, {
			getItem: () => null,
			setItem: () => {
				throw new Error("blocked");
			},
		}),
	);
});
