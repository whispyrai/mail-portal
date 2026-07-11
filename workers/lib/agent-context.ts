// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared context + model helpers for the manually-invoked AI assistant.
// Used by both the chat agent (workers/agent) and the one-shot "AI Reply"
// endpoint so they answer from the mailbox's real data and active brand context.

import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	stripHtmlToText,
	textToHtml,
} from "./email-helpers";
import { systemPromptFor } from "./prompts";
import { resolveBrand } from "../routes/brand";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import {
	buildAiCacheKey,
	calculateAiUsageCostMicros,
	resolveAiCostControlConfig,
} from "./ai-cost-control.ts";
import {
	createAiCostController,
	getCachedAiResponse,
	putCachedAiResponse,
} from "./ai-cost-control-d1.ts";
import { boundAiText, boundModelMessages } from "./ai-input-bounds.ts";

const ESTIMATED_DRAFT_COST_MICROS = 10_000;

async function runGuardedDraftInference(
	env: Env,
	input: {
		feature: "reply_draft" | "compose_draft";
		mailboxId: string;
		actorUserId?: string;
		sourceVersion: string;
		messages: Array<{ role: string; content: string }>;
		maxTokens: number;
		temperature: number;
	},
): Promise<string> {
	const config = resolveAiCostControlConfig(env);
	const boundedMessages = boundModelMessages(input.messages);
	const cacheKey = await buildAiCacheKey({
		feature: input.feature,
		tier: "cheap",
		model: config.cheapModel,
		promptVersion: `${input.feature}-v1`,
		sourceVersion: input.sourceVersion,
		mailboxId: input.mailboxId,
		input: boundedMessages,
	});
	const cached = await getCachedAiResponse<string>(env, {
		cacheKey,
		mailboxId: input.mailboxId,
	});
	const controller = createAiCostController(env, config);
	const decision = await controller.beginUsage({
		feature: input.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: "cheap",
		estimatedCostMicros: ESTIMATED_DRAFT_COST_MICROS,
		cacheKey,
		cacheHit: cached !== null,
	});
	if (cached !== null) return cached;
	if (decision.decision === "block" || !decision.reservationId) {
		throw new Error(
			decision.reviewRequired
				? "AI drafting is paused pending an administrator budget review."
				: "AI drafting is temporarily unavailable. Your mail remains fully available.",
		);
	}

	let promptTokens = 0;
	let completionTokens = 0;
	try {
		const providerStarted = await controller.startUsage(decision.reservationId);
		if (!providerStarted) throw new Error("AI usage reservation could not be started");
		const ai = env.AI as unknown as {
			run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
		};
		const response = (await ai.run(decision.model, {
			messages: boundedMessages,
			max_tokens: input.maxTokens,
			temperature: input.temperature,
		})) as {
			response?: string;
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const text = (response.response ?? "").trim();
		if (!text) throw new Error("The model returned an empty draft. Please try again.");
		promptTokens = Math.max(0, Math.floor(response.usage?.prompt_tokens ?? 0));
		completionTokens = Math.max(
			0,
			Math.floor(response.usage?.completion_tokens ?? 0),
		);
		const measuredCost = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		const completed = await controller.completeUsage(decision.reservationId, {
			actualCostMicros: measuredCost || ESTIMATED_DRAFT_COST_MICROS,
			promptTokens,
			completionTokens,
		});
		if (completed.emitAlert) {
			console.warn("[ai-cost] monthly AI usage reached the alert threshold");
		}
		await putCachedAiResponse(env, {
			cacheKey,
			mailboxId: input.mailboxId,
			feature: input.feature,
			value: text,
		}).catch((error) =>
			console.warn(
				"[ai-cache] failed to persist a completed response",
				error instanceof Error ? error.message : String(error),
			),
		);
		return text;
	} catch (error) {
		const measuredCost = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await controller
			.failUsage(decision.reservationId, {
				errorCode: error instanceof Error ? error.name : "ai_inference_failed",
				actualCostMicros: measuredCost || undefined,
				promptTokens,
				completionTokens,
			})
			.catch(() => false);
		throw error;
	}
}

/**
 * Resolve the system prompt for a mailbox: the per-mailbox `agentSystemPrompt`
 * from R2 settings if set, otherwise the active brand's canonical prompt.
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
			if (typeof custom === "string" && custom.trim()) {
				return boundAiText(custom.trim(), 8_000);
			}
		}
	} catch {
		// Fall through to the default.
	}
	return boundAiText(systemPromptFor(resolveBrand(env.BRAND).id), 8_000);
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
		const boundedLimit = Math.min(15, Math.max(1, Math.floor(limit)));
		const stub = getMailboxStub(env, mailboxId);
		const rows = (await stub.getEmails({
			folder: Folders.INBOX,
			limit: boundedLimit,
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

		return boundAiText(
			`## Current inbox (most recent ${rows.length}, newest first)\n${lines.join("\n")}`,
			12_000,
		);
	} catch {
		// Context is best-effort; the tools remain available to the model.
		return "";
	}
}

/**
 * One-shot reply draft for a single email/thread. Used by the "AI Reply" button.
 * Generates directly (no agent tool-calling) so it's reliable on small models,
 * then returns plain fields the composer can pre-fill. The mailbox owner reviews and sends.
 */
export async function draftReplyForEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	actorUserId?: string,
): Promise<{ to: string; subject: string; body: string }> {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) throw new Error("Email not found");

	// Assemble thread context (chronological) so the reply is in-context.
	let threadText: string;
	if (email.thread_id) {
		const thread = await getFullThread(stub, email.thread_id);
		threadText = thread.messages
			.slice(-12)
			.map((m) => {
				const when = m.date
					? new Date(m.date).toISOString().slice(0, 16).replace("T", " ")
					: "";
				return `From: ${boundAiText(m.sender || "unknown", 500)}${when ? ` (${when})` : ""}\nSubject: ${boundAiText(m.subject || "(no subject)", 1_000)}\n\n${boundAiText(m.body_text || "", 4_000)}`;
			})
			.join("\n\n---\n\n");
	} else {
		threadText = `From: ${boundAiText(email.sender || "unknown", 500)}\nSubject: ${boundAiText(email.subject || "(no subject)", 1_000)}\n\n${boundAiText(email.body_text || "", 8_000)}`;
	}
	threadText = boundAiText(threadText, 28_000);

	const systemPrompt = await getMailboxSystemPrompt(env, mailboxId);

	const ownerRaw = mailboxId.split("@")[0].split(".")[0];
	const ownerFirstName = ownerRaw.charAt(0).toUpperCase() + ownerRaw.slice(1);

	const messages = [
		{
			role: "system",
			content: `${systemPrompt}\n\nYou are drafting a reply on behalf of the mailbox owner (${mailboxId}). Output ONLY the plain-text body of the reply — no subject line, no "To:" line, no commentary, and do NOT include the quoted original message.\n\nStructure the reply as a proper email:\n- Open with a natural greeting using the sender's first name (e.g. "Hi Ahmed,")\n- Write the reply in clear, well-spaced paragraphs\n- Close with a professional sign-off (e.g. "Best regards,") on its own line, followed by the mailbox owner's first name: ${ownerFirstName}\nNo markdown, no bullet lists, no headers — natural paragraphs only.`,
		},
		{
			role: "user",
			content: `Draft the mailbox owner's reply to the most recent message in this thread.\n\n${threadText}`,
		},
	];

	const text = await runGuardedDraftInference(env, {
		feature: "reply_draft",
		mailboxId,
		actorUserId,
		sourceVersion: `${email.thread_id ?? email.id}:${email.date ?? "unknown"}`,
		messages,
		maxTokens: 1024,
		temperature: 0.5,
	});

	const base = (email.subject || "").replace(/^(re:\s*)+/i, "").trim();
	const subject = base ? `Re: ${base}` : "Re:";

	return {
		to: email.sender || "",
		subject,
		body: textToHtml(text),
	};
}

/**
 * One-shot compose draft for a brand-new outbound email. The mailbox owner provides a
 * plain-language prompt describing what they want to write; the model returns
 * a subject line and a full email body (greeting → paragraphs → sign-off).
 */
export async function draftNewEmail(
	env: Env,
	mailboxId: string,
	prompt: string,
	actorUserId?: string,
): Promise<{ subject: string; body: string }> {
	const systemPrompt = await getMailboxSystemPrompt(env, mailboxId);

	const ownerRaw = mailboxId.split("@")[0].split(".")[0];
	const ownerFirstName = ownerRaw.charAt(0).toUpperCase() + ownerRaw.slice(1);

	const messages = [
		{
			role: "system",
			content: `${systemPrompt}\n\nYou are composing a brand-new outbound email on behalf of the mailbox owner whose mailbox is ${mailboxId}.\n\nOutput your response in exactly this format — nothing else:\nSUBJECT: <concise subject line>\n\n<full email body>\n\nThe body MUST:\n- Open with a natural greeting (e.g. "Hi [Name]," or "Dear [Name],")\n- Contain clear, well-spaced paragraphs conveying the message\n- Close with a professional sign-off (e.g. "Best regards,") on its own line followed by the mailbox owner's first name: ${ownerFirstName}\nNo markdown, no bullet lists, no headers — natural paragraphs only.`,
		},
		{
			role: "user",
			content: boundAiText(prompt, 8_000),
		},
	];

	const text = await runGuardedDraftInference(env, {
		feature: "compose_draft",
		mailboxId,
		actorUserId,
		sourceVersion: "new-compose-v1",
		messages,
		maxTokens: 1024,
		temperature: 0.6,
	});

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
