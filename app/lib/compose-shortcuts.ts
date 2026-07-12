export type ComposeShortcutAction =
	| "submit"
	| "save"
	| "ai-generate"
	| "ignore";

export type ComposeShortcutOrigin =
	| "primary"
	| "ai-prompt"
	| "ai-panel"
	| "nested-overlay"
	| "outside";

export function planComposeShortcut(input: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat: boolean;
	isImeComposing: boolean;
	composeActive: boolean;
	hasBlockingState: boolean;
	defaultPrevented: boolean;
	origin: ComposeShortcutOrigin;
}): ComposeShortcutAction {
	const hasExactPrimaryModifier = input.metaKey !== input.ctrlKey;
	if (
		input.defaultPrevented ||
		(input.origin !== "primary" && input.origin !== "ai-prompt") ||
		!input.composeActive ||
		input.hasBlockingState ||
		input.repeat ||
		input.isImeComposing ||
		input.altKey ||
		input.shiftKey ||
		!hasExactPrimaryModifier
	) return "ignore";

	if (input.key === "Enter") {
		return input.origin === "ai-prompt"
			? "ai-generate"
			: "submit";
	}
	return input.key.toLowerCase() === "s" ? "save" : "ignore";
}
