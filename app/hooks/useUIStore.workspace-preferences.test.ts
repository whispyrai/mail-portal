import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_WORKSPACE_PREFERENCES,
	WORKSPACE_PREFERENCES_STORAGE_KEY,
} from "../lib/workspace-preferences.ts";
import { useUIStore } from "./useUIStore.ts";

function installWindowStorage(entries: Map<string, string>) {
	const previousWindow = Reflect.get(globalThis, "window");
	Reflect.set(globalThis, "window", {
		localStorage: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
		},
	});
	return () => {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalThis, "window");
		} else {
			Reflect.set(globalThis, "window", previousWindow);
		}
	};
}

test("workspace defaults are SSR-safe and each setter persists the complete contract", () => {
	const entries = new Map<string, string>();
	const restoreWindow = installWindowStorage(entries);
	try {
		useUIStore.setState({
			mailDensity: DEFAULT_WORKSPACE_PREFERENCES.mailDensity,
			listPaneWidth: DEFAULT_WORKSPACE_PREFERENCES.listPaneWidth,
			conversationIntelligenceExpanded:
				DEFAULT_WORKSPACE_PREFERENCES.conversationIntelligenceExpanded,
		});
		const initial = useUIStore.getState();
		assert.equal(initial.mailDensity, "comfortable");
		assert.equal(initial.listPaneWidth, 400);
		assert.equal(initial.conversationIntelligenceExpanded, false);

		initial.setMailDensity("compact");
		useUIStore.getState().setListPaneWidth(519.7);
		useUIStore.getState().setConversationIntelligenceExpanded(true);
		assert.deepEqual(
			JSON.parse(entries.get(WORKSPACE_PREFERENCES_STORAGE_KEY) ?? "null"),
			{
				version: 1,
				mailDensity: "compact",
				listPaneWidth: 520,
				conversationIntelligenceExpanded: true,
			},
		);
	} finally {
		restoreWindow();
	}
});

test("client hydration applies valid preferences atomically and rejects stale versions", () => {
	const entries = new Map<string, string>([
		[
			WORKSPACE_PREFERENCES_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				mailDensity: "compact",
				listPaneWidth: 520,
				conversationIntelligenceExpanded: true,
			}),
		],
	]);
	const restoreWindow = installWindowStorage(entries);
	try {
		useUIStore.setState({
			mailDensity: "comfortable",
			listPaneWidth: 400,
			conversationIntelligenceExpanded: false,
		});
		useUIStore.getState().hydrateWorkspacePreferences();
		assert.deepEqual(
			{
				mailDensity: useUIStore.getState().mailDensity,
				listPaneWidth: useUIStore.getState().listPaneWidth,
				conversationIntelligenceExpanded:
					useUIStore.getState().conversationIntelligenceExpanded,
			},
			{
				mailDensity: "compact",
				listPaneWidth: 520,
				conversationIntelligenceExpanded: true,
			},
		);

		entries.set(
			WORKSPACE_PREFERENCES_STORAGE_KEY,
			JSON.stringify({
				version: 2,
				mailDensity: "compact",
				listPaneWidth: 520,
				conversationIntelligenceExpanded: true,
			}),
		);
		useUIStore.getState().hydrateWorkspacePreferences();
		assert.equal(useUIStore.getState().mailDensity, "comfortable");
		assert.equal(useUIStore.getState().listPaneWidth, 400);
		assert.equal(
			useUIStore.getState().conversationIntelligenceExpanded,
			false,
		);
	} finally {
		restoreWindow();
	}
});
