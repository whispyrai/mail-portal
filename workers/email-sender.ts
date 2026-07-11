// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Outbound delivery for the shared team mail portal.
//
// Upstream Agentic Inbox sent through the Cloudflare Email Service binding
// (`env.EMAIL.send()`). This fork sends through AWS SES instead (existing
// production-verified account, eu-west-2), signed with SigV4 via aws4fetch.
// See whispyr-sales/initiatives/sales-mail-portal/locked-decisions.md (D-13, D-17).
//
// We use the SES API v2 `SendEmail` operation with **Simple** content (not
// hand-rolled raw MIME): SES assembles the MIME, handles UTF-8/charset and
// boundaries, derives the To/Cc headers from Destination and hides Bcc, and
// still lets us set threading headers (In-Reply-To / References are permitted as
// custom Headers; From/To/Cc/Bcc/Subject/Message-ID/Date are not).
//
// Note: SES overwrites the Message-ID and Date headers with its own values, so
// the returned MessageId (not anything we generate) identifies the delivered
// message. See architecture.md "On the Message-ID" and build-findings-2026-05-29.

import { AwsClient } from "aws4fetch";
import type { SesObservedOutcome } from "./lib/outbound-delivery-contract.ts";
import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	/** Extra headers to set on the message, e.g. In-Reply-To and References. */
	headers?: Record<string, string>;
	/** Correlation tags returned by SES event publishing for bounce handling. */
	tracking?: { mailboxId: string; deliveryId: string };
}

/** Thrown when SES rejects or fails a send. `status` is the HTTP status if any. */
export class SesSendError extends Error {
	readonly status?: number;

	constructor(
		message: string,
		status?: number,
	) {
		super(message);
		this.name = "SesSendError";
		this.status = status;
	}
}

/** Minimal transport boundary used by the SES outcome adapter. */
export interface SesRequestTransport {
	fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface SesSendDependencies {
	/** Creating the transport happens before dispatch and is therefore testable. */
	createTransport?: (env: Env) => SesRequestTransport;
}

/** Format an address as `Name <email>` or bare `email`. */
function formatAddress(addr: string | { email: string; name: string }): string {
	if (typeof addr === "string") return addr;
	return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

/** Normalise a string | string[] | comma-list into a trimmed string array. */
function toAddressArray(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const parts = Array.isArray(value) ? value : value.split(",");
	return parts.map((p) => p.trim()).filter(Boolean);
}

// Reuse a single signer per credential set; AwsClient caches derived signing
// keys internally, so re-instantiating per send would throw that work away.
let signerCache: { key: string; client: AwsClient } | null = null;
function getSigner(env: Env): AwsClient {
	if (signerCache?.key === env.AWS_ACCESS_KEY_ID) return signerCache.client;
	const client = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.AWS_REGION,
		// The SES endpoint host is email.<region>.amazonaws.com, but the SigV4
		// signing service name is "ses". aws4fetch would otherwise infer "email"
		// from the host and produce a signature SES rejects with 403.
		service: "ses",
	});
	signerCache = { key: env.AWS_ACCESS_KEY_ID, client };
	return client;
}

function createDefaultTransport(env: Env): SesRequestTransport {
	const signer = getSigner(env);
	return {
		fetch: (input, init) => signer.fetch(input, init),
	};
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function base64UrlText(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

interface SesHeader {
	Name: string;
	Value: string;
}

/** Build the SES v2 `Content.Simple` object from our params. */
function buildSimpleContent(params: SendEmailParams): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (params.html) body.Html = { Data: params.html, Charset: "UTF-8" };
	if (params.text) body.Text = { Data: params.text, Charset: "UTF-8" };
	// SES requires a non-empty body; guarantee at least an empty text part.
	if (!params.html && !params.text) body.Text = { Data: "", Charset: "UTF-8" };

	const simple: Record<string, unknown> = {
		Subject: { Data: params.subject, Charset: "UTF-8" },
		Body: body,
	};

	if (params.headers) {
		const headers: SesHeader[] = Object.entries(params.headers)
			.filter(([, value]) => value != null && value !== "")
			.map(([Name, Value]) => ({ Name, Value }));
		if (headers.length > 0) simple.Headers = headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		simple.Attachments = params.attachments.map((att) => ({
			RawContent: att.content, // base64 over the wire (HTTPS interface); SES decodes it
			FileName: att.filename,
			ContentType: att.type,
			// SES's enum is UPPERCASE (`ATTACHMENT | INLINE`); a lowercase value is
			// not a valid enum and is rejected/ignored.
			ContentDisposition: att.disposition === "inline" ? "INLINE" : "ATTACHMENT",
			// Force base64 in the MIME SES assembles. The default (SEVEN_BIT) mangles
			// any non-7-bit payload — i.e. every PDF, image, or office document.
			ContentTransferEncoding: "BASE64",
			...(att.contentId ? { ContentId: att.contentId } : {}),
		}));
	}

	return simple;
}

/**
 * Send an email via AWS SES (API v2 SendEmail, Simple content).
 *
 * @param env    - Worker env (AWS credentials + region)
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns The SES-assigned `MessageId` for the delivered message.
 * @throws SesSendError on validation or delivery failure.
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const outcome = await sendEmailWithOutcome(env, params);

	switch (outcome.kind) {
		case "accepted":
			return { messageId: outcome.messageId };
		case "http_error":
			throw new SesSendError(
				`SES SendEmail failed (${outcome.status}): ${outcome.detail ?? ""}`,
				outcome.status,
			);
		case "not_dispatched":
		case "transport_ambiguous":
			throw new SesSendError(`SES request failed: ${outcome.detail ?? ""}`);
		case "invalid_success_response":
			throw new SesSendError(
				outcome.detail ?? "SES SendEmail returned no MessageId",
			);
	}
}

/**
 * Observe an SES send without claiming more certainty than the HTTP exchange
 * proves. In particular, once `transport.fetch` is invoked, any thrown error is
 * ambiguous because SES may have accepted the message before the response was
 * lost. Callers must not automatically retry ambiguous outcomes.
 */
export async function sendEmailWithOutcome(
	env: Env,
	params: SendEmailParams,
	dependencies: SesSendDependencies = {},
): Promise<SesObservedOutcome> {
	const destination: Record<string, string[]> = {
		ToAddresses: toAddressArray(params.to),
	};
	const cc = toAddressArray(params.cc);
	const bcc = toAddressArray(params.bcc);
	if (cc.length > 0) destination.CcAddresses = cc;
	if (bcc.length > 0) destination.BccAddresses = bcc;

	let transport: SesRequestTransport;
	let url: string;
	let request: RequestInit;
	try {
		const payload = {
			FromEmailAddress: formatAddress(params.from),
			Destination: destination,
			...(params.tracking
				? { ConfigurationSetName: env.SES_CONFIGURATION_SET }
				: {}),
			...(params.replyTo
				? { ReplyToAddresses: [formatAddress(params.replyTo)] }
				: {}),
			Content: { Simple: buildSimpleContent(params) },
			...(params.tracking
				? {
						EmailTags: [
							{
								Name: "MailboxKey",
								Value: base64UrlText(params.tracking.mailboxId),
							},
							{
								Name: "DeliveryId",
								Value: params.tracking.deliveryId,
							},
						],
					}
				: {}),
		};
		url = `https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`;
		request = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		};
		transport = (dependencies.createTransport ?? createDefaultTransport)(env);
	} catch (error) {
		return { kind: "not_dispatched", detail: errorDetail(error) };
	}

	let res: Response;
	try {
		res = await transport.fetch(url, request);
	} catch (error) {
		return { kind: "transport_ambiguous", detail: errorDetail(error) };
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		return { kind: "http_error", status: res.status, detail };
	}

	let result: unknown;
	try {
		result = await res.json();
	} catch (error) {
		return {
			kind: "invalid_success_response",
			detail: errorDetail(error),
		};
	}

	const messageId =
		typeof result === "object" &&
		result !== null &&
		"MessageId" in result &&
		typeof result.MessageId === "string"
			? result.MessageId.trim()
			: "";
	if (!messageId) {
		return {
			kind: "invalid_success_response",
			detail: "SES SendEmail returned no MessageId",
		};
	}

	return { kind: "accepted", messageId };
}
