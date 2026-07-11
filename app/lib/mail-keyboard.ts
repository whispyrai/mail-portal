export type MailCommand =
	| "next-message"
	| "previous-message"
	| "open-message"
	| "close-surface"
	| "compose"
	| "focus-search"
	| "reply"
	| "archive"
	| "trash"
	| "toggle-unread"
	| "toggle-star"
	| "refresh"
	| "show-shortcuts"
	| "go-inbox"
	| "go-sent"
	| "go-drafts"
	| "go-archive";

export interface MailShortcutInput {
	key: string;
	isTextEntry: boolean;
	isComposing: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	pendingPrefix?: "g";
}

export interface MailShortcutResolution {
	command?: MailCommand;
	nextPrefix?: "g";
}

/**
 * Resolve a command target only from the rows that are currently visible.
 * Navigation may deliberately initialize at the first row; commands that
 * mutate or reply to the current conversation must never use that fallback.
 */
export function resolveVisibleMailTargetId(
	visibleIds: readonly string[],
	currentId: string | null | undefined,
	allowInitialize: boolean,
): string | null {
	if (currentId && visibleIds.includes(currentId)) return currentId;
	return allowInitialize ? visibleIds[0] ?? null : null;
}

const DIRECT_COMMANDS: Readonly<Record<string, MailCommand>> = {
	j: "next-message",
	k: "previous-message",
	enter: "open-message",
	escape: "close-surface",
	c: "compose",
	"/": "focus-search",
	r: "reply",
	e: "archive",
	"#": "trash",
	u: "toggle-unread",
	s: "toggle-star",
	"?": "show-shortcuts",
};

const GO_COMMANDS: Readonly<Record<string, MailCommand>> = {
	i: "go-inbox",
	s: "go-sent",
	d: "go-drafts",
	a: "go-archive",
};

export function resolveMailShortcut(
	input: MailShortcutInput,
): MailShortcutResolution {
	const key = input.key.toLowerCase();

	if (input.isComposing || input.altKey || input.ctrlKey || input.metaKey) {
		return {};
	}
	if (input.isTextEntry) return {};

	if (input.pendingPrefix === "g") {
		const command = GO_COMMANDS[key];
		return command ? { command } : {};
	}

	if (key === "g") return { nextPrefix: "g" };
	const command = DIRECT_COMMANDS[key];
	return command ? { command } : {};
}

export function isMailShortcutProtectedTarget(
	target: EventTarget | null,
): boolean {
	if (!(target instanceof Element)) return false;
	if (
		target.closest(
			"input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='button'], [role='menuitem']",
		)
	) {
		return true;
	}
	return false;
}
