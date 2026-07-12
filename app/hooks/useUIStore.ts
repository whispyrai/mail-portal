// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import type { Email } from "~/types";
import { clearComposeRecovery } from "../lib/compose-recovery.ts";
import {
	DEFAULT_WORKSPACE_PREFERENCES,
	WORKSPACE_PREFERENCES_VERSION,
	normalizeListPaneWidth,
	readWorkspacePreferences,
	writeWorkspacePreferences,
	type MailDensity,
} from "../lib/workspace-preferences.ts";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
}

const AGENT_PANEL_STORAGE_KEY = "whispyr.agentPanelOpen";

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null) => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: (restorePreviousSelection?: boolean) => void;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel (collapsible + persisted; see hydrateAgentPanel for SSR-safe load)
	isAgentPanelOpen: boolean;
	toggleAgentPanel: () => void;
	setAgentPanelOpen: (open: boolean) => void;
	hydrateAgentPanel: () => void;

	// Mail workspace preferences (SSR-safe defaults; hydrated client-side).
	mailDensity: MailDensity;
	listPaneWidth: number;
	conversationIntelligenceExpanded: boolean;
	setMailDensity: (density: MailDensity) => void;
	setListPaneWidth: (width: number) => void;
	setConversationIntelligenceExpanded: (expanded: boolean) => void;
	hydrateWorkspacePreferences: () => void;
}

/** Persist the agent-panel open/closed choice so it survives reloads. */
function persistAgentPanel(open: boolean) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, open ? "1" : "0");
	} catch {
		// localStorage unavailable (private mode etc.) — non-fatal.
	}
}

function persistWorkspacePreferences(
	state: Pick<
		UIState,
		| "mailDensity"
		| "listPaneWidth"
		| "conversationIntelligenceExpanded"
	>,
) {
	writeWorkspacePreferences({
		version: WORKSPACE_PREFERENCES_VERSION,
		mailDensity: state.mailDensity,
		listPaneWidth: state.listPaneWidth,
		conversationIntelligenceExpanded:
			state.conversationIntelligenceExpanded,
	});
}

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isSidebarOpen: false,
	// Start collapsed so the panel never hides content on first paint. The real
	// preference is loaded client-side via hydrateAgentPanel() to avoid an SSR
	// hydration mismatch.
	isAgentPanelOpen: false,
	mailDensity: DEFAULT_WORKSPACE_PREFERENCES.mailDensity,
	listPaneWidth: DEFAULT_WORKSPACE_PREFERENCES.listPaneWidth,
	conversationIntelligenceExpanded:
		DEFAULT_WORKSPACE_PREFERENCES.conversationIntelligenceExpanded,

	selectEmail: (id) =>
		set((state) => ({
			selectedEmailId: id,
			isComposing: state.isComposing,
		})),

	startCompose: (options) =>
		set((state) => {
			clearComposeRecovery();
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			return {
				isComposing: true,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible behind the modal
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	closePanel: () =>
		set((state) =>
			state.isComposing
				? { selectedEmailId: null }
				: {
						selectedEmailId: null,
						isComposing: false,
						_previousEmailId: null,
						composeOptions: { mode: "new" as const, originalEmail: null },
					},
		),

	closeCompose: (restorePreviousSelection = true) =>
		set((state) => {
			clearComposeRecovery();
			return {
			isComposing: false,
			selectedEmailId: restorePreviousSelection
				? state._previousEmailId
				: null,
			_previousEmailId: null,
			composeOptions: { mode: "new" as const, originalEmail: null },
			};
		}),

	openSidebar: () => set({ isSidebarOpen: true }),
	closeSidebar: () => set({ isSidebarOpen: false }),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	toggleAgentPanel: () =>
		set(() => {
			const next = !get().isAgentPanelOpen;
			persistAgentPanel(next);
			return { isAgentPanelOpen: next };
		}),

	setAgentPanelOpen: (open) =>
		set(() => {
			persistAgentPanel(open);
			return { isAgentPanelOpen: open };
		}),

	hydrateAgentPanel: () => {
		if (typeof window === "undefined") return;
		try {
			const stored = window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY);
			if (stored !== null) set({ isAgentPanelOpen: stored === "1" });
		} catch {
			// ignore
		}
	},

	setMailDensity: (mailDensity) =>
		set((state) => {
			const next = { ...state, mailDensity };
			persistWorkspacePreferences(next);
			return { mailDensity };
		}),

	setListPaneWidth: (width) =>
		set((state) => {
			const listPaneWidth = normalizeListPaneWidth(width);
			const next = { ...state, listPaneWidth };
			persistWorkspacePreferences(next);
			return { listPaneWidth };
		}),

	setConversationIntelligenceExpanded: (
		conversationIntelligenceExpanded,
	) =>
		set((state) => {
			const next = { ...state, conversationIntelligenceExpanded };
			persistWorkspacePreferences(next);
			return { conversationIntelligenceExpanded };
		}),

	hydrateWorkspacePreferences: () => {
		const preferences = readWorkspacePreferences();
		set({
			mailDensity: preferences.mailDensity,
			listPaneWidth: preferences.listPaneWidth,
			conversationIntelligenceExpanded:
				preferences.conversationIntelligenceExpanded,
		});
	},
}));
