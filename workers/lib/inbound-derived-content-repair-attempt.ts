import type {
  InboundDerivedContentManifest,
  InboundDerivedContentRepairAttemptIdentity,
  InboundDerivedContentRepairAttemptTerminal,
  InboundDerivedContentRepairCommand,
} from "./inbound-projection-contract.ts";
import { arrayBufferToHex } from "./checksum.ts";
import {
  validateInboundDerivedContentCleanupProof,
  type InboundDerivedContentCleanupCandidate,
  type InboundDerivedContentCleanupProofRequest,
} from "./inbound-derived-content-cleanup.ts";
import { INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE } from "./inbound-reconciliation-budget.ts";
import { mailTelemetryLogRef } from "./mail-telemetry.ts";

export const INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION = 1;
export const INBOUND_REPAIR_ATTEMPT_BATCH_SIZE =
  INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE;
export const INBOUND_REPAIR_ATTEMPT_GRACE_MS = 5 * 60 * 1000;

const PENDING_PREFIX = "system/derived-content-repair-attempts/pending/";
const RESOLVED_PREFIX = "system/derived-content-repair-attempts/resolved/";
const CURSOR_KEY = "system/derived-content-repair-attempts/cursor.json";
const MAX_ATTEMPT_OBJECTS = 512;

export type InboundDerivedContentProof = {
  attachments: Array<{ r2Key: string; byteLength: number }>;
  bodyObjects: Array<{ r2Key: string; byteLength: number }>;
};

export type InboundDerivedContentRepairAttempt = {
  schemaVersion: typeof INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION;
  kind: "inbound_derived_content_repair_attempt";
  status: "pending";
  attemptId: string;
  ingressId: string;
  mailboxId: string;
  expectedGeneration: number;
  markerId: string;
  commandFingerprint: string;
  createdAt: string;
  proof: InboundDerivedContentProof;
};

export type InboundDerivedContentRepairResolution = {
  schemaVersion: typeof INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION;
  kind: "inbound_derived_content_repair_resolution";
  status: "resolved";
  resolution: "discarded" | "owned";
  attempt: InboundDerivedContentRepairAttempt;
};

const REPAIR_ATTEMPT_KEYS = [
  "attemptId",
  "commandFingerprint",
  "createdAt",
  "expectedGeneration",
  "ingressId",
  "kind",
  "mailboxId",
  "markerId",
  "proof",
  "schemaVersion",
  "status",
] as const;

const DERIVED_CONTENT_PROOF_KEYS = ["attachments", "bodyObjects"] as const;
const DERIVED_CONTENT_PROOF_ENTRY_KEYS = ["byteLength", "r2Key"] as const;
const REPAIR_RESOLUTION_KEYS = [
  "attempt",
  "kind",
  "resolution",
  "schemaVersion",
  "status",
] as const;

type LedgerObject = { etag?: string; text(): Promise<string> };

type RepairAttemptLedgerBucket = {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<LedgerObject | null>;
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
};

type RepairAttemptReconciliationEnvironment = {
  RAW_MAIL_BUCKET: RepairAttemptLedgerBucket;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): {
      finalizeInboundDerivedContentRepairAttempt?(
        identity: InboundDerivedContentRepairAttemptIdentity,
      ): Promise<InboundDerivedContentRepairAttemptTerminal>;
      enqueueUnownedInboundDerivedContentCleanup?(
        input: InboundDerivedContentCleanupProofRequest,
      ): Promise<{ queued: number; retained: number; absent: number }>;
    };
  };
};

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.some((candidate) => candidate === key))
  );
}

function projectDerivedContentProof(
  proof: InboundDerivedContentProof,
): InboundDerivedContentProof {
  const projectEntries = (
    entries: Array<{ r2Key: string; byteLength: number }>,
  ) => entries.map((entry) => ({
    r2Key: entry.r2Key,
    byteLength: entry.byteLength,
  }));
  return {
    attachments: projectEntries(proof.attachments),
    bodyObjects: projectEntries(proof.bodyObjects),
  };
}

function projectRepairAttempt(
  attempt: InboundDerivedContentRepairAttempt,
): InboundDerivedContentRepairAttempt {
  return {
    schemaVersion: attempt.schemaVersion,
    kind: attempt.kind,
    status: attempt.status,
    attemptId: attempt.attemptId,
    ingressId: attempt.ingressId,
    mailboxId: attempt.mailboxId,
    expectedGeneration: attempt.expectedGeneration,
    markerId: attempt.markerId,
    commandFingerprint: attempt.commandFingerprint,
    createdAt: attempt.createdAt,
    proof: projectDerivedContentProof(attempt.proof),
  };
}

function projectRepairResolution(
  resolution: InboundDerivedContentRepairResolution,
): InboundDerivedContentRepairResolution {
  return {
    schemaVersion: resolution.schemaVersion,
    kind: resolution.kind,
    status: resolution.status,
    resolution: resolution.resolution,
    attempt: projectRepairAttempt(resolution.attempt),
  };
}

function sortedProofEntries(
  entries: Array<{ r2Key: string; byteLength: number }>,
) {
  return entries
    .map((entry) => ({
      r2Key: entry.r2Key,
      byteLength: entry.byteLength,
    }))
    .sort((left, right) =>
      left.r2Key === right.r2Key
        ? left.byteLength - right.byteLength
        : left.r2Key.localeCompare(right.r2Key),
    );
}

export function repairAttemptProof(
  command: Pick<InboundDerivedContentRepairCommand, "attachments" | "bodyObjects">,
): InboundDerivedContentProof {
  return {
    attachments: sortedProofEntries(
      command.attachments.map((attachment) => ({
        r2Key: attachment.r2_key!,
        byteLength: attachment.size,
      })),
    ),
    bodyObjects: sortedProofEntries(
      command.bodyObjects.map((bodyObject) => ({
        r2Key: bodyObject.r2_key,
        byteLength: bodyObject.byte_length,
      })),
    ),
  };
}

export function manifestDerivedContentProof(
  manifest: Extract<InboundDerivedContentManifest, { status: "live_inbound" }>,
): InboundDerivedContentProof {
  return {
    attachments: sortedProofEntries(
      manifest.attachments.map((attachment) => ({
        r2Key: attachment.r2Key,
        byteLength: attachment.byteLength,
      })),
    ),
    bodyObjects: sortedProofEntries(
      manifest.bodyObjects.map((bodyObject) => ({
        r2Key: bodyObject.r2Key,
        byteLength: bodyObject.byteLength,
      })),
    ),
  };
}

export function exactDerivedContentProofMatches(
  left: InboundDerivedContentProof,
  right: InboundDerivedContentProof,
): boolean {
  const exactEntriesMatch = (
    leftEntries: Array<{ r2Key: string; byteLength: number }>,
    rightEntries: Array<{ r2Key: string; byteLength: number }>,
  ) =>
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      (entry, index) =>
        entry.r2Key === rightEntries[index]?.r2Key &&
        entry.byteLength === rightEntries[index]?.byteLength,
    );
  return (
    exactEntriesMatch(
      sortedProofEntries(left.attachments),
      sortedProofEntries(right.attachments),
    ) &&
    exactEntriesMatch(
      sortedProofEntries(left.bodyObjects),
      sortedProofEntries(right.bodyObjects),
    )
  );
}

export function canonicalDerivedContentProof(
  proof: InboundDerivedContentProof,
): string {
  return JSON.stringify({
    attachments: sortedProofEntries(proof.attachments),
    bodyObjects: sortedProofEntries(proof.bodyObjects),
  });
}

export function canonicalInboundDerivedContentRepairCommand(
  command:
    | InboundDerivedContentRepairCommand
    | Omit<InboundDerivedContentRepairCommand, "commandFingerprint">,
): string {
  return JSON.stringify({
    attemptId: command.attemptId,
    emailId: command.emailId,
    expectedGeneration: command.expectedGeneration,
    markerId: command.markerId,
    body: command.body,
    attachments: [...command.attachments]
      .map((attachment) => ({
        id: attachment.id,
        email_id: attachment.email_id,
        filename: attachment.filename,
        mimetype: attachment.mimetype,
        size: attachment.size,
        content_id: attachment.content_id ?? null,
        disposition: attachment.disposition ?? null,
        r2_key: attachment.r2_key ?? null,
      }))
      .sort((left, right) =>
        left.id === right.id
          ? (left.r2_key ?? "").localeCompare(right.r2_key ?? "")
          : left.id.localeCompare(right.id),
      ),
    bodyObjects: [...command.bodyObjects]
      .map((bodyObject) => ({
        id: bodyObject.id,
        email_id: bodyObject.email_id,
        part_index: bodyObject.part_index,
        content_type: bodyObject.content_type,
        charset: bodyObject.charset,
        r2_key: bodyObject.r2_key,
        byte_length: bodyObject.byte_length,
      }))
      .sort((left, right) =>
        left.part_index === right.part_index
          ? left.id.localeCompare(right.id)
          : left.part_index - right.part_index,
      ),
  });
}

export async function inboundDerivedContentRepairCommandFingerprint(
  command: Omit<InboundDerivedContentRepairCommand, "commandFingerprint">,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalInboundDerivedContentRepairCommand(command),
  );
  return arrayBufferToHex(await crypto.subtle.digest("SHA-256", bytes));
}

export function pendingRepairAttemptKey(ingressId: string, attemptId: string) {
  return `${PENDING_PREFIX}${encodeURIComponent(ingressId)}/${attemptId}.json`;
}

export function resolvedRepairAttemptKey(ingressId: string, attemptId: string) {
  return `${RESOLVED_PREFIX}${encodeURIComponent(ingressId)}/${attemptId}.json`;
}

function isProofShape(value: unknown): value is InboundDerivedContentProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validEntries = (entries: unknown) =>
    Array.isArray(entries) &&
    entries.length <= MAX_ATTEMPT_OBJECTS &&
    entries.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const item = entry as Record<string, unknown>;
      return (
        hasExactKeys(item, DERIVED_CONTENT_PROOF_ENTRY_KEYS) &&
        typeof item.r2Key === "string" &&
        Number.isSafeInteger(item.byteLength) &&
        (item.byteLength as number) >= 0
      );
    });
  return (
    hasExactKeys(record, DERIVED_CONTENT_PROOF_KEYS) &&
    validEntries(record.attachments) &&
    validEntries(record.bodyObjects)
  );
}

export function isInboundDerivedContentRepairAttempt(
  value: unknown,
): value is InboundDerivedContentRepairAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const valid =
    hasExactKeys(record, REPAIR_ATTEMPT_KEYS) &&
    record.schemaVersion === INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION &&
    record.kind === "inbound_derived_content_repair_attempt" &&
    record.status === "pending" &&
    typeof record.attemptId === "string" &&
    typeof record.ingressId === "string" &&
    typeof record.mailboxId === "string" &&
    record.mailboxId.length > 0 &&
    Number.isSafeInteger(record.expectedGeneration) &&
    (record.expectedGeneration as number) >= 1 &&
    typeof record.markerId === "string" &&
    /^[A-Za-z0-9_-]{8,100}$/.test(record.markerId) &&
    typeof record.commandFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.commandFingerprint) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    isProofShape(record.proof) &&
    record.proof.attachments.length + record.proof.bodyObjects.length <=
      MAX_ATTEMPT_OBJECTS;
  if (!valid) return false;
  const attempt = record as InboundDerivedContentRepairAttempt;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.attemptId)) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(attempt.ingressId)) return false;
  const objects = [...attempt.proof.attachments, ...attempt.proof.bodyObjects];
  if (objects.length === 0) return true;
  try {
    validateInboundDerivedContentCleanupProof({
      emailId: attempt.ingressId,
      projectionAttemptId: attempt.attemptId,
      objects,
    });
  } catch {
    return false;
  }
  const attachmentPrefix = `attachments/${attempt.ingressId}/${attempt.attemptId}/`;
  const bodyPrefix = `email-bodies/${attempt.ingressId}/${attempt.attemptId}/`;
  return (
    attempt.proof.attachments.every((object) =>
      object.r2Key.startsWith(attachmentPrefix)
    ) &&
    attempt.proof.bodyObjects.every((object) =>
      object.r2Key.startsWith(bodyPrefix)
    )
  );
}

function isRepairResolution(
  value: unknown,
): value is InboundDerivedContentRepairResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, REPAIR_RESOLUTION_KEYS) &&
    record.schemaVersion === INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION &&
    record.kind === "inbound_derived_content_repair_resolution" &&
    record.status === "resolved" &&
    (record.resolution === "owned" || record.resolution === "discarded") &&
    isInboundDerivedContentRepairAttempt(record.attempt)
  );
}

function resolutionMatchesAttempt(
  resolution: InboundDerivedContentRepairResolution,
  attempt: InboundDerivedContentRepairAttempt,
) {
  return (
    JSON.stringify(projectRepairAttempt(resolution.attempt)) ===
    JSON.stringify(projectRepairAttempt(attempt))
  );
}

export async function readRepairAttemptResolution(
  bucket: Pick<RepairAttemptLedgerBucket, "get">,
  ingressId: string,
  attemptId: string,
  commandFingerprint: string,
): Promise<"discarded" | "owned" | null> {
  const stored = await readJson(
    bucket,
    resolvedRepairAttemptKey(ingressId, attemptId),
  );
  if (!stored || !isRepairResolution(stored.value)) return null;
  return stored.value.attempt.ingressId === ingressId &&
    stored.value.attempt.attemptId === attemptId &&
    stored.value.attempt.commandFingerprint === commandFingerprint
    ? stored.value.resolution
    : null;
}

async function readJson(
  bucket: Pick<RepairAttemptLedgerBucket, "get">,
  key: string,
) {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return { object, value: JSON.parse(await object.text()) as unknown };
  } catch {
    return { object, value: null };
  }
}

export async function persistPendingRepairAttempt(
  bucket: Pick<RepairAttemptLedgerBucket, "get" | "put">,
  attempt: InboundDerivedContentRepairAttempt,
): Promise<boolean> {
  if (!isInboundDerivedContentRepairAttempt(attempt)) return false;
  const projectedAttempt = projectRepairAttempt(attempt);
  const serialized = JSON.stringify(projectedAttempt);
  const key = pendingRepairAttemptKey(attempt.ingressId, attempt.attemptId);
  try {
    await bucket.put(key, serialized, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        attemptId: attempt.attemptId,
        ingressId: attempt.ingressId,
        mailboxId: attempt.mailboxId,
        status: "pending",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    // A failed response can still hide a committed R2 write. The exact read below
    // is the authority for whether the pending intent became durable.
  }
  try {
    const stored = await readJson(bucket, key);
    return Boolean(
      stored &&
        isInboundDerivedContentRepairAttempt(stored.value) &&
        JSON.stringify(stored.value) === serialized,
    );
  } catch {
    return false;
  }
}

export async function resolveRepairAttempt(
  bucket: Pick<RepairAttemptLedgerBucket, "get" | "put">,
  attempt: InboundDerivedContentRepairAttempt,
  resolution: "discarded" | "owned",
): Promise<boolean> {
  if (!isInboundDerivedContentRepairAttempt(attempt)) return false;
  const key = resolvedRepairAttemptKey(attempt.ingressId, attempt.attemptId);
  const value = projectRepairResolution({
    schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
    kind: "inbound_derived_content_repair_resolution",
    status: "resolved",
    resolution,
    attempt: projectRepairAttempt(attempt),
  });
  let written: unknown | null = null;
  try {
    written = await bucket.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        attemptId: attempt.attemptId,
        ingressId: attempt.ingressId,
        resolution,
        status: "resolved",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    // A failed R2 response can still hide a committed write. The immutable
    // object itself is authoritative, but only if its complete JSON is exact.
  }
  if (written) return true;
  try {
    const existing = await readJson(bucket, key);
    return Boolean(
      existing &&
        isRepairResolution(existing.value) &&
        resolutionMatchesAttempt(existing.value, attempt) &&
        JSON.stringify(existing.value) === JSON.stringify(value),
    );
  } catch {
    return false;
  }
}

async function readCursor(bucket: RepairAttemptLedgerBucket) {
  const cursor = await readJson(bucket, CURSOR_KEY);
  const value = cursor?.value;
  return {
    ...(value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).cursor === "string"
      ? { cursor: (value as Record<string, unknown>).cursor as string }
      : {}),
    ...(cursor?.object.etag ? { etag: cursor.object.etag } : {}),
  };
}

async function enqueueDiscardedAttemptCleanup(
  mailbox: ReturnType<RepairAttemptReconciliationEnvironment["MAILBOX"]["get"]>,
  attempt: InboundDerivedContentRepairAttempt,
): Promise<boolean> {
  const objects: InboundDerivedContentCleanupCandidate[] = [
    ...attempt.proof.attachments,
    ...attempt.proof.bodyObjects,
  ];
  if (objects.length === 0) return true;
  if (!mailbox.enqueueUnownedInboundDerivedContentCleanup) return false;
  const result = await mailbox.enqueueUnownedInboundDerivedContentCleanup({
    emailId: attempt.ingressId,
    projectionAttemptId: attempt.attemptId,
    objects,
  });
  return (
    Number.isSafeInteger(result.queued) &&
    result.queued >= 0 &&
    Number.isSafeInteger(result.retained) &&
    result.retained >= 0 &&
    Number.isSafeInteger(result.absent) &&
    result.absent >= 0 &&
    result.queued + result.retained + result.absent === objects.length
  );
}

export async function reconcilePendingInboundRepairAttempts(
  env: RepairAttemptReconciliationEnvironment,
  runtime: { now(): Date } = { now: () => new Date() },
) {
  const cursorState = await readCursor(env.RAW_MAIL_BUCKET);
  const page = await env.RAW_MAIL_BUCKET.list({
    prefix: PENDING_PREFIX,
    limit: INBOUND_REPAIR_ATTEMPT_BATCH_SIZE,
    ...(cursorState.cursor ? { cursor: cursorState.cursor } : {}),
  });
  let resolved = 0;
  for (const object of page.objects) {
    let pending;
    try {
      pending = await readJson(env.RAW_MAIL_BUCKET, object.key);
    } catch {
      continue;
    }
    if (!pending || !isInboundDerivedContentRepairAttempt(pending.value)) {
      continue;
    }
    const attempt = pending.value;
    if (object.key !== pendingRepairAttemptKey(attempt.ingressId, attempt.attemptId)) {
      continue;
    }
    try {
      const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(attempt.mailboxId));
      const existingResolution = await readJson(
        env.RAW_MAIL_BUCKET,
        resolvedRepairAttemptKey(attempt.ingressId, attempt.attemptId),
      );
      if (
        existingResolution &&
        isRepairResolution(existingResolution.value) &&
        resolutionMatchesAttempt(existingResolution.value, attempt)
      ) {
        if (existingResolution.value.resolution === "discarded") {
          if (!(await enqueueDiscardedAttemptCleanup(mailbox, attempt))) continue;
        }
        await env.RAW_MAIL_BUCKET.delete(object.key);
        resolved += 1;
        continue;
      }
      if (
        runtime.now().getTime() - Date.parse(attempt.createdAt) <
        INBOUND_REPAIR_ATTEMPT_GRACE_MS
      ) continue;
      if (!mailbox.finalizeInboundDerivedContentRepairAttempt) continue;
      const terminal = await mailbox.finalizeInboundDerivedContentRepairAttempt({
        attemptId: attempt.attemptId,
        emailId: attempt.ingressId,
        expectedGeneration: attempt.expectedGeneration,
        markerId: attempt.markerId,
        commandFingerprint: attempt.commandFingerprint,
        proof: attempt.proof,
      });
      if (terminal.outcome === "committed") {
        if (
          !(await resolveRepairAttempt(
            env.RAW_MAIL_BUCKET,
            attempt,
            "owned",
          ))
        ) continue;
        await env.RAW_MAIL_BUCKET.delete(object.key);
        resolved += 1;
        continue;
      }
      if (
        terminal.outcome !== "abandoned" &&
        terminal.outcome !== "rejected"
      ) continue;
      if (
        !(await resolveRepairAttempt(
          env.RAW_MAIL_BUCKET,
          attempt,
          "discarded",
        ))
      ) continue;
      if (!(await enqueueDiscardedAttemptCleanup(mailbox, attempt))) continue;
      await env.RAW_MAIL_BUCKET.delete(object.key);
      resolved += 1;
    } catch {
      const [attemptRef, ingressRef] = await Promise.all([
        mailTelemetryLogRef("attempt", attempt.attemptId),
        mailTelemetryLogRef("ingress", attempt.ingressId),
      ]);
      console.error("[mail-reconciliation] repair attempt remains pending", {
        attemptRef,
        errorCode: "INBOUND_REPAIR_ATTEMPT_RECONCILIATION_FAILED",
        ingressRef,
        operation: "repair_attempt_reconcile",
        status: "pending",
      });
    }
  }
  if (page.truncated && !page.cursor) {
    throw new Error("R2 returned a truncated repair-attempt page without a cursor");
  }
  await env.RAW_MAIL_BUCKET.put(
    CURSOR_KEY,
    JSON.stringify({
      cursor: page.truncated ? page.cursor : null,
      updatedAt: runtime.now().toISOString(),
    }),
    {
      onlyIf: cursorState.etag
        ? { etagMatches: cursorState.etag }
        : { etagDoesNotMatch: "*" },
    },
  );
  return { scanned: page.objects.length, resolved };
}
