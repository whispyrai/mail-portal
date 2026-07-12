import {
	CONVERSATION_ACTIVITY_LIMITS,
	CONVERSATION_ACTIVITY_LABELS,
	parseConversationActivityQuery,
	type ConversationActivityActor,
	type ConversationActivityActorKind,
	type ConversationActivityCode,
	type ConversationActivityItem,
	type ConversationActivityPage,
} from "../../shared/conversation-activity.ts";

export type {
	ConversationActivityActor,
	ConversationActivityActorKind,
	ConversationActivityCode,
	ConversationActivityItem,
	ConversationActivityPage,
};

export class ConversationActivityApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ConversationActivityApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const activityCodes = new Set<string>([
	"message_received",
	"marked_read",
	"marked_unread",
	"starred",
	"unstarred",
	"archived",
	"trashed",
	"restored",
	"snoozed",
	"returned",
	"label_added",
	"label_removed",
	"draft_created",
	"draft_updated",
	"send_queued",
	"delivery_accepted",
	"send_cancelled",
	"retry_requested",
	"bounced",
	"complaint",
	"automatically_returned",
]);
const actorKinds = new Set<string>([
	"person",
	"assistant",
	"mcp",
	"automation",
	"system",
]);
const CONTROL_TEXT = /[\u0000-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
	record: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedText(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") return null;
	if (
		!value ||
		value !== value.trim() ||
		value !== value.normalize("NFC") ||
		CONTROL_TEXT.test(value) ||
		Array.from(value).length > maxChars
	) return null;
	return value;
}

function invalidResponse(): never {
	throw new ConversationActivityApiError(
		502,
		"Conversation activity returned an invalid response",
	);
}

function isActivityCode(value: unknown): value is ConversationActivityCode {
	return typeof value === "string" && activityCodes.has(value);
}

function isActorKind(value: unknown): value is ConversationActivityActorKind {
	return typeof value === "string" && actorKinds.has(value);
}

function isPortalAccountEmail(value: string): boolean {
	const at = value.indexOf("@");
	return (
		value === value.toLowerCase() &&
		at > 0 &&
		at === value.lastIndexOf("@") &&
		at < value.length - 1 &&
		!/\s/u.test(value)
	);
}

function isSafeActorLabel(
	kind: ConversationActivityActorKind,
	label: string,
): boolean {
	if (kind === "system") return label === "Mail portal";
	if (kind === "automation") return label === "Automation";
	if (label === "Former team member") return true;
	if (kind === "person") return isPortalAccountEmail(label);
	if (kind === "mcp") {
		const suffix = " via MCP";
		return label.endsWith(suffix) &&
			isPortalAccountEmail(label.slice(0, -suffix.length));
	}
	if (label === "AI assistant") return true;
	const suffix = " via AI assistant";
	return label.endsWith(suffix) &&
		isPortalAccountEmail(label.slice(0, -suffix.length));
}

function parseActivityItem(value: unknown): ConversationActivityItem {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["id", "code", "label", "actor", "occurredAt"]) ||
		!isRecord(value.actor) ||
		!hasExactKeys(value.actor, ["kind", "label"])
	) invalidResponse();
	const id = boundedText(value.id, CONVERSATION_ACTIVITY_LIMITS.eventIdChars);
	const actorLabel = boundedText(
		value.actor.label,
		CONVERSATION_ACTIVITY_LIMITS.actorLabelChars,
	);
	const code = isActivityCode(value.code) ? value.code : null;
	const actorKind = isActorKind(value.actor.kind) ? value.actor.kind : null;
	const occurredAt = boundedText(value.occurredAt, 64);
	if (
		!id ||
		!actorLabel ||
		!code ||
		value.label !== CONVERSATION_ACTIVITY_LABELS[code] ||
		!actorKind ||
		!isSafeActorLabel(actorKind, actorLabel) ||
		!occurredAt ||
		!Number.isFinite(Date.parse(occurredAt)) ||
		new Date(occurredAt).toISOString() !== occurredAt
	) invalidResponse();
	return {
		id,
		code,
		label: CONVERSATION_ACTIVITY_LABELS[code],
		actor: { kind: actorKind, label: actorLabel },
		occurredAt,
	};
}

function parseActivityPage(value: unknown): ConversationActivityPage {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["items", "nextCursor"]) ||
		!Array.isArray(value.items) ||
		value.items.length > CONVERSATION_ACTIVITY_LIMITS.maxPageSize ||
		(value.nextCursor !== null && typeof value.nextCursor !== "string")
	) invalidResponse();
	if (typeof value.nextCursor === "string") {
		try {
			parseConversationActivityQuery({ cursor: value.nextCursor });
		} catch {
			invalidResponse();
		}
	}
	const items = value.items.map(parseActivityItem);
	if (new Set(items.map((item) => item.id)).size !== items.length) {
		invalidResponse();
	}
	for (let index = 1; index < items.length; index += 1) {
		const previous = items[index - 1]!;
		const current = items[index]!;
		const previousTime = Date.parse(previous.occurredAt);
		const currentTime = Date.parse(current.occurredAt);
		if (
			previousTime < currentTime ||
			(previousTime === currentTime && previous.id <= current.id)
		) invalidResponse();
	}
	return {
		items,
		nextCursor: value.nextCursor,
	};
}

export async function fetchConversationActivity(
	mailboxId: string,
	emailId: string,
	cursor: string | null,
	signal: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<ConversationActivityPage> {
	const query = new URLSearchParams({
		limit: String(CONVERSATION_ACTIVITY_LIMITS.defaultPageSize),
	});
	if (cursor) query.set("cursor", cursor);
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/activity?${query.toString()}`,
		{
			method: "GET",
			credentials: "same-origin",
			signal,
		},
	);
	if (!response.ok) {
		const message = response.status === 403
			? "Mailbox access changed."
			: response.status === 404
				? "Conversation is no longer available."
				: "Conversation activity is unavailable.";
		throw new ConversationActivityApiError(response.status, message);
	}
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		invalidResponse();
	}
	return parseActivityPage(value);
}
