// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { Folders } from "../../../shared/folders.ts";
import {
  emailExists,
  storeParsedEmail,
  type EmailStorageDependencies,
} from "../store-email.ts";
import { storeStreamingEmail } from "../streaming-email.ts";

type RecoverInboundOptions = {
  ingressId: string;
  archivedAt: string;
};

/** Rebuild one archived inbound projection without changing its stable identity. */
export async function recoverInboundEmail(
  dependencies: EmailStorageDependencies,
  parsed: Email,
  options: RecoverInboundOptions,
) {
  if (
    dependencies.mailbox.isEmailDeleted &&
    (await dependencies.mailbox.isEmailDeleted(options.ingressId))
  ) {
    return { status: "skipped" as const, reason: "deleted" as const };
  }
  if (await emailExists(dependencies.mailbox, options.ingressId)) {
    return { status: "skipped" as const, reason: "duplicate" as const };
  }

  try {
    await storeParsedEmail(dependencies, parsed, {
      folder: Folders.INBOX,
      date: options.archivedAt,
      messageId: options.ingressId,
      read: false,
      allowTerminalRecovery: true,
    });
  } catch (error) {
    if (!(await emailExists(dependencies.mailbox, options.ingressId)))
      throw error;
    return { status: "recovered" as const, ambiguousCommit: true };
  }

  return { status: "recovered" as const, ambiguousCommit: false };
}

/** Rebuild one archived projection from an R2 stream without buffering MIME. */
export async function recoverStreamingInboundEmail(
  dependencies: EmailStorageDependencies,
  raw: ReadableStream,
  options: RecoverInboundOptions,
) {
  if (
    dependencies.mailbox.isEmailDeleted &&
    (await dependencies.mailbox.isEmailDeleted(options.ingressId))
  ) {
    return { status: "skipped" as const, reason: "deleted" as const };
  }
  if (await emailExists(dependencies.mailbox, options.ingressId)) {
    return { status: "skipped" as const, reason: "duplicate" as const };
  }

  try {
    await storeStreamingEmail(dependencies, raw, {
      folder: Folders.INBOX,
      date: options.archivedAt,
      messageId: options.ingressId,
      read: false,
      allowTerminalRecovery: true,
    });
  } catch (error) {
    if (!(await emailExists(dependencies.mailbox, options.ingressId)))
      throw error;
    return { status: "recovered" as const, ambiguousCommit: true };
  }

  return { status: "recovered" as const, ambiguousCommit: false };
}
