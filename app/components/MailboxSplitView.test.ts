import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("./MailboxSplitView.tsx", import.meta.url),
	"utf8",
);

test("split mode follows observed container width instead of viewport classes", () => {
	assert.match(source, /ref=\{containerRef\}/);
	assert.match(source, /typeof ResizeObserver !== "undefined"/);
	assert.match(source, /observer\.observe\(container\)/);
	assert.match(source, /supportsSplitView\(containerWidth\)/);
	assert.match(source, /isPanelOpen && !isSplitView \? "hidden" : "flex"/);
	assert.doesNotMatch(source, /md:w-\[/);
});

test("the list uses a clamped stored width without a width transition", () => {
	assert.match(source, /closePanel, listPaneWidth, setListPaneWidth/);
	assert.match(
		source,
		/clampListPaneWidth\(livePointerWidth \?\? listPaneWidth, containerWidth\)/,
	);
	assert.match(source, /style=\{isSplitView \? \{ width: `\$\{renderedListPaneWidth\}px` \} : undefined\}/);
	assert.doesNotMatch(source, /transition-(?:all|\[width\]|\[inline-size\])/);
});

test("the separator exposes a 44 pixel target and complete ARIA value semantics", () => {
	assert.match(source, /role="separator"/);
	assert.match(source, /aria-label="Resize message list"/);
	assert.match(source, /aria-orientation="vertical"/);
	assert.match(source, /aria-valuemin=\{bounds\.min\}/);
	assert.match(source, /aria-valuemax=\{bounds\.max\}/);
	assert.match(source, /aria-valuenow=\{renderedListPaneWidth\}/);
	assert.match(source, /aria-valuetext=\{ariaValueText\}/);
	assert.match(source, /\bw-11\b/);
});

test("pointer resizing owns one pointer, clamps live width, and persists on release only", () => {
	assert.match(source, /event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
	assert.match(source, /active\.pointerId !== event\.pointerId/);
	assert.match(source, /event\.currentTarget\.hasPointerCapture\(event\.pointerId\)/);
	assert.match(source, /listPaneWidthFromPointer\(/);
	assert.match(source, /onPointerUp=\{\(event\) => finishPointerResize\(event, true\)\}/);
	assert.match(source, /onPointerCancel=\{\(event\) => finishPointerResize\(event, false\)\}/);
	assert.match(source, /onLostPointerCapture=\{\(event\) => finishPointerResize\(event, false\)\}/);
	assert.match(source, /clientX: event\.clientX,[\s\S]*?containerWidth/);
	assert.match(source, /if \(persist && finalWidth !== null\) setListPaneWidth\(finalWidth\)/);
});

test("keyboard resizing is isolated from mail shortcuts and narrow desktop retains Back", () => {
	assert.match(source, /RESIZE_KEYS\.has\(event\.key as ListPaneResizeKey\)/);
	assert.match(source, /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);/);
	assert.match(source, /listPaneWidthFromKey\(/);
	assert.match(source, /!isSplitView && \(/);
	assert.match(source, /hidden min-h-11[^"]*md:flex/);
	assert.match(source, /Back to messages/);
	assert.match(source, /md:hidden/);
});
