// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Brand } from "../../workers/routes/brand.ts";

export function assistantCopyFor(brand: Brand, name: string) {
	if (brand === "wiser") {
		return {
			emptyState:
				"I can read your inbox, summarize conversations, find messages that need your reply, and draft replies in your voice.",
			suggestedPrompts: [
				"Summarize my unread emails",
				"Which conversations are waiting on a reply?",
				"Draft a reply to the latest email",
			],
			composePlaceholder: `e.g. Introduce ${name} to Ahmed, explain the latest project update, and suggest a 20-minute call`,
		};
	}

	return {
		emptyState:
			"I can read your inbox, summarize conversations, find prospects waiting on you, and draft replies in your voice.",
		suggestedPrompts: [
			"Summarize my unread emails",
			"Which prospects are waiting on a reply?",
			"Draft a reply to the latest email",
		],
		composePlaceholder: `e.g. Introduce ${name} to Ahmed at ABC Realty who asked about pricing, offer a 20-min demo`,
	};
}
