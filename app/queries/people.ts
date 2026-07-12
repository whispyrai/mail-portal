import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	MAIL_PEOPLE_LIMITS,
	MailPeopleContractError,
	compareCanonicalMailAddresses,
	type MailPeopleBuildingResponse,
	type MailPeopleListResponse,
	type MailPeopleSort,
	type MailPersonDetailResponse,
	type MailPersonSummary,
	type MailPersonTimelineItem,
	type MailPersonTimelineResponse,
} from "../../shared/mail-people.ts";
import api, {
	type MailPeopleListRequest,
	type MailPersonTimelineRequest,
} from "../services/api.ts";
import { queryKeys } from "./keys.ts";

export type MailPeopleFilters = {
	q: string;
	sort: MailPeopleSort;
};

export type MailPeopleRequest = (
	mailboxId: string,
	input: MailPeopleListRequest,
	opts?: { signal?: AbortSignal },
) => Promise<MailPeopleListResponse>;

export type MailPersonTimelineRequestFn = (
	mailboxId: string,
	personId: string,
	input: MailPersonTimelineRequest,
	opts?: { signal?: AbortSignal },
) => Promise<MailPersonTimelineResponse>;

type MailPeoplePageParam = {
	cursor: string | null;
	boundary: MailPersonSummary | null;
	seenIds: string[];
};

type MailPersonTimelinePageParam = {
	cursor: string | null;
	boundary: MailPersonTimelineItem | null;
	seenIds: string[];
};

function invalidResponse(): never {
	throw new MailPeopleContractError("People response pages are inconsistent");
}

export function compareMailPeople(
	left: MailPersonSummary,
	right: MailPersonSummary,
	sort: MailPeopleSort,
): number {
	if (sort === "frequent") {
		const leftCount = left.sentCount + left.receivedCount;
		const rightCount = right.sentCount + right.receivedCount;
		if (leftCount !== rightCount) return leftCount > rightCount ? -1 : 1;
	}
	if (sort !== "address" && left.lastInteractionAt !== right.lastInteractionAt) {
		return left.lastInteractionAt > right.lastInteractionAt ? -1 : 1;
	}
	return compareCanonicalMailAddresses(left.address, right.address);
}

function validatePeoplePage(
	response: MailPeopleListResponse,
	pageParam: MailPeoplePageParam,
	sort: MailPeopleSort,
): MailPeopleListResponse {
	if (response.status === "building") return response;
	const seen = new Set(pageParam.seenIds);
	for (let index = 0; index < response.people.length; index += 1) {
		const person = response.people[index]!;
		if (seen.has(person.id)) invalidResponse();
		seen.add(person.id);
		const previous = index === 0 ? pageParam.boundary : response.people[index - 1]!;
		if (previous && compareMailPeople(previous, person, sort) >= 0) invalidResponse();
	}
	return response;
}

function lastPerson(
	pages: readonly MailPeopleListResponse[],
): MailPersonSummary | null {
	for (let index = pages.length - 1; index >= 0; index -= 1) {
		const page = pages[index];
		if (page?.status !== "ready") continue;
		const person = page.people.at(-1);
		if (person) return person;
	}
	return null;
}

function peopleRetryInterval(
	data: { pages: MailPeopleListResponse[] } | undefined,
): number | false {
	const building = data?.pages.find(
		(page): page is MailPeopleBuildingResponse => page.status === "building",
	);
	return building
		? building.retryAfterMs
		: false;
}

export function flattenMailPeoplePages(
	pages: readonly MailPeopleListResponse[],
): MailPersonSummary[] {
	if (pages.some((page) => page.status === "building")) return [];
	return pages.flatMap((page) => page.status === "ready" ? page.people : []);
}

export function buildMailPeopleQueryOptions(
	mailboxId: string,
	filters: MailPeopleFilters,
	request: MailPeopleRequest = api.listMailPeople,
) {
	const initialPageParam: MailPeoplePageParam = {
		cursor: null,
		boundary: null,
		seenIds: [],
	};
	return {
		queryKey: queryKeys.people.list(mailboxId, filters),
		queryFn: ({ pageParam, signal }: {
			pageParam: MailPeoplePageParam;
			signal: AbortSignal;
		}) => request(mailboxId, {
			limit: MAIL_PEOPLE_PAGE_SIZE,
			q: filters.q,
			sort: filters.sort,
			cursor: pageParam.cursor,
		}, { signal }).then((response) =>
			validatePeoplePage(response, pageParam, filters.sort)),
		initialPageParam,
		getNextPageParam: (
			lastPage: MailPeopleListResponse,
			allPages: MailPeopleListResponse[],
			_lastPageParam: MailPeoplePageParam,
			allPageParams: MailPeoplePageParam[],
		) => {
			if (lastPage.status !== "ready" || !lastPage.nextCursor) return undefined;
			if (allPageParams.some((page) => page.cursor === lastPage.nextCursor)) {
				invalidResponse();
			}
			return {
				cursor: lastPage.nextCursor,
				boundary: lastPerson(allPages),
				seenIds: allPages.flatMap((page) =>
					page.status === "ready" ? page.people.map((person) => person.id) : []),
			};
		},
		enabled: Boolean(mailboxId),
		refetchInterval: (query: { state: { data?: { pages: MailPeopleListResponse[] } } }) =>
			peopleRetryInterval(query.state.data),
	};
}

export function useMailPeople(
	mailboxId: string,
	filters: MailPeopleFilters,
	enabled = true,
) {
	const query = useInfiniteQuery({
		...buildMailPeopleQueryOptions(mailboxId, filters),
		enabled: enabled && Boolean(mailboxId),
	});
	const pages = query.data?.pages ?? [];
	return {
		...query,
		items: flattenMailPeoplePages(pages),
		building: pages.find(
			(page): page is MailPeopleBuildingResponse => page.status === "building",
		) ?? null,
	};
}

function detailRetryInterval(
	data: MailPersonDetailResponse | MailPersonTimelineResponse | undefined,
): number | false {
	return data?.status === "building"
		? data.retryAfterMs
		: false;
}

export function useMailPerson(
	mailboxId: string,
	personId: string | null,
) {
	return useQuery({
		queryKey: personId
			? queryKeys.people.detail(mailboxId, personId)
			: ["people", mailboxId, "detail", "_disabled"],
		queryFn: ({ signal }) => api.getMailPerson(mailboxId, personId!, { signal }),
		enabled: Boolean(mailboxId && personId),
		refetchInterval: (query) => detailRetryInterval(query.state.data),
	});
}

function compareTimelineItems(
	left: MailPersonTimelineItem,
	right: MailPersonTimelineItem,
): number {
	if (left.date !== right.date) return left.date > right.date ? -1 : 1;
	if (left.messageId !== right.messageId) return left.messageId < right.messageId ? -1 : 1;
	if (left.role !== right.role) return left.role < right.role ? -1 : 1;
	return 0;
}

function timelineIdentity(item: MailPersonTimelineItem): string {
	return JSON.stringify([item.messageId, item.role]);
}

function validateTimelinePage(
	response: MailPersonTimelineResponse,
	pageParam: MailPersonTimelinePageParam,
): MailPersonTimelineResponse {
	if (response.status === "building") return response;
	const seen = new Set(pageParam.seenIds);
	for (let index = 0; index < response.items.length; index += 1) {
		const item = response.items[index]!;
		const identity = timelineIdentity(item);
		if (seen.has(identity)) invalidResponse();
		seen.add(identity);
		const previous = index === 0 ? pageParam.boundary : response.items[index - 1]!;
		if (previous && compareTimelineItems(previous, item) >= 0) invalidResponse();
	}
	return response;
}

function lastTimelineItem(
	pages: readonly MailPersonTimelineResponse[],
): MailPersonTimelineItem | null {
	for (let index = pages.length - 1; index >= 0; index -= 1) {
		const page = pages[index];
		if (page?.status !== "ready") continue;
		const item = page.items.at(-1);
		if (item) return item;
	}
	return null;
}

export function flattenMailPersonTimelinePages(
	pages: readonly MailPersonTimelineResponse[],
): MailPersonTimelineItem[] {
	if (pages.some((page) => page.status === "building")) return [];
	return pages.flatMap((page) => page.status === "ready" ? page.items : []);
}

export function buildMailPersonTimelineQueryOptions(
	mailboxId: string,
	personId: string,
	request: MailPersonTimelineRequestFn = api.listMailPersonTimeline,
) {
	const initialPageParam: MailPersonTimelinePageParam = {
		cursor: null,
		boundary: null,
		seenIds: [],
	};
	return {
		queryKey: queryKeys.people.timeline(mailboxId, personId),
		queryFn: ({ pageParam, signal }: {
			pageParam: MailPersonTimelinePageParam;
			signal: AbortSignal;
		}) => request(mailboxId, personId, {
			limit: MAIL_PEOPLE_PAGE_SIZE,
			cursor: pageParam.cursor,
		}, { signal }).then((response) => validateTimelinePage(response, pageParam)),
		initialPageParam,
		getNextPageParam: (
			lastPage: MailPersonTimelineResponse,
			allPages: MailPersonTimelineResponse[],
			_lastPageParam: MailPersonTimelinePageParam,
			allPageParams: MailPersonTimelinePageParam[],
		) => {
			if (lastPage.status !== "ready" || !lastPage.nextCursor) return undefined;
			if (allPageParams.some((page) => page.cursor === lastPage.nextCursor)) {
				invalidResponse();
			}
			return {
				cursor: lastPage.nextCursor,
				boundary: lastTimelineItem(allPages),
				seenIds: allPages.flatMap((page) =>
					page.status === "ready" ? page.items.map(timelineIdentity) : []),
			};
		},
		enabled: Boolean(mailboxId && personId),
		refetchInterval: (query: { state: { data?: { pages: MailPersonTimelineResponse[] } } }) => {
			const building = query.state.data?.pages.find(
				(page): page is MailPeopleBuildingResponse => page.status === "building",
			);
			return building
				? building.retryAfterMs
				: false;
		},
	};
}

export function useMailPersonTimeline(
	mailboxId: string,
	personId: string | null,
	enabled = true,
) {
	const query = useInfiniteQuery({
		...buildMailPersonTimelineQueryOptions(mailboxId, personId ?? ""),
		enabled: enabled && Boolean(mailboxId && personId),
	});
	const pages = query.data?.pages ?? [];
	return {
		...query,
		items: flattenMailPersonTimelinePages(pages),
		building: pages.find(
			(page): page is MailPeopleBuildingResponse => page.status === "building",
		) ?? null,
	};
}

export const MAIL_PEOPLE_PAGE_SIZE = Math.min(
	25,
	MAIL_PEOPLE_LIMITS.resultLimit,
);
