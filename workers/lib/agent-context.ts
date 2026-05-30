// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared context + model helpers for the manually-invoked AI assistant.
// Used by both the chat agent (workers/agent) and the one-shot "AI Reply"
// endpoint so they answer from the rep's real mailbox with Whispyr context.

import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	stripHtmlToText,
	textToHtml,
} from "./email-helpers";
import { WHISPYR_SYSTEM_PROMPT } from "./whispyr-prompt";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

/** Default Workers AI model. Override per-deployment by setting an `AI_MODEL`
 *  var/secret (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for stronger
 *  tool-calling). Kept at 8B by default per locked-decisions D-42. */
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export function getAiModel(env: Env): string {
	const override = (env as { AI_MODEL?: string }).AI_MODEL;
	return override && override.trim() ? override.trim() : DEFAULT_MODEL;
}

/**
 * Resolve the system prompt for a mailbox: the per-mailbox `agentSystemPrompt`
 * from R2 settings if set, otherwise the canonical Whispyr prompt.
 */
export async function getMailboxSystemPrompt(
	env: Env,
	mailboxId: string,
): Promise<string> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			const custom = settings.agentSystemPrompt;
			if (typeof custom === "string" && custom.trim()) return custom;
		}
	} catch {
		// Fall through to the default.
	}
	return WHISPYR_SYSTEM_PROMPT;
}

/**
 * Build a compact, plain-text snapshot of the most recent inbox messages so the
 * assistant can answer "what's unread?", "who's waiting on me?", etc. without
 * depending on the model's (weaker on small models) tool-calling.
 */
export async function buildMailboxContext(
	env: Env,
	mailboxId: string,
	limit = 15,
): Promise<string> {
	try {
		const stub = getMailboxStub(env, mailboxId);
		const rows = (await stub.getEmails({
			folder: Folders.INBOX,
			limit,
			page: 1,
			sortColumn: "date",
			sortDirection: "DESC",
		})) as unknown as Array<{
			subject?: string | null;
			sender?: string | null;
			date?: string | null;
			read?: boolean | number | null;
			snippet?: string | null;
		}>;

		if (!rows || rows.length === 0) {
			return "## Current inbox\n(The inbox is currently empty.)";
		}

		const lines = rows.map((r, i) => {
			const isUnread = !r.read || r.read === 0;
			const when = r.date ? new Date(r.date).toISOString().slice(0, 10) : "";
			const snippet = r.snippet
				? stripHtmlToText(r.snippet).slice(0, 120)
				: "";
			return `${i + 1}. From ${r.sender || "unknown"}${isUnread ? " [unread]" : ""} — "${r.subject || "(no subject)"}"${when ? ` (${when})` : ""}${snippet ? ` — ${snippet}` : ""}`;
		});

		return `## Current inbox (most recent ${rows.length}, newest first)\n${lines.join("\n")}`;
	} catch {
		// Context is best-effort; the tools remain available to the model.
		return "";
	}
}

/**
 * One-shot reply draft for a single email/thread. Used by the "AI Reply" button.
 * Generates directly (no agent tool-calling) so it's reliable on small models,
 * then returns plain fields the composer can pre-fill. The rep reviews + sends.
 */
export async function draftReplyForEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<{ to: string; subject: string; body: string }> {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) throw new Error("Email not found");

	// Assemble thread context (chronological) so the reply is in-context.
	let threadText: string;
	if (email.thread_id) {
		const thread = await getFullThread(stub, email.thread_id);
		threadText = thread.messages
			.map((m) => {
				const when = m.date
					? new Date(m.date).toISOString().slice(0, 16).replace("T", " ")
					: "";
				return `From: ${m.sender || "unknown"}${when ? ` (${when})` : ""}\nSubject: ${m.subject || "(no subject)"}\n\n${m.body_text || ""}`;
			})
			.join("\n\n---\n\n");
	} else {
		threadText = `From: ${email.sender || "unknown"}\nSubject: ${email.subject || "(no subject)"}\n\n${email.body_text || ""}`;
	}

	const systemPrompt = await getMailboxSystemPrompt(env, mailboxId);
	const model = getAiModel(env);

	const repRaw = mailboxId.split("@")[0].split(".")[0];
	const repFirstName = repRaw.charAt(0).toUpperCase() + repRaw.slice(1);

	const messages = [
		{
			role: "system",
			content: `${systemPrompt}\n\nYou are drafting a reply on behalf of the rep (${mailboxId}). Output ONLY the plain-text body of the reply — no subject line, no "To:" line, no commentary, and do NOT include the quoted original message.\n\nStructure the reply as a proper email:\n- Open with a natural greeting using the sender's first name (e.g. "Hi Ahmed,")\n- Write the reply in clear, well-spaced paragraphs\n- Close with a professional sign-off (e.g. "Best regards,") on its own line, followed by the rep's first name: ${repFirstName}\nNo markdown, no bullet lists, no headers — natural paragraphs only.`,
		},
		{
			role: "user",
			content: `Draft the rep's reply to the most recent message in this thread.\n\n${threadText}`,
		},
	];

	// The AI binding's run() is typed against a model-id literal union; we pass a
	// runtime-configurable id, so go through a narrowed signature.
	const ai = env.AI as unknown as {
		run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
	};
	const res = (await ai.run(model, {
		messages,
		max_tokens: 1024,
		temperature: 0.5,
	})) as { response?: string };

	const text = (res?.response || "").trim();
	if (!text) throw new Error("The model returned an empty draft. Please try again.");

	const base = (email.subject || "").replace(/^(re:\s*)+/i, "").trim();
	const subject = base ? `Re: ${base}` : "Re:";

	return {
		to: email.sender || "",
		subject,
		body: textToHtml(text),
	};
}

/**
 * One-shot compose draft for a brand-new outbound email. The rep provides a
 * plain-language prompt describing what they want to write; the model returns
 * a subject line and a full email body (greeting → paragraphs → sign-off).
 */
export async function draftNewEmail(
	env: Env,
	mailboxId: string,
	prompt: string,
): Promise<{ subject: string; body: string }> {
	const systemPrompt = await getMailboxSystemPrompt(env, mailboxId);
	const model = getAiModel(env);

	const repRaw = mailboxId.split("@")[0].split(".")[0];
	const repFirstName = repRaw.charAt(0).toUpperCase() + repRaw.slice(1);

	const messages = [
		{
			role: "system",
			content: `${systemPrompt}\n\nYou are composing a brand-new outbound email on behalf of the rep whose mailbox is ${mailboxId}.\n\nOutput your response in exactly this format — nothing else:\nSUBJECT: <concise subject line>\n\n<full email body>\n\nThe body MUST:\n- Open with a natural greeting (e.g. "Hi [Name]," or "Dear [Name],")\n- Contain clear, well-spaced paragraphs conveying the message\n- Close with a professional sign-off (e.g. "Best regards,") on its own line followed by the rep's first name: ${repFirstName}\nNo markdown, no bullet lists, no headers — natural paragraphs only.`,
		},
		{
			role: "user",
			content: prompt,
		},
	];

	const ai = env.AI as unknown as {
		run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
	};
	const res = (await ai.run(model, {
		messages,
		max_tokens: 1024,
		temperature: 0.6,
	})) as { response?: string };

	const text = (res?.response || "").trim();
	if (!text) throw new Error("The model returned an empty draft. Please try again.");

	// Parse "SUBJECT: ..." from the first matching line; everything after is the body.
	const lines = text.split("\n");
	const subjectIdx = lines.findIndex((l) =>
		l.trimStart().toUpperCase().startsWith("SUBJECT:"),
	);
	let subject = "New email";
	let bodyStart = 0;
	if (subjectIdx !== -1) {
		subject = lines[subjectIdx].replace(/^SUBJECT:\s*/i, "").trim() || "New email";
		bodyStart = subjectIdx + 1;
		while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++;
	}
	const bodyText = lines.slice(bodyStart).join("\n").trim();

	return { subject, body: textToHtml(bodyText) };
}
