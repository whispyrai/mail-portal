// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Folders } from "../../shared/folders.ts";
import { RecipientMemoryOrigins } from "../../shared/recipient-suggestions.ts";
import { resolveBrand } from "../routes/brand.ts";
import { buildPushPayload } from "./push/payload.ts";
import type { StoreEmailProjectionOptions } from "./store-email.ts";
import type {
	DirectInboundAuthority,
	InboundArchiveAuthority,
} from "./inbound-projection-contract.ts";

export function liveInboundProjectionOptions(input: {
	brand?: string;
	mailboxId: string;
	messageId: string;
	date: string;
	allowTerminalRecovery?: boolean;
	archiveAuthority?: InboundArchiveAuthority;
	directAuthority?: DirectInboundAuthority;
	projectionExpiresAt?: number;
}): StoreEmailProjectionOptions {
	const brand = resolveBrand(input.brand);
	return {
		folder: Folders.INBOX,
		date: input.date,
		messageId: input.messageId,
		read: false,
		wakeSnoozedOnReply: true,
		followUpMailboxAddress: input.mailboxId,
		mailboxAddress: input.mailboxId,
		recipientMemoryOrigin: RecipientMemoryOrigins.LIVE_INBOUND,
		automationTrigger: "live_inbound",
		allowTerminalRecovery: input.allowTerminalRecovery,
		inboundArchiveAuthority: input.archiveAuthority,
		directInboundAuthority: input.directAuthority,
		inboundProjectionExpiresAt: input.projectionExpiresAt,
		pushNotificationFor: (parsed) =>
			buildPushPayload({
				emailId: input.messageId,
				mailboxId: input.mailboxId,
				fromName: parsed.from?.name || null,
				fromAddress: parsed.from?.address || "",
				subject: parsed.subject || "",
				body: parsed.text || parsed.html || "",
				icon: brand.pwaIcon192,
				badge: brand.notificationBadge,
			}),
	};
}
