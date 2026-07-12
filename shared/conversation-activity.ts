export const CONVERSATION_ACTIVITY_LIMITS = {
	defaultPageSize: 25,
	maxPageSize: 50,
	cursorChars: 512,
	eventIdChars: 200,
	actorLabelChars: 320,
} as const;

export type ConversationActivityCode =
	| "message_received"
	| "marked_read"
	| "marked_unread"
	| "starred"
	| "unstarred"
	| "archived"
	| "trashed"
	| "restored"
	| "snoozed"
	| "returned"
	| "label_added"
	| "label_removed"
	| "draft_created"
	| "draft_updated"
	| "send_queued"
	| "delivery_accepted"
	| "send_cancelled"
	| "retry_requested"
	| "bounced"
	| "complaint"
	| "automatically_returned";

export const CONVERSATION_ACTIVITY_LABELS = {
	message_received: "Message received",
	marked_read: "Marked read",
	marked_unread: "Marked unread",
	starred: "Starred",
	unstarred: "Unstarred",
	archived: "Archived",
	trashed: "Moved to Trash",
	restored: "Restored",
	snoozed: "Snoozed",
	returned: "Returned to mailbox",
	label_added: "Label added",
	label_removed: "Label removed",
	draft_created: "Draft created",
	draft_updated: "Draft updated",
	send_queued: "Send queued",
	delivery_accepted: "Delivery accepted",
	send_cancelled: "Send cancelled",
	retry_requested: "Retry requested",
	bounced: "Delivery bounced",
	complaint: "Complaint recorded",
	automatically_returned: "Returned automatically",
} as const satisfies Record<ConversationActivityCode, string>;

export type ConversationActivityActorKind =
	| "person"
	| "assistant"
	| "mcp"
	| "automation"
	| "system";

export type ConversationActivityActor = {
	kind: ConversationActivityActorKind;
	label: string;
};

export type ConversationActivityItem = {
	id: string;
	code: ConversationActivityCode;
	label: string;
	actor: ConversationActivityActor;
	occurredAt: string;
};

export type ConversationActivityPage = {
	items: ConversationActivityItem[];
	nextCursor: string | null;
};

export type ConversationActivityQuery = {
	limit: number;
	cursor: string | null;
};

export function parseConversationActivityQuery(input: {
	limit?: string;
	cursor?: string;
}): ConversationActivityQuery {
	let limit: number = CONVERSATION_ACTIVITY_LIMITS.defaultPageSize;
	if (input.limit !== undefined) {
		if (!/^[1-9]\d*$/.test(input.limit)) {
			throw new Error("Conversation activity limit is invalid");
		}
		limit = Number(input.limit);
		if (
			!Number.isSafeInteger(limit) ||
			limit > CONVERSATION_ACTIVITY_LIMITS.maxPageSize
		) {
			throw new Error("Conversation activity limit is invalid");
		}
	}
	let cursor: string | null = null;
	if (input.cursor !== undefined) {
		if (
			input.cursor.length < 1 ||
			input.cursor.length > CONVERSATION_ACTIVITY_LIMITS.cursorChars ||
			!/^[A-Za-z0-9_-]+$/.test(input.cursor)
		) {
			throw new Error("Conversation activity cursor is invalid");
		}
		cursor = input.cursor;
	}
	return { limit, cursor };
}
