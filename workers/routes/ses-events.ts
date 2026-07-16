import type { Context } from "hono";
import { readBearerToken } from "../lib/auth.ts";
import {
	isAddressInConfiguredMailDomains,
	normalizeMailAddress,
} from "../lib/mail-address.ts";
import type { Env } from "../types.ts";

type SesContext = Context<{ Bindings: Env }>;

function constantTimeEqual(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let mismatch = left.length ^ right.length;
	for (let index = 0; index < length; index++) {
		mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return mismatch === 0;
}

function firstTag(tags: unknown, name: string): string | undefined {
	if (!tags || typeof tags !== "object") return undefined;
	const value = (tags as Record<string, unknown>)[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return undefined;
}

function decodeBase64UrlText(value: string): string | null {
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const binary = atob(padded);
		return new TextDecoder().decode(
			Uint8Array.from(binary, (character) => character.charCodeAt(0)),
		);
	} catch {
		return null;
	}
}

function eventRecipients(
	detail: Record<string, unknown>,
	eventType: "delivery" | "bounce" | "complaint",
): string[] {
	const section =
		detail[eventType] && typeof detail[eventType] === "object"
			? (detail[eventType] as Record<string, unknown>)
			: null;
	const raw = eventType === "delivery"
		? section?.recipients
		: eventType === "bounce"
			? section?.bouncedRecipients
			: section?.complainedRecipients;
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.flatMap((entry) => {
		const value = typeof entry === "string"
			? entry
			: entry && typeof entry === "object"
				? (entry as Record<string, unknown>).emailAddress
				: null;
		const address = typeof value === "string" ? normalizeMailAddress(value) : null;
		return address ? [address] : [];
	}))].sort();
}

async function recipientHash(address: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(address),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function handleSesEvent(c: SesContext) {
	const token = readBearerToken(c.req.header("authorization"));
	if (
		!token ||
		!c.env.SES_EVENT_WEBHOOK_SECRET ||
		!constantTimeEqual(token, c.env.SES_EVENT_WEBHOOK_SECRET)
	) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = (await c.req.json()) as Record<string, unknown>;
	const detail =
		body.detail && typeof body.detail === "object"
			? (body.detail as Record<string, unknown>)
			: body;
	const rawType = String(
		detail.eventType ?? detail.notificationType ?? "",
	).toLowerCase();
	if (
		rawType !== "delivery" &&
		rawType !== "bounce" &&
		rawType !== "complaint"
	) {
		return c.json({ status: "ignored" }, 202);
	}
	const mail =
		detail.mail && typeof detail.mail === "object"
			? (detail.mail as Record<string, unknown>)
			: null;
	const sesMessageId = typeof mail?.messageId === "string" ? mail.messageId : "";
	const tags = mail?.tags;
	const mailboxKey = firstTag(tags, "MailboxKey");
	const deliveryId = firstTag(tags, "DeliveryId");
	const attemptId = firstTag(tags, "AttemptId");
	const eventId = typeof body.id === "string" ? body.id.trim() : "";
	const mailboxId = mailboxKey
		? normalizeMailAddress(decodeBase64UrlText(mailboxKey) ?? "")
		: null;
	if (
		!sesMessageId ||
		!eventId ||
		!deliveryId ||
		!attemptId ||
		!mailboxId ||
		!isAddressInConfiguredMailDomains(mailboxId, c.env.DOMAINS)
	) {
		return c.json({ error: "Invalid SES event correlation" }, 400);
	}

	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	const receivedAt = new Date().toISOString();
	const occurredAtRaw =
		typeof body.time === "string" ? body.time : receivedAt;
	const occurredAt = Number.isFinite(Date.parse(occurredAtRaw))
		? new Date(Date.parse(occurredAtRaw)).toISOString()
		: receivedAt;
	const result = await stub.recordSesProviderEvent({
		eventId,
		deliveryId,
		attemptId,
		sesMessageId,
		eventType: rawType,
		recipientHashes: await Promise.all(
			eventRecipients(detail, rawType).map(recipientHash),
		),
		occurredAt,
		receivedAt,
	});
	if (result.status === "not_found") {
		console.warn("[ses-event] delivery correlation was not found", {
			mailboxId,
			deliveryId,
			attemptId,
			sesMessageId,
		});
	}
	if ("recoveryPending" in result && result.recoveryPending) {
		return c.json(
			{
				error: "SES event committed; local projection recovery is pending",
				status: result.status,
			},
			503,
		);
	}
	if (result.status === "not_found") {
		return c.json({ error: "SES event correlation is not ready" }, 503);
	}
	if (result.status === "invalid_correlation") {
		return c.json({ error: "Invalid SES event correlation" }, 400);
	}
	return c.json({ status: result.status }, 202);
}
