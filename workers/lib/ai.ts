// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Deterministic draft artifact scrub used by every outbound tool path. */

import { stripHtmlToText } from "./email-helpers.ts";

// Match only complete, known assistant-status lines. Ordinary mentions of tool
// names, links, and technical language are intentionally preserved.
const ARTIFACT_LINES = [
	/^draft (?:saved|created)\.?$/i,
	/^drafted via (?:draft_reply|draft_email)(?:\s+to email\s+\S+)?\.?$/i,
	/^the operator can review and send (?:it )?from the ui\.?$/i,
	/^(?:i've|i have) drafted (?:a|the) (?:reply|email) for you to review\.?$/i,
	/^called (?:get_email|get_thread|search_emails|list_emails) to .+\.?$/i,
	/^\[auto-triggered\]$/i,
];

/**
 * Split an HTML body into the reply portion and the quoted block.
 */
function splitQuotedBlock(html: string): { reply: string; quoted: string } {
	const match = html.match(
		/(\s*(?:<br\s*\/?>)\s*)?(<blockquote[\s\S]*<\/blockquote>)\s*$/i,
	);
	if (match) {
		const quoted = match[0];
		const reply = html.slice(0, html.length - quoted.length);
		return { reply, quoted };
	}
	return { reply: html, quoted: "" };
}

/**
 * Remove known assistant artifacts without making another model call.
 */
export async function verifyDraft(body: string): Promise<string> {
	if (!body || !body.trim()) return body;

	// Separate the quoted reply block so the AI only reviews the user's text
	const isHtml = /<[a-z][\s\S]*>/i.test(body);
	const { reply: replyHtml, quoted: quotedBlock } = isHtml
		? splitQuotedBlock(body)
		: { reply: body, quoted: "" };

	if (isHtml) {
		const cleanedHtml = replyHtml.replace(
			/<(p|div|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
			(full, _tag: string, inner: string) =>
				isArtifactLine(stripHtmlToText(inner)) ? "" : full,
		);
		return cleanedHtml === replyHtml ? body : `${cleanedHtml}${quotedBlock}`;
	}

	// Quoted content is never inspected or changed because it is
	// sender-controlled historical material.
	const replyText = replyHtml;
	const keptLines = replyText
		.split(/\r?\n/)
		.filter((line) => !isArtifactLine(line));
	const cleaned = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (cleaned === replyText.trim()) return body;
	if (!cleaned) return body;

	return quotedBlock ? `${cleaned}\n\n${quotedBlock}` : cleaned;
}

function isArtifactLine(line: string): boolean {
	return ARTIFACT_LINES.some((pattern) => pattern.test(line.trim()));
}
