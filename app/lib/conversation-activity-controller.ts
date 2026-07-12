import type {
	ConversationActivityItem,
	ConversationActivityPage,
} from "../services/conversation-activity.ts";

export function conversationActivityContextKey(
	mailboxId: string,
	emailId: string,
): string {
	return `${encodeURIComponent(mailboxId)}:${encodeURIComponent(emailId)}`;
}

export function appendConversationActivityItems(
	current: readonly ConversationActivityItem[],
	incoming: readonly ConversationActivityItem[],
): ConversationActivityItem[] {
	const seen = new Set(current.map((item) => item.id));
	const result = [...current];
	for (const item of incoming) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		result.push(item);
	}
	return result;
}

export function flattenConversationActivityPages(
	pages: readonly ConversationActivityPage[],
): ConversationActivityItem[] {
	return pages.reduce<ConversationActivityItem[]>(
		(items, page) => appendConversationActivityItems(items, page.items),
		[],
	);
}

export function conversationActivityPagesAreDescending(
	pages: readonly ConversationActivityPage[],
): boolean {
	let previous: ConversationActivityItem | undefined;
	for (const page of pages) {
		for (const item of page.items) {
			if (previous) {
				const previousTime = Date.parse(previous.occurredAt);
				const currentTime = Date.parse(item.occurredAt);
				if (
					previousTime < currentTime ||
					(previousTime === currentTime && previous.id <= item.id)
				) return false;
			}
			previous = item;
		}
	}
	return true;
}
