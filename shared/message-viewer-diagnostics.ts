// What the message viewer reports about one render, so a body that shows on one
// laptop and stays blank on another can be told apart from the server logs.
// Content-free by construction: lengths, sizes and states only, never text.

export const MESSAGE_VIEWER_OUTCOMES = [
	// The frame reported in and drew text.
	"rendered",
	// The frame reported in, the sanitized body has text, but nothing was drawn.
	"blank",
	// The frame never reported in, so the real document never ran.
	"never_reported",
] as const;

export type MessageViewerOutcome = (typeof MESSAGE_VIEWER_OUTCOMES)[number];

export type MessageViewerReport = {
	messageId: string;
	folderId: string | null;
	bodyExternal: boolean;
	outcome: MessageViewerOutcome;
	// "settled" once the retry window has passed; "left" when the reader moved on first.
	trigger: "settled" | "left";
	elapsedMs: number;
	retries: number;
	firstReportMs: number | null;
	reportedHeight: number | null;
	frameTextLength: number | null;
	bodyLength: number;
	sanitizedLength: number;
	sanitizedTextLength: number;
	frameClientWidth: number;
	frameClientHeight: number;
	frameDisplayed: boolean;
	remoteImagesBlocked: boolean;
	inlineImageCount: number;
	documentVisibility: string;
	viewportWidth: number;
	viewportHeight: number;
	devicePixelRatio: number;
	// The served chunk URL; its hash tells which build the laptop is running.
	build: string;
};

const MAX_ID_LENGTH = 300;
const MAX_TEXT_LENGTH = 200;
const MAX_METRIC = 100_000_000;

function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isMetric(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC;
}

function isNullableMetric(value: unknown): value is number | null {
	return value === null || isMetric(value);
}

const REPORT_KEYS = new Set<string>([
	"messageId", "folderId", "bodyExternal", "outcome", "trigger", "elapsedMs",
	"retries", "firstReportMs", "reportedHeight", "frameTextLength", "bodyLength",
	"sanitizedLength", "sanitizedTextLength", "frameClientWidth", "frameClientHeight",
	"frameDisplayed", "remoteImagesBlocked", "inlineImageCount", "documentVisibility",
	"viewportWidth", "viewportHeight", "devicePixelRatio", "build",
]);

/** Returns the report when every field is present, bounded and typed; otherwise null. */
export function parseMessageViewerReport(input: unknown): MessageViewerReport | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const value = input as Record<string, unknown>;
	const keys = Object.keys(value);
	if (keys.length !== REPORT_KEYS.size || keys.some((key) => !REPORT_KEYS.has(key))) {
		return null;
	}
	const valid =
		isBoundedString(value.messageId, MAX_ID_LENGTH) &&
		(value.folderId === null || isBoundedString(value.folderId, MAX_TEXT_LENGTH)) &&
		typeof value.bodyExternal === "boolean" &&
		(MESSAGE_VIEWER_OUTCOMES as readonly unknown[]).includes(value.outcome) &&
		(value.trigger === "settled" || value.trigger === "left") &&
		isMetric(value.elapsedMs) &&
		isMetric(value.retries) &&
		isNullableMetric(value.firstReportMs) &&
		isNullableMetric(value.reportedHeight) &&
		isNullableMetric(value.frameTextLength) &&
		isMetric(value.bodyLength) &&
		isMetric(value.sanitizedLength) &&
		isMetric(value.sanitizedTextLength) &&
		isMetric(value.frameClientWidth) &&
		isMetric(value.frameClientHeight) &&
		typeof value.frameDisplayed === "boolean" &&
		typeof value.remoteImagesBlocked === "boolean" &&
		isMetric(value.inlineImageCount) &&
		isBoundedString(value.documentVisibility, MAX_TEXT_LENGTH) &&
		isMetric(value.viewportWidth) &&
		isMetric(value.viewportHeight) &&
		isMetric(value.devicePixelRatio) &&
		isBoundedString(value.build, MAX_TEXT_LENGTH);
	return valid ? (value as MessageViewerReport) : null;
}
