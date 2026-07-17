import type { Env } from "../types.ts";
import {
  CredentialRecoveryPayloadCorruptError,
  decryptCredentialRecoveryPayload,
  encryptCredentialRecoveryPayload,
  opaqueCredentialRecoveryRef,
  type EncryptedCredentialRecoveryPayload,
} from "./credential-recovery-crypto.ts";
import { normalizeMailAddress } from "./mail-address.ts";

export const CREDENTIAL_RECOVERY_JOB_LIMITS = {
  batchSize: 8,
  leaseMs: 60_000,
  maxAttempts: 12,
  maxAgeMs: 24 * 60 * 60 * 1_000,
  expiryBatchSize: 100,
  maxBackoffMs: 60 * 60_000,
} as const;

const RECOVERY_REQUEST_WINDOW_MS = 15 * 60 * 1_000;
const RECOVERY_ACCOUNT_MAX_REQUESTS = 3;
const RECOVERY_IP_MAX_REQUESTS = 10;
const MAX_EMAIL_BYTES = 254;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function canonicalCredentialRecoveryIp(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(candidate)) {
    return "unknown";
  }
  const canonicalIpv4 = (input: string): string | null => {
    const parts = input.split(".");
    if (
      parts.length !== 4 ||
      parts.some(
        (part) =>
          !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255,
      )
    ) {
      return null;
    }
    return parts.join(".");
  };
  if (!candidate.includes(":")) {
    return canonicalIpv4(candidate) ?? "unknown";
  }
  let ipv6 = candidate.toLowerCase();
  const embeddedIpv4 = ipv6.match(/(?:^|:)([0-9]+(?:\.[0-9]+){3})$/)?.[1];
  if (embeddedIpv4) {
    const canonical = canonicalIpv4(embeddedIpv4);
    if (!canonical) return "unknown";
    const octets = canonical.split(".").map(Number);
    ipv6 = `${ipv6.slice(0, -embeddedIpv4.length)}${(
      (octets[0]! << 8) |
      octets[1]!
    ).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  if ((ipv6.match(/::/g) ?? []).length > 1) return "unknown";
  const compressed = ipv6.includes("::");
  const [leftRaw, rightRaw = ""] = ipv6.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    (compressed ? left.length + right.length >= 8 : left.length !== 8)
  ) {
    return "unknown";
  }
  const hextets = compressed
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const normalized = hextets.map((part) => Number.parseInt(part, 16).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < normalized.length; start += 1) {
    if (normalized[start] !== "0") continue;
    let end = start;
    while (normalized[end] === "0") end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end - 1;
  }
  if (bestStart < 0) return normalized.join(":");
  const before = normalized.slice(0, bestStart).join(":");
  const after = normalized.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

type RequestJobRow = {
  id: string;
  payload_key_version: number;
  payload_iv: string;
  payload_ciphertext: string;
  attempt_count: number;
  lease_token: string;
  created_at: number;
};

export type LeasedCredentialRecoveryRequest = {
  id: string;
  leaseToken: string;
  attemptCount: number;
  createdAt: number;
  encrypted: EncryptedCredentialRecoveryPayload;
};

export async function enqueueCredentialRecoveryRequest(
  env: Env,
  input: { email: string; ip: string; now?: number },
): Promise<{ kind: "queued"; jobId: string } | { kind: "suppressed" }> {
  const email = normalizeMailAddress(input.email);
  if (!email || utf8Length(email) > MAX_EMAIL_BYTES) return { kind: "suppressed" };
  const now = input.now ?? Date.now();
  const id = `recovery_request_${crypto.randomUUID()}`;
  const [accountRef, ipRef, encrypted] = await Promise.all([
    opaqueCredentialRecoveryRef(
      env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
      "account",
      email,
    ),
    opaqueCredentialRecoveryRef(
      env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
      "ip",
      canonicalCredentialRecoveryIp(input.ip),
    ),
    encryptCredentialRecoveryPayload(
      env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
      { email },
      { kind: "request", id },
    ),
  ]);
  const cutoff = now - RECOVERY_REQUEST_WINDOW_MS;
  const upsertLimit = (key: string) =>
    env.DB.prepare(
      `INSERT INTO credential_recovery_request_limits
       (throttle_key, request_count, window_started_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(throttle_key) DO UPDATE SET
         request_count = CASE
           WHEN credential_recovery_request_limits.window_started_at <= ? THEN 1
           ELSE credential_recovery_request_limits.request_count + 1
         END,
         window_started_at = CASE
           WHEN credential_recovery_request_limits.window_started_at <= ?
             THEN excluded.window_started_at
           ELSE credential_recovery_request_limits.window_started_at
         END,
         updated_at = excluded.updated_at`,
    ).bind(key, now, now, cutoff, cutoff);
  const results = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM credential_recovery_request_limits WHERE updated_at < ?",
    ).bind(now - 24 * 60 * 60 * 1_000),
    upsertLimit(accountRef),
    upsertLimit(ipRef),
    env.DB.prepare(
      `INSERT INTO credential_recovery_request_jobs
       (id, account_ref, payload_key_version, payload_iv, payload_ciphertext,
        state, attempt_count, next_attempt_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
       WHERE COALESCE((
         SELECT request_count FROM credential_recovery_request_limits
         WHERE throttle_key = ?
       ), ?) <= ?
       AND COALESCE((
         SELECT request_count FROM credential_recovery_request_limits
         WHERE throttle_key = ?
       ), ?) <= ?`,
    ).bind(
      id,
      accountRef,
      encrypted.keyVersion,
      encrypted.iv,
      encrypted.ciphertext,
      now,
      now,
      now,
      accountRef,
      RECOVERY_ACCOUNT_MAX_REQUESTS + 1,
      RECOVERY_ACCOUNT_MAX_REQUESTS,
      ipRef,
      RECOVERY_IP_MAX_REQUESTS + 1,
      RECOVERY_IP_MAX_REQUESTS,
    ),
  ]);
  if ((results[3]?.meta.changes ?? 0) !== 1) return { kind: "suppressed" };
  return { kind: "queued", jobId: id };
}

export async function leaseCredentialRecoveryRequestJobs(
  env: Env,
  now = Date.now(),
): Promise<LeasedCredentialRecoveryRequest[]> {
  const candidates = await env.DB.prepare(
    `SELECT id FROM credential_recovery_request_jobs
     WHERE created_at > ? AND (
       (state = 'pending' AND next_attempt_at <= ?)
        OR (state = 'leased' AND lease_expires_at <= ?)
     )
     ORDER BY next_attempt_at ASC, created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(
      now - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
      now,
      now,
      CREDENTIAL_RECOVERY_JOB_LIMITS.batchSize,
    )
    .all<{ id: string }>();
  const leased: LeasedCredentialRecoveryRequest[] = [];
  for (const candidate of candidates.results) {
    const leaseToken = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      `UPDATE credential_recovery_request_jobs
       SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND created_at > ? AND (
         (state = 'pending' AND next_attempt_at <= ?)
         OR (state = 'leased' AND lease_expires_at <= ?)
       )`,
    )
      .bind(
        leaseToken,
        now + CREDENTIAL_RECOVERY_JOB_LIMITS.leaseMs,
        now,
        candidate.id,
        now - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
        now,
        now,
      )
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    const row = await env.DB.prepare(
      `SELECT id, payload_key_version, payload_iv, payload_ciphertext,
              attempt_count, lease_token, created_at
       FROM credential_recovery_request_jobs
       WHERE id = ? AND state = 'leased' AND lease_token = ?`,
    )
      .bind(candidate.id, leaseToken)
      .first<RequestJobRow>();
    if (!row) continue;
    leased.push({
      id: row.id,
      leaseToken: row.lease_token,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      encrypted: {
        keyVersion: row.payload_key_version,
        iv: row.payload_iv,
        ciphertext: row.payload_ciphertext,
      },
    });
  }
  return leased;
}

export async function decryptCredentialRecoveryRequest(
  env: Env,
  job: LeasedCredentialRecoveryRequest,
): Promise<{ email: string }> {
  const payload = await decryptCredentialRecoveryPayload<unknown>(
    env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
    job.encrypted,
    { kind: "request", id: job.id },
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CredentialRecoveryPayloadCorruptError();
  }
  const keys = Object.keys(payload);
  const email = (payload as { email?: unknown }).email;
  if (
    keys.length !== 1 ||
    keys[0] !== "email" ||
    typeof email !== "string" ||
    normalizeMailAddress(email) !== email ||
    utf8Length(email) > MAX_EMAIL_BYTES
  ) {
    throw new CredentialRecoveryPayloadCorruptError();
  }
  return { email };
}

export async function completeCredentialRecoveryRequest(
  env: Env,
  job: Pick<LeasedCredentialRecoveryRequest, "id" | "leaseToken">,
  state: "suppressed" | "expired" | "parked",
  errorCode: string | null,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE credential_recovery_request_jobs
     SET state = ?, lease_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?, last_error_code = ?,
         payload_key_version = CASE WHEN ? = 'parked' THEN payload_key_version ELSE NULL END,
         payload_iv = CASE WHEN ? = 'parked' THEN payload_iv ELSE NULL END,
         payload_ciphertext = CASE WHEN ? = 'parked' THEN payload_ciphertext ELSE NULL END
     WHERE id = ? AND state = 'leased' AND lease_token = ?`,
  )
    .bind(
      state,
      now,
      now,
      errorCode,
      state,
      state,
      state,
      job.id,
      job.leaseToken,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function retryCredentialRecoveryRequest(
  env: Env,
  job: Pick<
    LeasedCredentialRecoveryRequest,
    "id" | "leaseToken" | "attemptCount" | "createdAt"
  >,
  errorCode: string,
  now = Date.now(),
): Promise<"retried" | "expired" | "parked" | "lost"> {
  const attemptCount = job.attemptCount + 1;
  const expired = job.createdAt <= now - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs;
  const exhausted = attemptCount >= CREDENTIAL_RECOVERY_JOB_LIMITS.maxAttempts;
  const delay = Math.min(
    CREDENTIAL_RECOVERY_JOB_LIMITS.maxBackoffMs,
    30_000 * 2 ** Math.min(attemptCount - 1, 7),
  );
  const result = await env.DB.prepare(
    `UPDATE credential_recovery_request_jobs
     SET state = ?, attempt_count = ?, next_attempt_at = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
         completed_at = CASE WHEN ? THEN ? ELSE NULL END,
         payload_key_version = CASE WHEN ? THEN NULL ELSE payload_key_version END,
         payload_iv = CASE WHEN ? THEN NULL ELSE payload_iv END,
         payload_ciphertext = CASE WHEN ? THEN NULL ELSE payload_ciphertext END,
         last_error_code = ?
     WHERE id = ? AND state = 'leased' AND lease_token = ?`,
  )
    .bind(
      expired ? "expired" : exhausted ? "parked" : "pending",
      attemptCount,
      expired || exhausted ? now : now + delay,
      now,
      expired || exhausted ? 1 : 0,
      now,
      expired ? 1 : 0,
      expired ? 1 : 0,
      expired ? 1 : 0,
      expired
        ? "REQUEST_LIFETIME_EXPIRED"
        : exhausted
          ? `${errorCode}_EXHAUSTED`.slice(0, 64)
          : errorCode,
      job.id,
      job.leaseToken,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return "lost";
  return expired ? "expired" : exhausted ? "parked" : "retried";
}

export async function expireCredentialRecoveryRequestJobs(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE credential_recovery_request_jobs
     SET state = 'expired', lease_token = NULL, lease_expires_at = NULL,
         payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
         completed_at = ?, updated_at = ?, last_error_code = 'REQUEST_LIFETIME_EXPIRED'
     WHERE id IN (
       SELECT id FROM credential_recovery_request_jobs
       WHERE created_at <= ?
         AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?))
       ORDER BY created_at ASC, id ASC LIMIT ?
     )`,
  )
    .bind(
      now,
      now,
      now - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
      now,
      CREDENTIAL_RECOVERY_JOB_LIMITS.expiryBatchSize,
    )
    .run();
  return result.meta.changes ?? 0;
}
