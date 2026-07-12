import {
	ATTACHMENT_KINDS,
	type AttachmentKind,
} from "../../../shared/mailbox-attachments.ts";

export interface AttachmentWorkbenchState {
	q: string;
	kind: AttachmentKind | "";
	invalidKind: string | null;
	folder: string;
	selected: string | null;
}

export interface AttachmentWorkbenchFilters {
	q: string;
	kind: AttachmentKind | "";
	folder: string;
}

function normalizedText(value: string | null): string {
	return value?.trim().normalize("NFC") ?? "";
}

function boundedDisplayValue(value: string): string {
	const safe = value
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "")
		.trim();
	const characters = [...safe];
	return characters.length > 60
		? `${characters.slice(0, 60).join("")}…`
		: safe || "invalid value";
}

export function attachmentWorkbenchStateFromParams(
	params: URLSearchParams,
): AttachmentWorkbenchState {
	const rawKind = normalizedText(params.get("kind")).toLowerCase();
	const validKind = !rawKind || ATTACHMENT_KINDS.includes(rawKind as AttachmentKind);
	return {
		q: normalizedText(params.get("q")),
		kind: rawKind && validKind
			? rawKind as AttachmentKind
			: "",
		invalidKind: validKind ? null : boundedDisplayValue(rawKind),
		folder: normalizedText(params.get("folder")),
		selected: normalizedText(params.get("selected")) || null,
	};
}

function setOptional(params: URLSearchParams, key: string, value: string): void {
	if (value) params.set(key, value);
	else params.delete(key);
}

export function paramsWithAttachmentFilter(
	current: URLSearchParams,
	filters: AttachmentWorkbenchFilters,
): URLSearchParams {
	const next = new URLSearchParams(current);
	setOptional(next, "q", normalizedText(filters.q));
	setOptional(next, "kind", filters.kind);
	setOptional(next, "folder", normalizedText(filters.folder));
	next.delete("selected");
	return next;
}

export function paramsWithSelectedAttachment(
	current: URLSearchParams,
	attachmentId: string | null,
): URLSearchParams {
	const next = new URLSearchParams(current);
	setOptional(next, "selected", normalizedText(attachmentId));
	return next;
}
