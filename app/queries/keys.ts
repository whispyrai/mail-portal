// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { pushHealthKey } from "../lib/push-health-cache.ts";

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
	},
	attachments: {
		list: (
			mailboxId: string,
			filters: { q: string; kind: string; folder: string },
		) => ["attachments", mailboxId, "list", filters] as const,
		detail: (mailboxId: string, attachmentId: string) =>
			["attachments", mailboxId, "detail", attachmentId] as const,
		bytes: (mailboxId: string, emailId: string, attachmentId: string) =>
			["attachments", mailboxId, "bytes", emailId, attachmentId] as const,
	},
	people: {
		list: (
			mailboxId: string,
			filters: { q: string; sort: string },
		) => ["people", mailboxId, "list", filters] as const,
		detail: (mailboxId: string, personId: string) =>
			["people", mailboxId, "detail", personId] as const,
		timeline: (mailboxId: string, personId: string) =>
			["people", mailboxId, "timeline", personId] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	labels: {
		list: (mailboxId: string) => ["labels", mailboxId] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number, labelId = "") =>
			["search", mailboxId, query, page, labelId] as const,
	},
	push: {
		health: pushHealthKey,
	},
	outbound: {
		list: (mailboxId: string, emailIdsKey = "") =>
			["outbound", mailboxId, emailIdsKey] as const,
	},
	config: ["config"] as const,
	currentActor: ["me"] as const,
};
