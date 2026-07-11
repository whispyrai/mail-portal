// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const THREAD_TOKEN_RE = /^thread-(.+)@/;

/** Build the app-controlled token that survives SES Message-ID rewriting. */
export function buildThreadToken(threadId: string, domain: string): string {
	return `thread-${threadId}@${domain}`;
}

/** Recover an app-controlled thread id from inbound reply headers. */
export function extractThreadToken(
	references: string[],
	inReplyTo: string | null,
): string | null {
	const candidates = inReplyTo ? [...references, inReplyTo] : references;
	for (const candidate of candidates) {
		const threadId = candidate.match(THREAD_TOKEN_RE)?.[1];
		if (threadId) return threadId;
	}
	return null;
}

