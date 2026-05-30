// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Outbound delivery for the Whispyr sales mail portal.
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
}

/** Thrown when SES rejects or fails a send. `status` is the HTTP status if any. */
export class SesSendError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SesSendError";
	}
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
	const destination: Record<string, string[]> = {
		ToAddresses: toAddressArray(params.to),
	};
	const cc = toAddressArray(params.cc);
	const bcc = toAddressArray(params.bcc);
	if (cc.length > 0) destination.CcAddresses = cc;
	if (bcc.length > 0) destination.BccAddresses = bcc;

	const payload = {
		FromEmailAddress: formatAddress(params.from),
		Destination: destination,
		...(params.replyTo
			? { ReplyToAddresses: [formatAddress(params.replyTo)] }
			: {}),
		Content: { Simple: buildSimpleContent(params) },
	};

	const url = `https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`;
	const signer = getSigner(env);

	let res: Response;
	try {
		res = await signer.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (e) {
		throw new SesSendError(
			`SES request failed: ${(e as Error).message}`,
		);
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new SesSendError(
			`SES SendEmail failed (${res.status}): ${detail}`,
			res.status,
		);
	}

	const result = (await res.json()) as { MessageId?: string };
	if (!result.MessageId) {
		throw new SesSendError("SES SendEmail returned no MessageId");
	}
	return { messageId: result.MessageId };
}
