import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";

export const IMPORT_PROMOTION_MAX_BYTES = 25 * 1024 * 1024;
export const IMPORT_PROMOTION_APPEND_LIMIT = 20;

const IMPORT_ID = /^[0-9a-f]{32}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type SqlValue = string | number | null;

export interface ImportPromotionSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Iterable<T>;
}

export type ImportPromotionObject = {
  ordinal: number;
  r2Key: string;
  byteLength: number;
};

export type ImportPromotionIdentity = {
  emailId: string;
  claimToken: string;
};

export type ImportPromotionAppendSnapshot = {
  recordedCount: number;
  rollingFingerprint: string;
};

type IntentRow = {
  object_count: number;
  total_byte_length: number;
  recorded_count: number;
  recorded_byte_length: number;
  state: string;
  proof_fingerprint: string | null;
  rolling_fingerprint: string;
  last_append_start: number | null;
  last_append_count: number | null;
};

function requireIdentity(identity: ImportPromotionIdentity): void {
  if (!IMPORT_ID.test(identity.emailId) || !UUID_V4.test(identity.claimToken)) {
    throw new Error("Import promotion identity is invalid");
  }
}

function requireFingerprint(value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error("Import promotion rolling fingerprint is invalid");
  }
}

function expectedPrefix(
  identity: ImportPromotionIdentity,
  ordinal: number,
): string {
  return `attachments/${identity.emailId}/${identity.emailId}-${identity.claimToken.replaceAll("-", "")}-${ordinal}/`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateImportPromotionObject(
  identity: ImportPromotionIdentity,
  object: ImportPromotionObject,
): ImportPromotionObject {
  requireIdentity(identity);
  if (!Number.isSafeInteger(object.ordinal) || object.ordinal < 0) {
    throw new Error("Import promotion ordinal is invalid");
  }
  if (
    !Number.isSafeInteger(object.byteLength) ||
    object.byteLength < 0 ||
    object.byteLength > IMPORT_PROMOTION_MAX_BYTES
  ) {
    throw new Error("Import promotion byte length is invalid");
  }
  const prefix = expectedPrefix(identity, object.ordinal);
  if (!object.r2Key.startsWith(prefix)) {
    throw new Error("Import promotion key is outside its claim namespace");
  }
  const filename = object.r2Key.slice(prefix.length);
  if (
    !filename ||
    filename.includes("/") ||
    safeAttachmentStorageFilename(filename, prefix) !== filename
  ) {
    throw new Error("Import promotion filename is not storage-safe");
  }
  return { ...object };
}

export async function importPromotionInitialFingerprint(
  identity: ImportPromotionIdentity,
): Promise<string> {
  requireIdentity(identity);
  return sha256Hex(
    JSON.stringify([
      "import-promotion-v2",
      identity.emailId,
      identity.claimToken,
    ]),
  );
}

/** Batch boundaries do not affect the commitment because every object advances it once. */
export async function advanceImportPromotionFingerprint(
  identity: ImportPromotionIdentity,
  previousFingerprint: string,
  objects: readonly ImportPromotionObject[],
): Promise<string> {
  requireIdentity(identity);
  requireFingerprint(previousFingerprint);
  let fingerprint = previousFingerprint;
  for (const rawObject of objects) {
    const object = validateImportPromotionObject(identity, rawObject);
    fingerprint = await sha256Hex(
      JSON.stringify([
        "import-promotion-v2-object",
        identity.emailId,
        identity.claimToken,
        fingerprint,
        object.ordinal,
        object.r2Key,
        object.byteLength,
      ]),
    );
  }
  return fingerprint;
}

export async function importPromotionFingerprint(
  identity: ImportPromotionIdentity,
  objects: readonly ImportPromotionObject[],
): Promise<string> {
  return advanceImportPromotionFingerprint(
    identity,
    await importPromotionInitialFingerprint(identity),
    objects,
  );
}

export function beginImportPromotionIntent(
  sql: ImportPromotionSql,
  identity: ImportPromotionIdentity,
  objectCount: number,
  totalByteLength: number,
  initialFingerprint: string,
  now: number,
): { status: "begun" | "replayed" } {
  requireIdentity(identity);
  requireFingerprint(initialFingerprint);
  if (!Number.isSafeInteger(objectCount) || objectCount < 0) {
    throw new Error("Import promotion object count is invalid");
  }
  if (
    !Number.isSafeInteger(totalByteLength) ||
    totalByteLength < 0 ||
    totalByteLength > IMPORT_PROMOTION_MAX_BYTES
  ) {
    throw new Error("Import promotion total byte length is invalid");
  }
  const claim = [
    ...sql.exec<{ expires_at: number }>(
      `SELECT expires_at FROM import_generation_claims
       WHERE message_id = ? AND claim_token = ? AND expires_at > ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
      now,
    ),
  ][0];
  if (!claim) throw new Error("Import promotion claim is not live");
  const existing = [
    ...sql.exec<IntentRow>(
      `SELECT object_count, total_byte_length, recorded_count,
       recorded_byte_length, state, proof_fingerprint, rolling_fingerprint,
       last_append_start, last_append_count
       FROM import_promotion_intents
       WHERE email_id = ? AND claim_token = ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
    ),
  ][0];
  if (existing) {
    if (
      existing.object_count !== objectCount ||
      existing.total_byte_length !== totalByteLength ||
      (existing.recorded_count === 0 &&
        existing.rolling_fingerprint !== initialFingerprint)
    ) {
      throw new Error(
        "Import promotion begin replay conflicts with durable intent",
      );
    }
    return { status: "replayed" };
  }
  sql.exec(
    `INSERT INTO import_promotion_intents (
       email_id, claim_token, object_count, total_byte_length,
       recorded_count, recorded_byte_length, rolling_fingerprint, state,
       writer_closed, claim_generation, reconciliation_cycle,
       validation_cursor, settlement_cursor, next_reconcile_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 0, ?, 'staging', 0, 0, 0, 0, 0, ?, ?, ?)`,
    identity.emailId,
    identity.claimToken,
    objectCount,
    totalByteLength,
    initialFingerprint,
    claim.expires_at,
    now,
    now,
  );
  return { status: "begun" };
}

export function readImportPromotionAppendSnapshot(
  sql: ImportPromotionSql,
  identity: ImportPromotionIdentity,
): ImportPromotionAppendSnapshot {
  requireIdentity(identity);
  const row = [
    ...sql.exec<{ recorded_count: number; rolling_fingerprint: string }>(
      `SELECT recorded_count, rolling_fingerprint
       FROM import_promotion_intents
       WHERE email_id = ? AND claim_token = ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
    ),
  ][0];
  if (!row) throw new Error("Import promotion intent was not begun");
  return {
    recordedCount: row.recorded_count,
    rollingFingerprint: row.rolling_fingerprint,
  };
}

export function appendImportPromotionIntent(
  sql: ImportPromotionSql,
  identity: ImportPromotionIdentity,
  objects: readonly ImportPromotionObject[],
  expectedSnapshot: ImportPromotionAppendSnapshot,
  nextRollingFingerprint: string,
  now: number,
): { status: "appended" | "replayed" } {
  requireFingerprint(expectedSnapshot.rollingFingerprint);
  requireFingerprint(nextRollingFingerprint);
  const claim = [
    ...sql.exec<{ found: number }>(
      `SELECT 1 AS found FROM import_generation_claims
       WHERE message_id = ? AND claim_token = ? AND expires_at > ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
      now,
    ),
  ][0];
  if (!claim) throw new Error("Import promotion claim is not live");
  if (objects.length === 0 || objects.length > IMPORT_PROMOTION_APPEND_LIMIT) {
    throw new Error("Import promotion append batch is invalid");
  }
  const normalized = objects.map((object) =>
    validateImportPromotionObject(identity, object),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index]!.ordinal !== normalized[index - 1]!.ordinal + 1) {
      throw new Error("Import promotion append batch is not contiguous");
    }
  }
  const intent = [
    ...sql.exec<IntentRow>(
      `SELECT object_count, total_byte_length, recorded_count,
       recorded_byte_length, state, proof_fingerprint, rolling_fingerprint,
       last_append_start, last_append_count
       FROM import_promotion_intents
       WHERE email_id = ? AND claim_token = ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
    ),
  ][0];
  if (!intent) throw new Error("Import promotion intent was not begun");
  const firstOrdinal = normalized[0]!.ordinal;
  const lastOrdinal = normalized.at(-1)!.ordinal;
  if (lastOrdinal >= intent.object_count) {
    throw new Error("Import promotion append exceeds declared object count");
  }

  if (lastOrdinal < intent.recorded_count) {
    if (
      intent.last_append_start !== firstOrdinal ||
      intent.last_append_count !== normalized.length ||
      lastOrdinal !== intent.recorded_count - 1
    ) {
      throw new Error("Import promotion append replay boundary conflicts");
    }
    for (const object of normalized) {
      const row = [
        ...sql.exec<{ r2_key: string; byte_length: number }>(
          `SELECT r2_key, byte_length FROM import_promotion_intent_objects
           WHERE email_id = ? AND claim_token = ? AND ordinal = ? LIMIT 1`,
          identity.emailId,
          identity.claimToken,
          object.ordinal,
        ),
      ][0];
      if (
        !row ||
        row.r2_key !== object.r2Key ||
        row.byte_length !== object.byteLength
      ) {
        throw new Error(
          "Import promotion append replay conflicts with durable intent",
        );
      }
    }
    return { status: "replayed" };
  }

  if (
    intent.state !== "staging" ||
    firstOrdinal !== intent.recorded_count ||
    intent.recorded_count !== expectedSnapshot.recordedCount ||
    intent.rolling_fingerprint !== expectedSnapshot.rollingFingerprint
  ) {
    throw new Error("Import promotion append order or generation conflicts");
  }
  const appendedBytes = normalized.reduce(
    (total, object) => total + object.byteLength,
    0,
  );
  if (intent.recorded_byte_length + appendedBytes > intent.total_byte_length) {
    throw new Error("Import promotion append exceeds declared byte length");
  }
  for (const object of normalized) {
    sql.exec(
      `INSERT INTO import_promotion_intent_objects
       (email_id, claim_token, ordinal, r2_key, byte_length, resolution)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      identity.emailId,
      identity.claimToken,
      object.ordinal,
      object.r2Key,
      object.byteLength,
    );
  }
  sql.exec(
    `UPDATE import_promotion_intents
     SET recorded_count = recorded_count + ?,
         recorded_byte_length = recorded_byte_length + ?,
         rolling_fingerprint = ?, last_append_start = ?,
         last_append_count = ?, updated_at = ?
     WHERE email_id = ? AND claim_token = ?`,
    normalized.length,
    appendedBytes,
    nextRollingFingerprint,
    firstOrdinal,
    normalized.length,
    now,
    identity.emailId,
    identity.claimToken,
  );
  return { status: "appended" };
}

export function sealImportPromotionIntent(
  sql: ImportPromotionSql,
  identity: ImportPromotionIdentity,
  now: number,
): { status: "sealed" | "replayed"; proofFingerprint: string } {
  const claim = [
    ...sql.exec<{ found: number }>(
      `SELECT 1 AS found FROM import_generation_claims
       WHERE message_id = ? AND claim_token = ? AND expires_at > ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
      now,
    ),
  ][0];
  if (!claim) throw new Error("Import promotion claim is not live");
  const intent = [
    ...sql.exec<IntentRow>(
      `SELECT object_count, total_byte_length, recorded_count,
       recorded_byte_length, state, proof_fingerprint, rolling_fingerprint,
       last_append_start, last_append_count
       FROM import_promotion_intents
       WHERE email_id = ? AND claim_token = ? LIMIT 1`,
      identity.emailId,
      identity.claimToken,
    ),
  ][0];
  if (!intent) throw new Error("Import promotion intent was not begun");
  if (intent.proof_fingerprint !== null) {
    if (intent.proof_fingerprint !== intent.rolling_fingerprint) {
      throw new Error("Import promotion seal replay conflicts with durable intent");
    }
    return {
      status: "replayed",
      proofFingerprint: intent.proof_fingerprint,
    };
  }
  if (
    intent.state !== "staging" ||
    intent.recorded_count !== intent.object_count ||
    intent.recorded_byte_length !== intent.total_byte_length
  ) {
    throw new Error("Import promotion intent is incomplete");
  }
  sql.exec(
    `UPDATE import_promotion_intents
     SET state = 'recorded', proof_fingerprint = rolling_fingerprint,
         reconciliation_phase = 'validation', reconciliation_cycle = 1,
         validation_cursor = 0, settlement_cursor = 0, updated_at = ?
     WHERE email_id = ? AND claim_token = ?`,
    now,
    identity.emailId,
    identity.claimToken,
  );
  return {
    status: "sealed",
    proofFingerprint: intent.rolling_fingerprint,
  };
}
