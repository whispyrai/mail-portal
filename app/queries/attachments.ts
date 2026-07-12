import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
	AttachmentKind,
	MailboxAttachmentItem,
	MailboxAttachmentPage,
} from "../../shared/mailbox-attachments.ts";
import api, { type MailboxAttachmentListRequest } from "../services/api.ts";
import { MailboxAttachmentResponseError } from "../services/mailbox-attachment-response.ts";
import { queryKeys } from "./keys.ts";

export interface MailboxAttachmentFilters {
	q: string;
	kind: AttachmentKind | "";
	folder: string;
}

export type MailboxAttachmentRequest = (
	mailboxId: string,
	input: MailboxAttachmentListRequest,
	opts?: { signal?: AbortSignal },
) => Promise<MailboxAttachmentPage>;

interface MailboxAttachmentPageBoundary {
	date: string;
	emailId: string;
	attachmentId: string;
}

interface MailboxAttachmentPageParam {
	cursor: string | null;
	boundary: MailboxAttachmentPageBoundary | null;
	seenKeys: string[];
}

function attachmentIdentity(item: MailboxAttachmentItem): string {
	return JSON.stringify([item.emailId, item.id]);
}

function pageFollowsBoundary(
	page: MailboxAttachmentPage,
	boundary: MailboxAttachmentPageBoundary | null,
): boolean {
	const first = page.items[0];
	if (!first || !boundary) return true;
	if (first.message.date !== boundary.date) {
		return first.message.date < boundary.date;
	}
	if (first.emailId !== boundary.emailId) return first.emailId > boundary.emailId;
	return first.id > boundary.attachmentId;
}

function lastPageBoundary(
	pages: readonly MailboxAttachmentPage[],
): MailboxAttachmentPageBoundary | null {
	for (let index = pages.length - 1; index >= 0; index -= 1) {
		const item = pages[index]?.items.at(-1);
		if (item) {
			return {
				date: item.message.date,
				emailId: item.emailId,
				attachmentId: item.id,
			};
		}
	}
	return null;
}

export function flattenMailboxAttachmentPages(
	pages: readonly MailboxAttachmentPage[],
): MailboxAttachmentItem[] {
	return pages.flatMap((page) => page.items);
}

export function nextMailboxAttachmentCursor(
	pages: readonly MailboxAttachmentPage[],
	pageParams: readonly (string | null)[],
): string | undefined {
	const cursor = pages.at(-1)?.nextCursor ?? null;
	return cursor && !pageParams.includes(cursor) ? cursor : undefined;
}

export function buildMailboxAttachmentsQueryOptions(
	mailboxId: string,
	filters: MailboxAttachmentFilters,
	request: MailboxAttachmentRequest = api.listMailboxAttachments,
) {
	const initialPageParam: MailboxAttachmentPageParam = {
		cursor: null,
		boundary: null,
		seenKeys: [],
	};
	return {
		queryKey: queryKeys.attachments.list(mailboxId, filters),
		queryFn: ({ pageParam, signal }: { pageParam: MailboxAttachmentPageParam; signal: AbortSignal }) =>
			request(
				mailboxId,
				{
					limit: 25,
					q: filters.q,
					kind: filters.kind,
					folder: filters.folder,
					cursor: pageParam.cursor,
				},
				{ signal },
			).then((page) => {
				const seen = new Set(pageParam.seenKeys);
				if (
					!pageFollowsBoundary(page, pageParam.boundary) ||
					page.items.some((item) => seen.has(attachmentIdentity(item)))
				) throw new MailboxAttachmentResponseError();
				return page;
			}),
		initialPageParam,
		getNextPageParam: (
			_lastPage: MailboxAttachmentPage,
			allPages: MailboxAttachmentPage[],
			_lastPageParam: MailboxAttachmentPageParam,
			allPageParams: MailboxAttachmentPageParam[],
		) => {
			const cursor = nextMailboxAttachmentCursor(
				allPages,
				allPageParams.map((pageParam) => pageParam.cursor),
			);
			return cursor
				? {
					cursor,
					boundary: lastPageBoundary(allPages),
					seenKeys: allPages.flatMap((page) => page.items.map(attachmentIdentity)),
				}
				: undefined;
		},
		enabled: Boolean(mailboxId),
	};
}

export function useMailboxAttachments(
	mailboxId: string,
	filters: MailboxAttachmentFilters,
	enabled = true,
) {
	const query = useInfiniteQuery({
		...buildMailboxAttachmentsQueryOptions(mailboxId, filters),
		enabled: enabled && Boolean(mailboxId),
	});
	return {
		...query,
		items: flattenMailboxAttachmentPages(query.data?.pages ?? []),
	};
}

export function useMailboxAttachmentDetail(
	mailboxId: string,
	attachmentId: string | null,
	fallback: MailboxAttachmentItem | null,
) {
	return useQuery({
		queryKey: attachmentId
			? queryKeys.attachments.detail(mailboxId, attachmentId)
			: ["attachments", "detail", "_disabled"],
		queryFn: ({ signal }) => api.getMailboxAttachment(mailboxId, attachmentId!, { signal }),
		enabled: Boolean(mailboxId && attachmentId && !fallback),
		initialData: fallback ?? undefined,
	});
}

export function useMailboxAttachmentBytes(
	mailboxId: string,
	attachment: MailboxAttachmentItem | null,
	enabled: boolean,
) {
	return useQuery({
		queryKey: attachment
			? queryKeys.attachments.bytes(mailboxId, attachment.emailId, attachment.id)
			: ["attachments", "bytes", "_disabled"],
		queryFn: ({ signal }) => api.getAttachment(
			mailboxId,
			attachment!.emailId,
			attachment!.id,
			{ signal },
		),
		enabled: enabled && Boolean(mailboxId && attachment),
		gcTime: 0,
		retry: false,
	});
}
