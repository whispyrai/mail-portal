// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import {
  emailExists,
  storeParsedEmail,
  type EmailStorageDependencies,
} from "../store-email.ts";
import { storeStreamingEmail } from "../streaming-email.ts";
import { liveInboundProjectionOptions } from "../live-inbound-projection.ts";
import type { InboundCleanupIntentPreflightBucket } from "../inbound-derived-content-cleanup-intent.ts";
import type { InboundArchivePointer } from "../../inbound-email.ts";
import type { InboundArchiveAuthority } from "../inbound-projection-contract.ts";

type RecoverInboundOptions = {
  archiveAuthority: InboundArchiveAuthority;
  brand?: string;
};

export function exactRecoveryArchiveAuthority(
  pointer: InboundArchivePointer,
): InboundArchiveAuthority {
  if (pointer.rawSha256 === undefined) {
    throw new Error("Inbound recovery requires exact archive authority");
  }
  return {
    schemaVersion: pointer.schemaVersion,
    ingressId: pointer.ingressId,
    rawKey: pointer.rawKey,
    mailboxId: pointer.mailboxId,
    rawSize: pointer.rawSize,
    rawSha256: pointer.rawSha256,
    archivedAt: pointer.archivedAt,
    etag: pointer.etag,
    version: pointer.version,
  };
}

function exactProjectionResponse(
  value: unknown,
): value is { generation: 1 } {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Object.keys(value as Record<string, unknown>).length === 1 &&
    (value as Record<string, unknown>).generation === 1
  );
}

function exactDeletionResponse(
  value: unknown,
): value is { generation: number; deletedAt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    Number.isSafeInteger(record.generation) &&
    Number(record.generation) >= 2 &&
    typeof record.deletedAt === "string" &&
    Number.isFinite(Date.parse(record.deletedAt)) &&
    new Date(record.deletedAt).toISOString() === record.deletedAt
  );
}

async function exactRecoveryTruth(
  dependencies: EmailStorageDependencies,
  authority: InboundArchiveAuthority,
): Promise<"deleted" | "stored" | null> {
  const getDeletion =
    dependencies.mailbox.getInboundDeletionAuthority?.bind(
      dependencies.mailbox,
    );
  const getProjection =
    dependencies.mailbox.getInboundProjectionAuthority?.bind(
      dependencies.mailbox,
    );
  if (!getDeletion || !getProjection) {
    throw new Error("Inbound recovery authority lookup is unavailable");
  }
  const deletion = await getDeletion(authority);
  if (deletion && !exactDeletionResponse(deletion)) {
    throw new Error("Inbound recovery deletion authority is invalid");
  }
  if (deletion) return "deleted";
  const projection = await getProjection(authority);
  if (projection && !exactProjectionResponse(projection)) {
    throw new Error("Inbound recovery projection authority is invalid");
  }
  const existing = await emailExists(
    dependencies.mailbox,
    authority.ingressId,
  );
  if (projection && existing) return "stored";
  if (projection || existing) {
    throw new Error("Inbound recovery identity conflicts with mailbox state");
  }
  return null;
}

/** Rebuild one archived inbound projection without changing its stable identity. */
export async function recoverInboundEmail(
  dependencies: EmailStorageDependencies,
  parsed: Email,
  options: RecoverInboundOptions,
) {
  const initialTruth = await exactRecoveryTruth(
    dependencies,
    options.archiveAuthority,
  );
  if (initialTruth === "deleted") {
    return { status: "skipped" as const, reason: "deleted" as const };
  }
  if (initialTruth === "stored") {
    return { status: "skipped" as const, reason: "duplicate" as const };
  }

  try {
    await storeParsedEmail(
      dependencies,
      parsed,
      liveInboundProjectionOptions({
        brand: options.brand,
        mailboxId: options.archiveAuthority.mailboxId,
        messageId: options.archiveAuthority.ingressId,
        date: options.archiveAuthority.archivedAt,
        allowTerminalRecovery: true,
        archiveAuthority: options.archiveAuthority,
      }),
    );
  } catch (error) {
    const terminalTruth = await exactRecoveryTruth(
      dependencies,
      options.archiveAuthority,
    );
    if (terminalTruth === "stored") {
      return { status: "recovered" as const, ambiguousCommit: true };
    }
    if (terminalTruth === "deleted") {
      return { status: "skipped" as const, reason: "deleted" as const };
    }
    throw error;
  }

  return { status: "recovered" as const, ambiguousCommit: false };
}

/** Rebuild one archived projection from an R2 stream without buffering MIME. */
export async function recoverStreamingInboundEmail(
  dependencies: EmailStorageDependencies,
  raw: ReadableStream,
  options: RecoverInboundOptions,
  cleanupIntentBucket: InboundCleanupIntentPreflightBucket,
) {
  const initialTruth = await exactRecoveryTruth(
    dependencies,
    options.archiveAuthority,
  );
  if (initialTruth === "deleted") {
    return { status: "skipped" as const, reason: "deleted" as const };
  }
  if (initialTruth === "stored") {
    return { status: "skipped" as const, reason: "duplicate" as const };
  }

  try {
    await storeStreamingEmail(
      dependencies,
      raw,
      liveInboundProjectionOptions({
        brand: options.brand,
        mailboxId: options.archiveAuthority.mailboxId,
        messageId: options.archiveAuthority.ingressId,
        date: options.archiveAuthority.archivedAt,
        allowTerminalRecovery: true,
        archiveAuthority: options.archiveAuthority,
      }),
      cleanupIntentBucket,
    );
  } catch (error) {
    const terminalTruth = await exactRecoveryTruth(
      dependencies,
      options.archiveAuthority,
    );
    if (terminalTruth === "stored") {
      return { status: "recovered" as const, ambiguousCommit: true };
    }
    if (terminalTruth === "deleted") {
      return { status: "skipped" as const, reason: "deleted" as const };
    }
    throw error;
  }

  return { status: "recovered" as const, ambiguousCommit: false };
}
