// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import type { FolderId } from "../../../shared/folders";
import {
	storeParsedEmail,
	type EmailStorageDependencies,
} from "../store-email.ts";
import {
	deriveImportId,
	deriveImportThreadId,
	normalizeEmailDate,
} from "./parse.ts";

/** Import one parsed Zoho message without duplicating an earlier run. */
export async function importParsedEmail(
	dependencies: EmailStorageDependencies,
	parsed: Email,
	folder: FolderId,
) {
	const recipients = [...(parsed.to ?? []), ...(parsed.cc ?? []), ...(parsed.bcc ?? [])]
		.flatMap((recipient) => (recipient.address ? [recipient.address.toLowerCase()] : []))
		.sort()
		.join(",");
	const identity = {
		messageId: parsed.messageId,
		from: parsed.from?.address?.toLowerCase(),
		to: recipients,
		date: parsed.date,
		subject: parsed.subject,
		content: parsed.html ?? parsed.text ?? "",
	};
	const id = await deriveImportId(identity);

	if (await dependencies.mailbox.getEmail(id)) {
		return { status: "skipped" as const, reason: "duplicate" as const, id, folder };
	}

	await storeParsedEmail(dependencies, parsed, {
		folder,
		date: normalizeEmailDate(parsed.date),
		messageId: id,
		read: true,
		threadId: await deriveImportThreadId({
			...identity,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		}),
	});

	return { status: "imported" as const, id, folder };
}
