// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	wrapUntrustedAiContext,
	type UntrustedAiContextOptions,
} from "../../shared/ai-untrusted-context.ts";

const TRUNCATION_MARKER = "\n[…truncated]";
const MAX_CHAT_MESSAGES = 16;
const MAX_VALUE_TEXT_CHARS = 4_000;
const MAX_CHAT_SERIALIZED_CHARS = 32_000;
const MAX_UNTRUSTED_CONTEXT_CHARS = MAX_VALUE_TEXT_CHARS;

type LocalUntrustedAiContextOptions = {
	/** Short, stable noun used only in the boundary label (for example MAILBOX or THREAD). */
	label: string;
	/** Total serialized message-content limit, including the security boundary. */
	maxChars?: number;
};

export function boundAiText(value: string, maxChars: number): string {
	if (!Number.isSafeInteger(maxChars) || maxChars < TRUNCATION_MARKER.length) {
		throw new Error("AI text limit is invalid");
	}
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Keep recent chat state while bounding every sender/tool-controlled value and
 * the total serialized prompt size. The returned objects are safe copies.
 */
export function boundModelMessages<T extends { role: string; content: unknown }>(
	messages: readonly T[],
	options: { maxValueTextChars?: number } = {},
): T[] {
	const maxValueTextChars = options.maxValueTextChars ?? MAX_VALUE_TEXT_CHARS;
	if (!Number.isSafeInteger(maxValueTextChars) || maxValueTextChars < TRUNCATION_MARKER.length) {
		throw new Error("AI message text limit is invalid");
	}
	let recent = messages.slice(-MAX_CHAT_MESSAGES).map((message) =>
		boundUnknown(message, 0, maxValueTextChars) as T,
	);
	while (
		recent.length > 1 &&
		JSON.stringify(recent).length > MAX_CHAT_SERIALIZED_CHARS
	) {
		recent = recent.slice(1);
	}
	return recent;
}

/** Bound a fixed trusted envelope without ever dropping its leading policy. */
export function boundTrustedModelMessages<
	T extends { role: string; content: unknown },
>(
	messages: readonly T[],
	options: { maxValueTextChars: number; maxSerializedChars: number },
): T[] {
	const bounded = messages.map((message) =>
		boundUnknown(message, 0, options.maxValueTextChars) as T,
	);
	if (JSON.stringify(bounded).length > options.maxSerializedChars) {
		throw new Error("AI trusted message envelope exceeds its safe limit");
	}
	return bounded;
}

export function boundAiToolResult(value: unknown): unknown {
	const bounded = boundUnknown(value, 0, MAX_VALUE_TEXT_CHARS);
	const serialized = JSON.stringify(bounded);
	if (serialized.length <= 12_000) return bounded;
	return {
		truncated: true,
		preview: boundAiText(serialized, 11_800),
	};
}

/**
 * Put model evidence controlled by a sender, mailbox, or tool in a user-role
 * data block. Bounding the data before adding the suffix guarantees truncation
 * can never remove the closing boundary. Angle brackets in the evidence are
 * escaped so it cannot forge our delimiter or introduce prompt-like tags.
 */
export function aiContextAsUntrustedData(
	context: string,
	options: LocalUntrustedAiContextOptions & { truncate?: boolean },
): { role: "user"; content: string } {
	return {
		role: "user",
		content: wrapUntrustedAiContext(context, {
			label: options.label,
			maxChars: options.maxChars ?? MAX_UNTRUSTED_CONTEXT_CHARS,
			truncate: options.truncate,
		} satisfies UntrustedAiContextOptions),
	};
}

export function mailboxContextAsUntrustedData(context: string): {
	role: "user";
	content: string;
} {
	return aiContextAsUntrustedData(context, { label: "MAILBOX" });
}

function boundUnknown(value: unknown, depth: number, maxValueTextChars: number): unknown {
	if (typeof value === "string") return boundAiText(value, maxValueTextChars);
	if (value === null || typeof value !== "object") return value;
	if (depth >= 6) return "[…nested data omitted]";
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((item) =>
			boundUnknown(item, depth + 1, maxValueTextChars),
		);
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.slice(0, 30)
			.map(([key, item]) => [
				key,
				boundUnknown(item, depth + 1, maxValueTextChars),
			]),
	);
}
