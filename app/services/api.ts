// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	Email,
	Folder,
	Mailbox,
	AttachmentRef,
	OutboundDelivery,
	OutboundEnqueueResponse,
	Label,
	LabelColor,
	LabelMutationResult,
	LabelMutationTarget,
	AttachmentKind,
} from "~/types";
import type {
	BatchTriageCommand,
	BatchTriageResult,
} from "../../shared/batch-triage";
import type {
	SnoozeMutationResponse,
	SnoozeScope,
} from "../../shared/snooze";
import type { AiComposeDraftRequest } from "../../shared/ai-drafting";
import { decodeMailboxAttachmentCursor } from "../../shared/mailbox-attachments.ts";
import {
	MailboxAttachmentResponseError,
	parseMailboxAttachmentItem,
	parseMailboxAttachmentPage,
} from "./mailbox-attachment-response.ts";
import {
	decodeMailboxChangeCursor,
	validateMailboxChangePage,
	type MailboxChangePage,
} from "../../shared/mailbox-change-feed.ts";
import {
	normalizeMailPeopleListQuery,
	normalizeMailPersonTimelineQuery,
	validateMailPeopleListResponse,
	validateMailPersonDetailResponse,
	validateMailPersonTimelineResponse,
	type MailPeopleListResponse,
	type MailPeopleSort,
	type MailPersonDetailResponse,
	type MailPersonTimelineResponse,
} from "../../shared/mail-people.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "DELETE",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

export interface MailboxAttachmentListRequest {
	limit?: number;
	q?: string;
	kind?: AttachmentKind | "";
	folder?: string;
	cursor?: string | null;
}

export type MailPeopleListRequest = {
	limit?: number;
	q?: string;
	sort?: MailPeopleSort;
	cursor?: string | null;
};

export type MailPersonTimelineRequest = {
	limit?: number;
	cursor?: string | null;
};

function encodedPathPart(value: string): string {
	return encodeURIComponent(value);
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; vapidPublicKey: string | null }>(
			"/api/v1/config",
		),

	listLabels: (mailboxId: string) =>
		get<{ labels: Label[] }>(`/api/v1/mailboxes/${mailboxId}/labels`),
	createLabel: (mailboxId: string, input: { name: string; color: LabelColor }) =>
		post<{ label: Label }>(`/api/v1/mailboxes/${mailboxId}/labels`, input),
	updateLabel: (mailboxId: string, labelId: string, input: { name: string; color: LabelColor }) =>
		put<{ label: Label }>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}`, input),
	deleteLabel: (mailboxId: string, labelId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}`),
	mutateLabels: (
		mailboxId: string,
		input: { labelId: string; action: "apply" | "remove"; targets: LabelMutationTarget[] },
	) => post<LabelMutationResult>(`/api/v1/mailboxes/${mailboxId}/label-mutations`, input),

	// Push subscriptions (WISER-240)
	listPushSubscriptions: (mailboxId: string) =>
		get<{
			subscriptions: Array<{
				id: string;
				deviceLabel: string | null;
				userAgent: string | null;
				createdAt: string;
				lastSeenAt: string;
			}>;
		}>(`/api/v1/mailboxes/${mailboxId}/push-subscriptions`),
	registerPushSubscription: (
		mailboxId: string,
		sub: { endpoint: string; keys: { p256dh: string; auth: string } },
	) =>
		post<{ id: string; deviceLabel: string }>(
			`/api/v1/mailboxes/${mailboxId}/push-subscriptions`,
			sub,
		),
	deletePushSubscription: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/push-subscriptions/${id}`),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),
	listMailboxChanges: (
		mailboxId: string,
		cursor: string | null,
		opts?: { signal?: AbortSignal },
	): Promise<MailboxChangePage> => {
		const after = cursor === null ? null : decodeMailboxChangeCursor(cursor);
		return get<unknown>(
			`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/changes`,
			{
				params: cursor === null ? undefined : { after: cursor },
				signal: opts?.signal,
			},
		).then((value) => validateMailboxChangePage(value, after));
	},
	listMailPeople: (
		mailboxId: string,
		input: MailPeopleListRequest,
		opts?: { signal?: AbortSignal },
	): Promise<MailPeopleListResponse> => {
		const params = new URLSearchParams();
		if (input.limit !== undefined) params.set("limit", String(input.limit));
		if (input.q) params.set("q", input.q);
		if (input.sort) params.set("sort", input.sort);
		if (input.cursor) params.set("cursor", input.cursor);
		const normalized = normalizeMailPeopleListQuery(params);
		return get<unknown>(
			`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/people`,
			{ params: Object.fromEntries(params), signal: opts?.signal },
		).then((value) => validateMailPeopleListResponse(value, normalized));
	},
	getMailPerson: (
		mailboxId: string,
		personId: string,
		opts?: { signal?: AbortSignal },
	): Promise<MailPersonDetailResponse> => get<unknown>(
		`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/people/${encodedPathPart(personId)}`,
		{ signal: opts?.signal },
	).then((value) => validateMailPersonDetailResponse(value, personId)),
	listMailPersonTimeline: (
		mailboxId: string,
		personId: string,
		input: MailPersonTimelineRequest,
		opts?: { signal?: AbortSignal },
	): Promise<MailPersonTimelineResponse> => {
		const params = new URLSearchParams();
		if (input.limit !== undefined) params.set("limit", String(input.limit));
		if (input.cursor) params.set("cursor", input.cursor);
		const normalized = normalizeMailPersonTimelineQuery(params, personId);
		return get<unknown>(
			`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/people/${encodedPathPart(personId)}/timeline`,
			{ params: Object.fromEntries(params), signal: opts?.signal },
		).then((value) =>
			validateMailPersonTimelineResponse(value, personId, normalized));
	},

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<OutboundEnqueueResponse>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	listOutboundDeliveries: (
		mailboxId: string,
		emailIds: string[] = [],
		threadIds: string[] = [],
	) =>
		get<{ deliveries: OutboundDelivery[] }>(
			`/api/v1/mailboxes/${mailboxId}/outbound-deliveries`,
			{
				params: emailIds.length || threadIds.length
					? {
						...(emailIds.length ? { emailIds: emailIds.join(",") } : {}),
						...(threadIds.length ? { threadIds: threadIds.join(",") } : {}),
					}
					: undefined,
			},
		),
	cancelOutboundDelivery: (mailboxId: string, deliveryId: string) =>
		post<{ delivery: OutboundDelivery }>(
			`/api/v1/mailboxes/${mailboxId}/outbound-deliveries/${deliveryId}/cancel`,
		),
	retryOutboundDelivery: (
		mailboxId: string,
		deliveryId: string,
		acknowledgeDuplicateRisk = false,
	) =>
		post<{ delivery: OutboundDelivery }>(
			`/api/v1/mailboxes/${mailboxId}/outbound-deliveries/${deliveryId}/retry`,
			{ acknowledgeDuplicateRisk },
		),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<{ status: "trashed" | "already_trashed" }>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	restoreEmail: (mailboxId: string, id: string) =>
		post<{ status: "restored"; folderId: string }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}/restore`,
		),
		discardDraft: (mailboxId: string, id: string, version: number) =>
			del<{ status: "discarded" }>(
				`/api/v1/mailboxes/${mailboxId}/drafts/${id}`,
				{ draft_version: version },
			),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	setConversationRead: (
		mailboxId: string,
		conversationId: string,
		folderId: string,
		read: boolean,
	) =>
		post<{ status: "updated"; affectedCount: number }>(
			`/api/v1/mailboxes/${mailboxId}/conversations/${encodeURIComponent(conversationId)}/read`,
			{ folderId, read },
		),
	archiveConversation: (
		mailboxId: string,
		conversationId: string,
		folderId: string,
	) =>
		post<{ status: "archived"; affectedCount: number }>(
			`/api/v1/mailboxes/${mailboxId}/conversations/${encodeURIComponent(conversationId)}/archive`,
			{ folderId },
		),
	trashConversation: (
		mailboxId: string,
		conversationId: string,
		folderId: string,
	) =>
		post<{ status: "trashed"; affectedCount: number }>(
			`/api/v1/mailboxes/${mailboxId}/conversations/${encodeURIComponent(conversationId)}/trash`,
			{ folderId },
		),
	batchTriage: (mailboxId: string, command: BatchTriageCommand) =>
		post<BatchTriageResult>(
			`/api/v1/mailboxes/${mailboxId}/triage-batch`,
			command,
		),
	snooze: (mailboxId: string, scope: SnoozeScope, wakeAt: string) =>
		post<SnoozeMutationResponse>(
			`/api/v1/mailboxes/${mailboxId}/snooze`,
			{ scope, wakeAt },
		),
	unsnooze: (mailboxId: string, scope: SnoozeScope) =>
		post<SnoozeMutationResponse>(
			`/api/v1/mailboxes/${mailboxId}/snooze/clear`,
			{ scope },
		),
	listMailboxAttachments: (
		mailboxId: string,
		input: MailboxAttachmentListRequest,
		opts?: { signal?: AbortSignal },
	) => {
		const params: Record<string, string> = {};
		if (input.limit !== undefined) params.limit = String(input.limit);
		if (input.q) params.q = input.q;
		if (input.kind) params.kind = input.kind;
		if (input.folder) params.folder = input.folder;
		if (input.cursor) params.cursor = input.cursor;
		return get<unknown>(
			`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/attachments`,
			{ params, signal: opts?.signal },
		).then((value) => {
			const page = parseMailboxAttachmentPage(value, input.limit ?? 25);
			if (page.nextCursor) {
				try {
					decodeMailboxAttachmentCursor(page.nextCursor, {
						q: input.q?.trim().normalize("NFC") || null,
						kind: input.kind || null,
						folder: input.folder?.trim() || null,
					});
				} catch {
					throw new MailboxAttachmentResponseError();
				}
			}
			return page;
		});
	},
	getMailboxAttachment: (
		mailboxId: string,
		attachmentId: string,
		opts?: { signal?: AbortSignal },
	) => get<unknown>(
		`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/attachments/${encodedPathPart(attachmentId)}`,
		{ signal: opts?.signal },
	).then(parseMailboxAttachmentItem),
	attachmentDownloadUrl: (mailboxId: string, emailId: string, attachmentId: string) =>
		`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/emails/${encodedPathPart(emailId)}/attachments/${encodedPathPart(attachmentId)}`,
	getAttachment: (
		mailboxId: string,
		emailId: string,
		attachmentId: string,
		opts?: { signal?: AbortSignal },
	) => get<Blob>(
		`/api/v1/mailboxes/${encodedPathPart(mailboxId)}/emails/${encodedPathPart(emailId)}/attachments/${encodedPathPart(attachmentId)}`,
		{ responseType: "blob", signal: opts?.signal },
	),
	// Upload a file to staging; returns a reference to carry into a send/reply/draft.
	// Raw-body POST (not the JSON helper) with no artificial timeout, since large
	// files on slow links can exceed the default request timeout.
	uploadAttachment: async (
		mailboxId: string,
		file: File,
		signal?: AbortSignal,
	): Promise<{ uploadId: string; filename: string; mimetype: string; size: number }> => {
		const params = new URLSearchParams({
			filename: file.name,
			type: file.type || "application/octet-stream",
		});
		const res = await fetch(
			`/api/v1/mailboxes/${mailboxId}/attachments?${params.toString()}`,
			{
				method: "POST",
				body: file,
				signal,
				headers: { "Content-Type": file.type || "application/octet-stream" },
			},
		);
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}
		return res.json() as Promise<{ uploadId: string; filename: string; mimetype: string; size: number }>;
	},
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
				draft_id?: string;
				draft_version?: number;
				draft_create_key?: string;
				attachments?: AttachmentRef[];
			},
		) => post<Email & { replayed?: boolean }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<OutboundEnqueueResponse>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<OutboundEnqueueResponse>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),
	aiDraftReply: (mailboxId: string, emailId: string) =>
		post<{ to: string; subject: string; body: string }>(
			`/api/v1/mailboxes/${mailboxId}/ai-draft`,
			{ emailId },
		),
	aiDraftCompose: (
		mailboxId: string,
		input: AiComposeDraftRequest,
	) =>
		post<{ subject?: string; body: string }>(
			`/api/v1/mailboxes/${mailboxId}/ai-compose`,
			input,
		),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (
		mailboxId: string,
		params: Record<string, string>,
		opts?: { signal?: AbortSignal },
	) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, {
			params,
			signal: opts?.signal,
		}),
};

export default api;
