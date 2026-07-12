import { useInfiniteQuery } from "@tanstack/react-query";
import {
	conversationActivityPagesAreDescending,
	flattenConversationActivityPages,
} from "../lib/conversation-activity-controller.ts";
import {
	ConversationActivityApiError,
	fetchConversationActivity,
	type ConversationActivityPage,
} from "../services/conversation-activity.ts";

type ConversationActivityRequest = (
	mailboxId: string,
	emailId: string,
	cursor: string | null,
	signal: AbortSignal,
) => Promise<ConversationActivityPage>;

type ConversationActivityPageBoundary = {
	id: string;
	occurredAt: string;
};

type ConversationActivityPageParam = {
	cursor: string | null;
	boundary: ConversationActivityPageBoundary | null;
};

function lastAcceptedBoundary(
	pages: readonly ConversationActivityPage[],
): ConversationActivityPageBoundary | null {
	for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
		const item = pages[pageIndex]?.items.at(-1);
		if (item) return { id: item.id, occurredAt: item.occurredAt };
	}
	return null;
}

function pageFollowsBoundary(
	page: ConversationActivityPage,
	boundary: ConversationActivityPageBoundary | null,
): boolean {
	const first = page.items[0];
	if (!boundary || !first) return true;
	const boundaryTime = Date.parse(boundary.occurredAt);
	const firstTime = Date.parse(first.occurredAt);
	return boundaryTime > firstTime ||
		(boundaryTime === firstTime && boundary.id > first.id);
}

export function conversationActivityKey(mailboxId: string, emailId: string) {
	return ["conversation-activity", mailboxId, emailId] as const;
}

export function nextConversationActivityCursor(
	pages: readonly ConversationActivityPage[],
	pageParams: readonly (string | null)[],
): string | undefined {
	const nextCursor = pages.at(-1)?.nextCursor ?? null;
	if (!nextCursor || pageParams.includes(nextCursor)) return undefined;
	return nextCursor;
}

export function buildConversationActivityQueryOptions(
	mailboxId: string,
	emailId: string,
	enabled: boolean,
	request: ConversationActivityRequest = fetchConversationActivity,
) {
	const initialPageParam: ConversationActivityPageParam = {
		cursor: null,
		boundary: null,
	};
	return {
		queryKey: conversationActivityKey(mailboxId, emailId),
		queryFn: ({
			pageParam,
			signal,
		}: {
			pageParam: ConversationActivityPageParam;
			signal: AbortSignal;
		}) => request(mailboxId, emailId, pageParam.cursor, signal).then((page) => {
			if (!pageFollowsBoundary(page, pageParam.boundary)) {
				throw new ConversationActivityApiError(
					502,
					"Conversation activity returned an invalid response",
				);
			}
			return page;
		}),
		initialPageParam,
		getNextPageParam: (
			_lastPage: ConversationActivityPage,
			allPages: ConversationActivityPage[],
			_lastPageParam: ConversationActivityPageParam,
			allPageParams: ConversationActivityPageParam[],
		) => {
			const cursor = nextConversationActivityCursor(
				allPages,
				allPageParams.map((pageParam) => pageParam.cursor),
			);
			return cursor
				? { cursor, boundary: lastAcceptedBoundary(allPages) }
				: undefined;
		},
		select: (data: {
			pages: ConversationActivityPage[];
			pageParams: ConversationActivityPageParam[];
		}) => {
			if (!conversationActivityPagesAreDescending(data.pages)) {
				throw new ConversationActivityApiError(
					502,
					"Conversation activity returned an invalid response",
				);
			}
			return data;
		},
		enabled: enabled && Boolean(mailboxId && emailId),
		retry: false,
		gcTime: 0,
	};
}

export function useConversationActivity(
	mailboxId: string,
	emailId: string,
	enabled: boolean,
) {
	const query = useInfiniteQuery(
		buildConversationActivityQueryOptions(mailboxId, emailId, enabled),
	);
	return {
		...query,
		items: flattenConversationActivityPages(query.data?.pages ?? []),
	};
}
