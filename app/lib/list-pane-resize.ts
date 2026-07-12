import {
	DEFAULT_LIST_PANE_WIDTH,
	LIST_PANE_WIDTH_PRESETS,
	MAX_LIST_PANE_WIDTH,
	MIN_CONVERSATION_PANE_WIDTH,
	MIN_LIST_PANE_WIDTH,
	SPLIT_VIEW_MIN_WIDTH,
} from "./workspace-preferences.ts";

export {
	MIN_CONVERSATION_PANE_WIDTH,
	SPLIT_VIEW_MIN_WIDTH,
} from "./workspace-preferences.ts";
export const LIST_PANE_RESIZE_STEP = 16;
export const LIST_PANE_RESIZE_LARGE_STEP = 48;

export type ListPaneResizeKey =
	| "ArrowLeft"
	| "ArrowRight"
	| "Home"
	| "End"
	| "Enter";

export interface ListPaneBounds {
	min: number;
	max: number;
}

function wholeFinitePixels(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.round(value) : fallback;
}

export function supportsSplitView(containerWidth: number | null): boolean {
	return containerWidth !== null &&
		Number.isFinite(containerWidth) &&
		containerWidth >= SPLIT_VIEW_MIN_WIDTH;
}

export function listPaneBounds(containerWidth: number): ListPaneBounds {
	const available = wholeFinitePixels(
		containerWidth,
		SPLIT_VIEW_MIN_WIDTH,
	) - MIN_CONVERSATION_PANE_WIDTH;
	return {
		min: MIN_LIST_PANE_WIDTH,
		max: Math.max(
			MIN_LIST_PANE_WIDTH,
			Math.min(MAX_LIST_PANE_WIDTH, available),
		),
	};
}

export function clampListPaneWidth(
	width: number,
	containerWidth: number,
): number {
	const bounds = listPaneBounds(containerWidth);
	return Math.min(
		bounds.max,
		Math.max(bounds.min, wholeFinitePixels(width, DEFAULT_LIST_PANE_WIDTH)),
	);
}

export function listPaneWidthFromPointer(input: {
	startWidth: number;
	startClientX: number;
	clientX: number;
	containerWidth: number;
}): number {
	const pointerDelta = input.clientX - input.startClientX;
	return clampListPaneWidth(
		input.startWidth + pointerDelta,
		input.containerWidth,
	);
}

export function listPaneWidthFromKey(input: {
	currentWidth: number;
	key: ListPaneResizeKey;
	shiftKey: boolean;
	containerWidth: number;
}): number {
	const step = input.shiftKey
		? LIST_PANE_RESIZE_LARGE_STEP
		: LIST_PANE_RESIZE_STEP;
	let nextWidth = input.currentWidth;

	switch (input.key) {
		case "ArrowLeft":
			nextWidth -= step;
			break;
		case "ArrowRight":
			nextWidth += step;
			break;
		case "Home":
			nextWidth = LIST_PANE_WIDTH_PRESETS[0].value;
			break;
		case "End":
			nextWidth = LIST_PANE_WIDTH_PRESETS[2].value;
			break;
		case "Enter":
			nextWidth = LIST_PANE_WIDTH_PRESETS[1].value;
			break;
	}

	return clampListPaneWidth(nextWidth, input.containerWidth);
}
