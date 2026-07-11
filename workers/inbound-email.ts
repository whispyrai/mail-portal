// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import PostalMime from "postal-mime";
import { Folders } from "../shared/folders.ts";
import { buildPushPayload } from "./lib/push/payload.ts";
import { MAX_EMAIL_SIZE, storeParsedEmail } from "./lib/store-email.ts";
import {
	isAddressInConfiguredMailDomains,
	normalizeMailAddress,
} from "./lib/mail-address.ts";
import { resolveBrand } from "./routes/brand.ts";
import type { Env } from "./types.ts";

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) {
		throw new Error(
			`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`,
		);
	}
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) {
			reader.cancel();
			throw new Error(`Stream exceeds declared size`);
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

export async function receiveEmail(
	event: Pick<ForwardableEmailMessage, "raw" | "rawSize" | "to" | "setReject">,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	const mailboxId = normalizeMailAddress(event.to);
	if (!mailboxId || !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS)) {
		console.log("[mail-receive] rejecting recipient outside configured domains");
		event.setReject("Mailbox unavailable");
		return;
	}
	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((address) =>
		address.toLowerCase(),
	);
	if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId)) {
		console.log("[mail-receive] rejecting recipient outside EMAIL_ADDRESSES", {
			mailboxId,
		});
		event.setReject("Mailbox unavailable");
		return;
	}

	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		console.log("[mail-receive] rejecting unprovisioned recipient", { mailboxId });
		event.setReject("Mailbox unavailable");
		return;
	}

	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);
	const messageId = crypto.randomUUID();
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const brand = resolveBrand(env.BRAND);

	await storeParsedEmail({ bucket: env.BUCKET, mailbox: stub }, parsedEmail, {
		folder: Folders.INBOX,
		date: new Date().toISOString(),
		messageId,
		read: false,
	});

	ctx.waitUntil(
		stub
			.firePush(
				buildPushPayload({
					emailId: messageId,
					mailboxId,
					fromName: parsedEmail.from?.name || null,
					fromAddress: parsedEmail.from?.address || "",
					subject: parsedEmail.subject || "",
					body: parsedEmail.text || parsedEmail.html || "",
					icon: brand.pwaIcon192,
					badge: brand.notificationBadge,
				}),
			)
			.catch((error) =>
				console.error(
					"Push dispatch failed:",
					error instanceof Error ? error.message : String(error),
				),
			),
	);
}
