export const WORKSPACE_PREFERENCES_STORAGE_KEY =
	"mail-portal.workspace-preferences";
export const WORKSPACE_PREFERENCES_VERSION = 1 as const;

export const MIN_LIST_PANE_WIDTH = 320;
export const DEFAULT_LIST_PANE_WIDTH = 400;
export const MAX_LIST_PANE_WIDTH = 640;
export const MIN_CONVERSATION_PANE_WIDTH = 480;
export const SPLIT_VIEW_MIN_WIDTH = 801;

export const LIST_PANE_WIDTH_PRESETS = [
	{ value: 320, label: "Narrow" },
	{ value: 400, label: "Standard" },
	{ value: 520, label: "Wide" },
] as const;

export type MailDensity = "comfortable" | "compact";

export interface WorkspacePreferences {
	version: typeof WORKSPACE_PREFERENCES_VERSION;
	mailDensity: MailDensity;
	listPaneWidth: number;
	conversationIntelligenceExpanded: boolean;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
	version: WORKSPACE_PREFERENCES_VERSION,
	mailDensity: "comfortable",
	listPaneWidth: DEFAULT_LIST_PANE_WIDTH,
	conversationIntelligenceExpanded: false,
};

export interface WorkspacePreferencesStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const WORKSPACE_PREFERENCE_KEYS = [
	"version",
	"mailDensity",
	"listPaneWidth",
	"conversationIntelligenceExpanded",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeListPaneWidth(width: number): number {
	if (!Number.isFinite(width)) return DEFAULT_LIST_PANE_WIDTH;
	return Math.min(
		MAX_LIST_PANE_WIDTH,
		Math.max(MIN_LIST_PANE_WIDTH, Math.round(width)),
	);
}

/** Accept only the current complete schema so corrupt or stale state cannot leak into UI. */
export function parseWorkspacePreferences(
	value: unknown,
): WorkspacePreferences | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value);
	if (
		keys.length !== WORKSPACE_PREFERENCE_KEYS.length ||
		!WORKSPACE_PREFERENCE_KEYS.every((key) => keys.includes(key))
	) {
		return null;
	}
	if (value.version !== WORKSPACE_PREFERENCES_VERSION) return null;
	if (value.mailDensity !== "comfortable" && value.mailDensity !== "compact") {
		return null;
	}
	if (
		typeof value.listPaneWidth !== "number" ||
		!Number.isInteger(value.listPaneWidth) ||
		value.listPaneWidth < MIN_LIST_PANE_WIDTH ||
		value.listPaneWidth > MAX_LIST_PANE_WIDTH
	) {
		return null;
	}
	if (typeof value.conversationIntelligenceExpanded !== "boolean") {
		return null;
	}

	return {
		version: WORKSPACE_PREFERENCES_VERSION,
		mailDensity: value.mailDensity,
		listPaneWidth: value.listPaneWidth,
		conversationIntelligenceExpanded:
			value.conversationIntelligenceExpanded,
	};
}

function browserStorage(): WorkspacePreferencesStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readWorkspacePreferences(
	storage: WorkspacePreferencesStorage | null = browserStorage(),
): WorkspacePreferences {
	if (!storage) return { ...DEFAULT_WORKSPACE_PREFERENCES };
	try {
		const serialized = storage.getItem(WORKSPACE_PREFERENCES_STORAGE_KEY);
		if (serialized === null) return { ...DEFAULT_WORKSPACE_PREFERENCES };
		return (
			parseWorkspacePreferences(JSON.parse(serialized)) ??
			{ ...DEFAULT_WORKSPACE_PREFERENCES }
		);
	} catch {
		return { ...DEFAULT_WORKSPACE_PREFERENCES };
	}
}

export function writeWorkspacePreferences(
	preferences: WorkspacePreferences,
	storage: WorkspacePreferencesStorage | null = browserStorage(),
): void {
	if (!storage) return;
	const parsed = parseWorkspacePreferences(preferences);
	if (!parsed) return;
	try {
		storage.setItem(
			WORKSPACE_PREFERENCES_STORAGE_KEY,
			JSON.stringify(parsed),
		);
	} catch {
		// Storage can be unavailable in private browsing or hardened environments.
	}
}
