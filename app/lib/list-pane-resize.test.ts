import assert from "node:assert/strict";
import test from "node:test";
import {
	clampListPaneWidth,
	LIST_PANE_RESIZE_LARGE_STEP,
	LIST_PANE_RESIZE_STEP,
	listPaneBounds,
	listPaneWidthFromKey,
	listPaneWidthFromPointer,
	MIN_CONVERSATION_PANE_WIDTH,
	SPLIT_VIEW_MIN_WIDTH,
	supportsSplitView,
} from "./list-pane-resize.ts";

test("split mode follows the actual container threshold", () => {
	assert.equal(supportsSplitView(null), false);
	assert.equal(supportsSplitView(Number.NaN), false);
	assert.equal(supportsSplitView(SPLIT_VIEW_MIN_WIDTH - 1), false);
	assert.equal(supportsSplitView(SPLIT_VIEW_MIN_WIDTH), true);
});

test("container bounds reserve the Conversation minimum and honor the safe range", () => {
	assert.deepEqual(listPaneBounds(SPLIT_VIEW_MIN_WIDTH), { min: 320, max: 321 });
	assert.deepEqual(listPaneBounds(1_120), { min: 320, max: 640 });
	assert.equal(
		listPaneBounds(900).max + MIN_CONVERSATION_PANE_WIDTH,
		900,
	);
	assert.equal(clampListPaneWidth(700, 900), 420);
	assert.equal(clampListPaneWidth(100, 1_200), 320);
	assert.equal(clampListPaneWidth(400.6, 1_200), 401);
});

test("pointer resizing owns the initial width and clamps every live value", () => {
	assert.equal(
		listPaneWidthFromPointer({
			startWidth: 400,
			startClientX: 600,
			clientX: 660,
			containerWidth: 1_200,
		}),
		460,
	);
	assert.equal(
		listPaneWidthFromPointer({
			startWidth: 400,
			startClientX: 600,
			clientX: 2_000,
			containerWidth: 900,
		}),
		420,
	);
});

test("keyboard resizing supports small, shifted, and preset semantics", () => {
	assert.equal(LIST_PANE_RESIZE_STEP, 16);
	assert.equal(LIST_PANE_RESIZE_LARGE_STEP, 48);
	const width = (key: "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Enter", shiftKey = false) =>
		listPaneWidthFromKey({
			currentWidth: 400,
			key,
			shiftKey,
			containerWidth: 1_200,
		});

	assert.equal(width("ArrowLeft"), 384);
	assert.equal(width("ArrowRight"), 416);
	assert.equal(width("ArrowLeft", true), 352);
	assert.equal(width("ArrowRight", true), 448);
	assert.equal(width("Home"), 320);
	assert.equal(width("End"), 520);
	assert.equal(width("Enter"), 400);
});
