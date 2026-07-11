import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveMailShortcut,
	resolveVisibleMailTargetId,
} from "./mail-keyboard.ts";

function shortcut(
	key: string,
	overrides: Partial<Parameters<typeof resolveMailShortcut>[0]> = {},
) {
	return resolveMailShortcut({
		key,
		isTextEntry: false,
		isComposing: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...overrides,
	});
}

test("maps primary mail navigation and triage shortcuts", () => {
	assert.deepEqual(shortcut("j"), { command: "next-message" });
	assert.deepEqual(shortcut("k"), { command: "previous-message" });
	assert.deepEqual(shortcut("Enter"), { command: "open-message" });
	assert.deepEqual(shortcut("Escape"), { command: "close-surface" });
	assert.deepEqual(shortcut("c"), { command: "compose" });
	assert.deepEqual(shortcut("/"), { command: "focus-search" });
	assert.deepEqual(shortcut("r"), { command: "reply" });
	assert.deepEqual(shortcut("e"), { command: "archive" });
	assert.deepEqual(shortcut("#"), { command: "trash" });
	assert.deepEqual(shortcut("u"), { command: "toggle-unread" });
	assert.deepEqual(shortcut("s"), { command: "toggle-star" });
	assert.deepEqual(shortcut("?"), { command: "show-shortcuts" });
});

test("supports g-prefixed folder navigation", () => {
	assert.deepEqual(shortcut("g"), { nextPrefix: "g" });
	assert.deepEqual(shortcut("i", { pendingPrefix: "g" }), {
		command: "go-inbox",
	});
	assert.deepEqual(shortcut("s", { pendingPrefix: "g" }), {
		command: "go-sent",
	});
	assert.deepEqual(shortcut("d", { pendingPrefix: "g" }), {
		command: "go-drafts",
	});
	assert.deepEqual(shortcut("a", { pendingPrefix: "g" }), {
		command: "go-archive",
	});
	assert.deepEqual(shortcut("x", { pendingPrefix: "g" }), {});
});

test("never hijacks text entry, IME composition, or modified browser keys", () => {
	assert.deepEqual(shortcut("c", { isTextEntry: true }), {});
	assert.deepEqual(shortcut("j", { isComposing: true }), {});
	assert.deepEqual(shortcut("r", { ctrlKey: true }), {});
	assert.deepEqual(shortcut("s", { metaKey: true }), {});
	assert.deepEqual(shortcut("ArrowLeft", { altKey: true }), {});
	assert.deepEqual(shortcut("Escape", { isTextEntry: true }), {});
});

test("current-conversation commands never fall back to an unrelated first row", () => {
	const visibleIds = ["first", "selected"];
	assert.equal(
		resolveVisibleMailTargetId(visibleIds, "selected", false),
		"selected",
	);
	assert.equal(resolveVisibleMailTargetId(visibleIds, null, false), null);
	assert.equal(resolveVisibleMailTargetId(visibleIds, "stale", false), null);
	assert.equal(resolveVisibleMailTargetId(visibleIds, null, true), "first");
	assert.equal(resolveVisibleMailTargetId(visibleIds, "stale", true), "first");
});
