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

async function recordCredentialRecoveryEvent(
	c: SesContext,
	input: {
		eventId: string;
		outboxId: string;
		attemptId: string;
		providerMessageId: string;
		eventType: "delivery" | "bounce" | "complaint";
		occurredAt: number;
		receivedAt: number;
	},
) {
	if (
		[input.eventId, input.outboxId, input.attemptId, input.providerMessageId].some(
			(value) => value.length === 0 || value.length > 255,
		)
	) {
		return c.json({ error: "Invalid SES event correlation" }, 400);
	}
	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE credential_recovery_delivery_outbox
			 SET state = 'accepted', lease_token = NULL, lease_expires_at = NULL,
			     payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
			     provider_message_id = ?, accepted_attempt_id = ?, accepted_at = ?,
			     completed_at = ?, updated_at = ?, last_error_code = NULL
			 WHERE id = ? AND state IN ('pending', 'leased', 'dispatching', 'cancelled', 'expired', 'parked')
			   AND EXISTS (
			     SELECT 1 FROM credential_recovery_delivery_attempts
			     WHERE attempt_id = ? AND outbox_id = ?
			       AND state IN ('dispatching', 'ambiguous', 'http_rejected')
			   )`,
		).bind(
			input.providerMessageId,
			input.attemptId,
			input.receivedAt,
			input.receivedAt,
			input.receivedAt,
			input.outboxId,
			input.attemptId,
			input.outboxId,
		),
		c.env.DB.prepare(
			`UPDATE credential_recovery_delivery_attempts
			 SET state = 'accepted', provider_message_id = ?, resolved_at = ?, updated_at = ?
			 WHERE attempt_id = ? AND outbox_id = ?
			   AND state IN ('dispatching', 'ambiguous', 'http_rejected')
			   AND EXISTS (
			     SELECT 1 FROM credential_recovery_delivery_outbox
			     WHERE id = ? AND state = 'accepted'
			   )`,
		).bind(
			input.providerMessageId,
			input.receivedAt,
			input.receivedAt,
			input.attemptId,
			input.outboxId,
			input.outboxId,
		),
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO credential_recovery_delivery_events
			 (event_id, outbox_id, attempt_id, provider_message_id, event_type, occurred_at, recorded_at)
			 SELECT ?, o.id, a.attempt_id, ?, ?, ?, ?
			 FROM credential_recovery_delivery_outbox o
			 JOIN credential_recovery_delivery_attempts a
			   ON a.outbox_id = o.id AND a.attempt_id = ?
			 WHERE o.id = ? AND o.state = 'accepted' AND a.state = 'accepted'
			   AND a.provider_message_id = ?`,
		).bind(
			input.eventId,
			input.providerMessageId,
			input.eventType,
			input.occurredAt,
			input.receivedAt,
			input.attemptId,
			input.outboxId,
			input.providerMessageId,
		),
		c.env.DB.prepare(
			`UPDATE credential_recovery_delivery_outbox
			 SET provider_event_status = ?, provider_event_at = ?, updated_at = ?
			 WHERE id = ? AND state = 'accepted'
			   AND accepted_attempt_id = ? AND provider_message_id = ?
			   AND (provider_event_at IS NULL OR provider_event_at <= ?)
			   AND EXISTS (
			     SELECT 1 FROM credential_recovery_delivery_events
			     WHERE event_id = ? AND outbox_id = ? AND attempt_id = ?
			       AND provider_message_id = ?
			       AND event_type = ?
			   )`,
		).bind(
			input.eventType,
			input.occurredAt,
			input.receivedAt,
			input.outboxId,
			input.attemptId,
			input.providerMessageId,
			input.occurredAt,
			input.eventId,
			input.outboxId,
			input.attemptId,
			input.providerMessageId,
			input.eventType,
		),
	]);
	const recorded = await c.env.DB.prepare(
		`SELECT event_type FROM credential_recovery_delivery_events
		 WHERE event_id = ? AND outbox_id = ? AND attempt_id = ?
		   AND provider_message_id = ?`,
	)
		.bind(input.eventId, input.outboxId, input.attemptId, input.providerMessageId)
		.first<{ event_type: string }>();
	if (!recorded) {
		const current = await c.env.DB.prepare(
			`SELECT o.state, o.accepted_attempt_id, o.provider_message_id,
			        a.state AS attempt_state
			 FROM credential_recovery_delivery_outbox o
			 LEFT JOIN credential_recovery_delivery_attempts a
			   ON a.outbox_id = o.id AND a.attempt_id = ?
			 WHERE o.id = ?`,
		)
			.bind(input.attemptId, input.outboxId)
			.first<{
				state: string;
				accepted_attempt_id: string | null;
				provider_message_id: string | null;
				attempt_state: string | null;
			}>();
		return current
			? c.json({ error: "Invalid SES event correlation" }, 400)
			: c.json({ error: "SES event correlation is not ready" }, 503);
	}
	if (recorded.event_type !== input.eventType) {
		return c.json({ error: "Invalid SES event correlation" }, 400);
	}
	console.info("[credential-recovery] provider event recorded", {
		operation: "credential_recovery_provider_event",
		deliveryId: input.outboxId,
		attemptId: input.attemptId,
		eventType: input.eventType,
		outcome: "recorded",
	});
	return c.json({ status: "recorded" }, 202);
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

	const declaredLength = Number(c.req.header("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
		return c.json({ error: "SES event body is too large" }, 413);
	}
	const rawBody = await c.req.text();
	if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) {
		return c.json({ error: "SES event body is too large" }, 413);
	}
	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(rawBody) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return c.json({ error: "Invalid SES event" }, 400);
		}
		body = parsed as Record<string, unknown>;
	} catch {
		return c.json({ error: "Invalid SES event" }, 400);
	}
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
	const credentialRecoveryId = firstTag(tags, "CredentialRecoveryId");
	const credentialRecoveryAttempt = firstTag(tags, "CredentialRecoveryAttempt");
	const eventId = typeof body.id === "string" ? body.id.trim() : "";
	const receivedAtDate = new Date();
	const occurredAtRaw =
		typeof body.time === "string" ? body.time : receivedAtDate.toISOString();
	const occurredAtMs = Number.isFinite(Date.parse(occurredAtRaw))
		? Date.parse(occurredAtRaw)
		: receivedAtDate.getTime();
	if (credentialRecoveryId || credentialRecoveryAttempt) {
		if (!sesMessageId || !eventId || !credentialRecoveryId || !credentialRecoveryAttempt) {
			return c.json({ error: "Invalid SES event correlation" }, 400);
		}
		return recordCredentialRecoveryEvent(c, {
			eventId,
			outboxId: credentialRecoveryId,
			attemptId: credentialRecoveryAttempt,
			providerMessageId: sesMessageId,
			eventType: rawType,
			occurredAt: occurredAtMs,
			receivedAt: receivedAtDate.getTime(),
		});
	}
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
	const receivedAt = receivedAtDate.toISOString();
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
