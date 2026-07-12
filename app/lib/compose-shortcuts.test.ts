import assert from "node:assert/strict";
import test from "node:test";
import {
	planComposeShortcut,
	type ComposeShortcutOrigin,
} from "./compose-shortcuts.ts";

const base: Parameters<typeof planComposeShortcut>[0] = {
	key: "Enter",
	metaKey: true,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	isImeComposing: false,
	composeActive: true,
	hasBlockingState: false,
	defaultPrevented: false,
	origin: "primary",
};

test("compose shortcuts accept only exact, active, unblocked primary-modifier chords", () => {
	assert.equal(planComposeShortcut(base), "submit");
	assert.equal(planComposeShortcut({ ...base, metaKey: false, ctrlKey: true }), "submit");
	assert.equal(planComposeShortcut({ ...base, key: "s" }), "save");
	assert.equal(planComposeShortcut({ ...base, key: "S" }), "save");

	for (const input of [
		{ ...base, repeat: true },
		{ ...base, isImeComposing: true },
		{ ...base, altKey: true },
		{ ...base, shiftKey: true },
		{ ...base, metaKey: true, ctrlKey: true },
		{ ...base, metaKey: false, ctrlKey: false },
		{ ...base, composeActive: false },
		{ ...base, hasBlockingState: true },
		{ ...base, key: "x" },
	]) assert.equal(planComposeShortcut(input), "ignore");
});

test("AI prompt owns exact primary-modifier Enter without submitting compose", () => {
	assert.equal(
		planComposeShortcut({ ...base, origin: "ai-prompt" }),
		"ai-generate",
	);
	assert.equal(
		planComposeShortcut({ ...base, origin: "ai-prompt", key: "s" }),
		"save",
	);
});

test("consumed and non-primary surface events never act behind their owner", () => {
	assert.equal(
		planComposeShortcut({
			...base,
			defaultPrevented: true,
			origin: "primary",
		}),
		"ignore",
	);
	const nonPrimaryOrigins: ComposeShortcutOrigin[] = [
		"ai-panel",
		"nested-overlay",
		"outside",
	];
	for (const origin of nonPrimaryOrigins) {
		assert.equal(
			planComposeShortcut({
				...base,
				defaultPrevented: false,
				origin,
			}),
			"ignore",
		);
	}
});
