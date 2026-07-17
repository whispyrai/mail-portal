import {
  dispatchPreparedSesSend,
  prepareSesSend,
  type PreparedSesSend,
} from "../email-sender.ts";
import type { Env } from "../types.ts";
import type { SesObservedOutcome } from "./outbound-delivery-contract.ts";
import {
  CredentialRecoveryPayloadCorruptError,
  decryptCredentialRecoveryPayload,
  isRetryableCredentialRecoveryCryptoError,
  type EncryptedCredentialRecoveryPayload,
} from "./credential-recovery-crypto.ts";
import { CREDENTIAL_RECOVERY_CONTROL_ID } from "./credential-recovery-control.ts";
import { normalizeMailAddress } from "./mail-address.ts";
import { privacySafeErrorName } from "./privacy-safe-error.ts";
import { resolveBrand } from "../routes/brand.ts";

export const CREDENTIAL_RECOVERY_DELIVERY_LIMITS = {
  batchSize: 8,
  preflightLeaseMs: 30_000,
  providerTimeoutMs: 15_000,
  dispatchLeaseMs: 45_000,
  minimumValidityMs: 60_000,
  maxBackoffMs: 60 * 60_000,
} as const;

type DeliveryRow = {
  id: string;
  token_id: string;
  payload_key_version: number;
  payload_iv: string;
  payload_ciphertext: string;
  attempt_count: number;
  lease_token: string;
};

export type LeasedCredentialRecoveryDelivery = {
  id: string;
  tokenId: string;
  leaseToken: string;
  attemptCount: number;
  encrypted: EncryptedCredentialRecoveryPayload;
};

export type CredentialRecoveryDeliveryPayload = {
  to: string;
  loginEmail: string;
  recoveryUrl: string;
  expiresAt: number;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function leaseCredentialRecoveryDeliveries(
  env: Env,
  now = Date.now(),
  limit: number = CREDENTIAL_RECOVERY_DELIVERY_LIMITS.batchSize,
): Promise<LeasedCredentialRecoveryDelivery[]> {
  const candidates = await env.DB.prepare(
    `SELECT id FROM credential_recovery_delivery_outbox
     WHERE (state = 'pending' AND next_attempt_at <= ?)
        OR (state = 'leased' AND lease_expires_at <= ?)
     ORDER BY next_attempt_at ASC, created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, now, limit)
    .all<{ id: string }>();
  const deliveries: LeasedCredentialRecoveryDelivery[] = [];
  for (const candidate of candidates.results) {
    const leaseToken = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND (
         (state = 'pending' AND next_attempt_at <= ?)
         OR (state = 'leased' AND lease_expires_at <= ?)
       )`,
    )
      .bind(
        leaseToken,
        now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.preflightLeaseMs,
        now,
        candidate.id,
        now,
        now,
      )
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    const row = await env.DB.prepare(
      `SELECT id, token_id, payload_key_version, payload_iv,
              payload_ciphertext, attempt_count, lease_token
       FROM credential_recovery_delivery_outbox
       WHERE id = ? AND state = 'leased' AND lease_token = ?`,
    )
      .bind(candidate.id, leaseToken)
      .first<DeliveryRow>();
    if (!row) continue;
    deliveries.push({
      id: row.id,
      tokenId: row.token_id,
      leaseToken: row.lease_token,
      attemptCount: row.attempt_count,
      encrypted: {
        keyVersion: row.payload_key_version,
        iv: row.payload_iv,
        ciphertext: row.payload_ciphertext,
      },
    });
  }
  return deliveries;
}

async function finishLeasedDelivery(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "leaseToken">,
  state: "cancelled" | "expired" | "parked",
  errorCode: string,
  now: number,
): Promise<boolean> {
  const scrub = state !== "parked";
  const result = await env.DB.prepare(
    `UPDATE credential_recovery_delivery_outbox
     SET state = ?, lease_token = NULL, lease_expires_at = NULL,
         payload_key_version = CASE WHEN ? THEN NULL ELSE payload_key_version END,
         payload_iv = CASE WHEN ? THEN NULL ELSE payload_iv END,
         payload_ciphertext = CASE WHEN ? THEN NULL ELSE payload_ciphertext END,
         last_error_code = ?, completed_at = ?, updated_at = ?,
         cancellation_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancellation_reason END,
         cancellation_observed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancellation_observed_at END
     WHERE id = ? AND state = 'leased' AND lease_token = ?`,
  )
    .bind(
      state,
      scrub ? 1 : 0,
      scrub ? 1 : 0,
      scrub ? 1 : 0,
      errorCode,
      now,
      now,
      state,
      errorCode,
      state,
      now,
      delivery.id,
      delivery.leaseToken,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function preflightCredentialRecoveryDelivery(
  env: Env,
  delivery: LeasedCredentialRecoveryDelivery,
  now = Date.now(),
): Promise<"ready" | "terminal" | "lost"> {
  const token = await env.DB.prepare(
    `SELECT t.expires_at, t.consumed_at, t.purpose, u.is_active,
            u.ownership_confirmed_at, o.lease_expires_at
     FROM credential_recovery_delivery_outbox o
     JOIN credential_recovery_tokens t ON t.id = o.token_id
     JOIN users u ON u.id = t.user_id
     WHERE o.id = ? AND o.token_id = ? AND o.state = 'leased'
       AND o.lease_token = ?`,
  )
    .bind(delivery.id, delivery.tokenId, delivery.leaseToken)
    .first<{
      expires_at: number;
      consumed_at: number | null;
      purpose: "setup" | "recovery";
      is_active: number;
      ownership_confirmed_at: number | null;
      lease_expires_at: number;
    }>();
  if (!token || token.lease_expires_at <= now) return "lost";
  const eligible =
    token.is_active === 1 &&
    ((token.purpose === "setup" && token.ownership_confirmed_at === null) ||
      (token.purpose === "recovery" && token.ownership_confirmed_at !== null));
  if (token.consumed_at !== null || !eligible) {
    return (await finishLeasedDelivery(env, delivery, "cancelled", "TOKEN_INVALID", now))
      ? "terminal"
      : "lost";
  }
  if (
    token.expires_at <=
    now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.minimumValidityMs
  ) {
    return (await finishLeasedDelivery(env, delivery, "expired", "TOKEN_EXPIRED", now))
      ? "terminal"
      : "lost";
  }
  return "ready";
}

function isDeliveryPayload(
  value: unknown,
  canonicalOrigin: string,
): value is CredentialRecoveryDeliveryPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "expiresAt,loginEmail,recoveryUrl,to") {
    return false;
  }
  const candidate = value as Partial<CredentialRecoveryDeliveryPayload>;
  if (typeof candidate.to !== "string" || typeof candidate.loginEmail !== "string") {
    return false;
  }
  if (
    normalizeMailAddress(candidate.to) !== candidate.to ||
    normalizeMailAddress(candidate.loginEmail) !== candidate.loginEmail ||
    utf8Length(candidate.to) > 254 ||
    utf8Length(candidate.loginEmail) > 254 ||
    !Number.isSafeInteger(candidate.expiresAt)
  ) {
    return false;
  }
  if (
    typeof candidate.recoveryUrl !== "string" ||
    utf8Length(candidate.recoveryUrl) > 2_048
  ) {
    return false;
  }
  try {
    const url = new URL(candidate.recoveryUrl);
    return (
      url.origin === canonicalOrigin &&
      url.pathname === "/account/recover" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.searchParams.size === 1 &&
      url.searchParams.getAll("token").length === 1 &&
      Boolean(url.searchParams.get("token"))
    );
  } catch {
    return false;
  }
}

export async function decryptCredentialRecoveryDelivery(
  env: Env,
  delivery: LeasedCredentialRecoveryDelivery,
): Promise<CredentialRecoveryDeliveryPayload> {
  const payload = await decryptCredentialRecoveryPayload<unknown>(
    env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
    delivery.encrypted,
    { kind: "delivery", id: delivery.id },
  );
  const canonicalOrigin = resolveBrand(env.BRAND).mailOrigin;
  if (!isDeliveryPayload(payload, canonicalOrigin)) {
    throw new CredentialRecoveryPayloadCorruptError();
  }
  return payload;
}

type DispatchFenceResult = "dispatching" | "terminal" | "lost";

export async function fenceCredentialRecoveryDeliveryDispatch(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "tokenId" | "leaseToken">,
  payloadExpiresAt: number,
  now = Date.now(),
): Promise<DispatchFenceResult> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox AS o
       SET state = 'dispatching', dispatch_started_at = ?,
           lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND token_id = ? AND state = 'leased' AND lease_token = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM credential_recovery_control c
           WHERE c.control_id = ? AND c.enabled = 1
         )
         AND EXISTS (
           SELECT 1 FROM credential_recovery_tokens t
           JOIN users u ON u.id = t.user_id
           WHERE t.id = o.token_id AND t.consumed_at IS NULL
             AND t.expires_at = ? AND t.expires_at > ?
             AND u.is_active = 1
             AND ((t.purpose = 'setup' AND u.ownership_confirmed_at IS NULL)
               OR (t.purpose = 'recovery' AND u.ownership_confirmed_at IS NOT NULL))
         )`,
    ).bind(
      now,
      now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.dispatchLeaseMs,
      now,
      delivery.id,
      delivery.tokenId,
      delivery.leaseToken,
      now,
      CREDENTIAL_RECOVERY_CONTROL_ID,
      payloadExpiresAt,
      now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.minimumValidityMs,
    ),
    env.DB.prepare(
      `INSERT INTO credential_recovery_delivery_attempts
       (attempt_id, outbox_id, state, dispatch_started_at, created_at, updated_at)
       SELECT lease_token, id, 'dispatching', dispatch_started_at, ?, ?
       FROM credential_recovery_delivery_outbox
       WHERE id = ? AND state = 'dispatching' AND lease_token = ?
         AND dispatch_started_at = ?`,
    ).bind(now, now, delivery.id, delivery.leaseToken, now),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) === 1 &&
    (results[1]?.meta.changes ?? 0) === 1
  ) {
    return "dispatching";
  }

  const current = await env.DB.prepare(
    `SELECT o.state, o.lease_token, o.lease_expires_at, t.expires_at,
            t.consumed_at, t.purpose, u.is_active, u.ownership_confirmed_at
     FROM credential_recovery_delivery_outbox o
     LEFT JOIN credential_recovery_tokens t ON t.id = o.token_id
     LEFT JOIN users u ON u.id = t.user_id
     WHERE o.id = ?`,
  )
    .bind(delivery.id)
    .first<{
      state: string;
      lease_token: string | null;
      lease_expires_at: number | null;
      expires_at: number | null;
      consumed_at: number | null;
      purpose: "setup" | "recovery" | null;
      is_active: number | null;
      ownership_confirmed_at: number | null;
    }>();
  if (
    !current ||
    current.state !== "leased" ||
    current.lease_token !== delivery.leaseToken ||
    current.lease_expires_at === null ||
    current.lease_expires_at <= now
  ) {
    return "lost";
  }
  const eligible =
    current.is_active === 1 &&
    ((current.purpose === "setup" && current.ownership_confirmed_at === null) ||
      (current.purpose === "recovery" && current.ownership_confirmed_at !== null));
  const state =
    current.expires_at !== payloadExpiresAt
      ? "parked"
      : current.expires_at === null ||
          current.expires_at <=
            now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.minimumValidityMs
        ? "expired"
        : current.consumed_at !== null || !eligible
          ? "cancelled"
          : null;
  if (!state) return "lost";
  const settled = await finishLeasedDelivery(
    env,
    delivery,
    state,
    state === "parked" ? "PAYLOAD_EXPIRY_MISMATCH" : "TOKEN_INVALID_AT_FENCE",
    now,
  );
  return settled ? "terminal" : "lost";
}

export async function markCredentialRecoveryAccepted(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "leaseToken">,
  messageId: string,
  now = Date.now(),
): Promise<boolean> {
  const boundedMessageId = messageId.trim();
  if (!boundedMessageId || boundedMessageId.length > 255) return false;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET state = 'accepted', lease_token = NULL, lease_expires_at = NULL,
           payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
           provider_message_id = ?, accepted_attempt_id = ?, accepted_at = ?, completed_at = ?,
           updated_at = ?, last_error_code = NULL
       WHERE id = ? AND state = 'dispatching' AND lease_token = ?
         AND EXISTS (
           SELECT 1 FROM credential_recovery_delivery_attempts
           WHERE attempt_id = ? AND outbox_id = ? AND state = 'dispatching'
         )`,
    ).bind(
      boundedMessageId,
      delivery.leaseToken,
      now,
      now,
      now,
      delivery.id,
      delivery.leaseToken,
      delivery.leaseToken,
      delivery.id,
    ),
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_attempts
       SET state = 'accepted', provider_message_id = ?, resolved_at = ?, updated_at = ?
       WHERE attempt_id = ? AND outbox_id = ? AND state = 'dispatching'
         AND EXISTS (
           SELECT 1 FROM credential_recovery_delivery_outbox
           WHERE id = ? AND state = 'accepted'
         )`,
    ).bind(
      boundedMessageId,
      now,
      now,
      delivery.leaseToken,
      delivery.id,
      delivery.id,
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 1) {
    return true;
  }
  const accepted = await env.DB.prepare(
    `SELECT 1 AS found FROM credential_recovery_delivery_outbox o
     JOIN credential_recovery_delivery_attempts a
       ON a.outbox_id = o.id
     WHERE o.id = ? AND o.state = 'accepted' AND a.attempt_id = ?
       AND a.state = 'accepted' AND a.provider_message_id = ?`,
  )
    .bind(
      delivery.id,
      delivery.leaseToken,
      boundedMessageId,
    )
    .first<{ found: number }>();
  return Boolean(accepted);
}

type FailureState = "leased" | "dispatching";

async function settleCredentialRecoveryDeliveryFailure(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "leaseToken" | "attemptCount">,
  fromState: FailureState,
  errorCode: string,
  ambiguous: boolean,
  now: number,
  allowExpiredLease = false,
): Promise<boolean> {
  const current = await env.DB.prepare(
    `SELECT o.state, o.lease_token, o.lease_expires_at, t.expires_at,
            t.consumed_at, t.purpose, u.is_active, u.ownership_confirmed_at
     FROM credential_recovery_delivery_outbox o
     LEFT JOIN credential_recovery_tokens t ON t.id = o.token_id
     LEFT JOIN users u ON u.id = t.user_id
     WHERE o.id = ?`,
  )
    .bind(delivery.id)
    .first<{
      state: string;
      lease_token: string | null;
      lease_expires_at: number | null;
      expires_at: number | null;
      consumed_at: number | null;
      purpose: "setup" | "recovery" | null;
      is_active: number | null;
      ownership_confirmed_at: number | null;
    }>();
  if (
    !current ||
    current.state !== fromState ||
    current.lease_token !== delivery.leaseToken ||
    (!allowExpiredLease &&
      (current.lease_expires_at === null || current.lease_expires_at <= now))
  ) {
    return false;
  }
  const eligible =
    current.is_active === 1 &&
    ((current.purpose === "setup" && current.ownership_confirmed_at === null) ||
      (current.purpose === "recovery" && current.ownership_confirmed_at !== null));
  const retryable =
    current.consumed_at === null &&
    eligible &&
    current.expires_at !== null &&
    current.expires_at >
      now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.minimumValidityMs;
  const terminalState =
    current.expires_at === null ||
    current.expires_at <=
      now + CREDENTIAL_RECOVERY_DELIVERY_LIMITS.minimumValidityMs
      ? "expired"
      : "cancelled";
  const nextAttemptCount = delivery.attemptCount + 1;
  const delay = Math.min(
    CREDENTIAL_RECOVERY_DELIVERY_LIMITS.maxBackoffMs,
    30_000 * 2 ** Math.min(nextAttemptCount - 1, 7),
  );
  const statements = [
    ...(fromState === "dispatching"
      ? [
          env.DB.prepare(
            `UPDATE credential_recovery_delivery_attempts
             SET state = ?, resolved_at = ?, updated_at = ?
             WHERE attempt_id = ? AND outbox_id = ? AND state = 'dispatching'`,
          ).bind(
            ambiguous ? "ambiguous" : "http_rejected",
            now,
            now,
            delivery.leaseToken,
            delivery.id,
          ),
        ]
      : []),
    env.DB.prepare(
    `UPDATE credential_recovery_delivery_outbox
     SET state = ?, attempt_count = ?, next_attempt_at = ?,
         lease_token = NULL, lease_expires_at = NULL,
         payload_key_version = CASE WHEN ? THEN payload_key_version ELSE NULL END,
         payload_iv = CASE WHEN ? THEN payload_iv ELSE NULL END,
         payload_ciphertext = CASE WHEN ? THEN payload_ciphertext ELSE NULL END,
         completed_at = CASE WHEN ? THEN NULL ELSE ? END,
         updated_at = ?, last_error_code = ?,
         ambiguous_dispatch_count = ambiguous_dispatch_count + ?,
         last_ambiguity_at = CASE WHEN ? THEN ? ELSE last_ambiguity_at END,
         cancellation_reason = CASE
           WHEN ? THEN cancellation_reason
           WHEN ? = 'cancelled' THEN COALESCE(cancellation_reason, ?)
           ELSE cancellation_reason END,
         cancellation_observed_at = CASE
           WHEN ? THEN cancellation_observed_at
           WHEN ? = 'cancelled' THEN COALESCE(cancellation_observed_at, ?)
           ELSE cancellation_observed_at END
     WHERE id = ? AND state = ? AND lease_token = ?`,
    )
    .bind(
      retryable ? "pending" : terminalState,
      nextAttemptCount,
      retryable ? now + delay : now,
      retryable ? 1 : 0,
      retryable ? 1 : 0,
      retryable ? 1 : 0,
      retryable ? 1 : 0,
      now,
      now,
      errorCode,
      ambiguous ? 1 : 0,
      ambiguous ? 1 : 0,
      now,
      retryable ? 1 : 0,
      terminalState,
      errorCode,
      retryable ? 1 : 0,
      terminalState,
      now,
      delivery.id,
      fromState,
      delivery.leaseToken,
    )
  ];
  const results = await env.DB.batch(statements);
  const outboxResult = results[results.length - 1];
  return (
    (outboxResult?.meta.changes ?? 0) === 1 &&
    (fromState !== "dispatching" || (results[0]?.meta.changes ?? 0) === 1)
  );
}

export async function recoverExpiredCredentialRecoveryDispatches(
  env: Env,
  now = Date.now(),
  limit: number = CREDENTIAL_RECOVERY_DELIVERY_LIMITS.batchSize,
): Promise<number> {
  const expired = await env.DB.prepare(
    `SELECT id, lease_token, attempt_count
     FROM credential_recovery_delivery_outbox
     WHERE state = 'dispatching' AND lease_expires_at <= ?
     ORDER BY lease_expires_at ASC, id ASC LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ id: string; lease_token: string; attempt_count: number }>();
  let recovered = 0;
  for (const row of expired.results) {
    if (
      await settleCredentialRecoveryDeliveryFailure(
        env,
        { id: row.id, leaseToken: row.lease_token, attemptCount: row.attempt_count },
        "dispatching",
        "DISPATCH_LEASE_EXPIRED",
        true,
        now,
        true,
      )
    ) {
      recovered += 1;
    }
  }
  return recovered;
}

export async function retryCredentialRecoveryDelivery(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "leaseToken" | "attemptCount">,
  errorCode: string,
  now = Date.now(),
): Promise<boolean> {
  return settleCredentialRecoveryDeliveryFailure(
    env,
    delivery,
    "dispatching",
    errorCode,
    errorCode === "SES_TRANSPORT_AMBIGUOUS" ||
      errorCode === "SES_INVALID_SUCCESS_RESPONSE" ||
      errorCode === "DISPATCH_THROWN",
    now,
  );
}

export async function parkCredentialRecoveryDelivery(
  env: Env,
  delivery: Pick<LeasedCredentialRecoveryDelivery, "id" | "leaseToken">,
  errorCode: string,
  now = Date.now(),
): Promise<boolean> {
  return finishLeasedDelivery(env, delivery, "parked", errorCode, now);
}

type PreparedRecoverySend = { prepared: PreparedSesSend };

type DeliveryDrainDependencies = {
  now: () => number;
  lease: typeof leaseCredentialRecoveryDeliveries;
  recoverExpired?: typeof recoverExpiredCredentialRecoveryDispatches;
  preflight: typeof preflightCredentialRecoveryDelivery;
  decrypt: typeof decryptCredentialRecoveryDelivery;
  fence(
    env: Env,
    delivery: LeasedCredentialRecoveryDelivery,
    payloadExpiresAt: number,
    now: number,
  ): Promise<DispatchFenceResult | boolean>;
  prepare?(
    env: Env,
    delivery: LeasedCredentialRecoveryDelivery,
    payload: CredentialRecoveryDeliveryPayload,
  ): Promise<PreparedRecoverySend | SesObservedOutcome>;
  dispatch?(prepared: PreparedRecoverySend): Promise<SesObservedOutcome>;
  send?(
    env: Env,
    payload: CredentialRecoveryDeliveryPayload,
  ): Promise<SesObservedOutcome>;
  markDelivered: typeof markCredentialRecoveryAccepted;
  resolve?(
    env: Env,
    delivery: LeasedCredentialRecoveryDelivery,
    state: FailureState,
    errorCode: string,
    ambiguous: boolean,
    now: number,
  ): Promise<boolean>;
  retry: typeof retryCredentialRecoveryDelivery;
  park: typeof parkCredentialRecoveryDelivery;
};

function recoveryDeliveryErrorCode(outcome: SesObservedOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return "ACCEPTED";
    case "not_dispatched":
      return "SES_NOT_DISPATCHED";
    case "http_error":
      return `SES_HTTP_${outcome.status}`;
    case "transport_ambiguous":
      return "SES_TRANSPORT_AMBIGUOUS";
    case "invalid_success_response":
      return "SES_INVALID_SUCCESS_RESPONSE";
  }
}

export async function dispatchCredentialRecoveryPreparedSend(
  prepared: PreparedSesSend,
  timeoutMs: number = CREDENTIAL_RECOVERY_DELIVERY_LIMITS.providerTimeoutMs,
): Promise<SesObservedOutcome> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs >= CREDENTIAL_RECOVERY_DELIVERY_LIMITS.dispatchLeaseMs
  ) {
    throw new Error("Credential recovery provider timeout is outside its lease");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("credential recovery SES timeout"),
    timeoutMs,
  );
  try {
    return await dispatchPreparedSesSend(prepared, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

const productionDrainDependencies: DeliveryDrainDependencies = {
  now: Date.now,
  lease: leaseCredentialRecoveryDeliveries,
  recoverExpired: recoverExpiredCredentialRecoveryDispatches,
  preflight: preflightCredentialRecoveryDelivery,
  decrypt: decryptCredentialRecoveryDelivery,
  fence: fenceCredentialRecoveryDeliveryDispatch,
  async prepare(env, delivery, payload) {
    const brand = resolveBrand(env.BRAND);
    const preparation = await prepareSesSend(env, {
      to: payload.to,
      from: `no-reply@${brand.mailDomain}`,
      subject: "Set up or recover your mail portal access",
      text: [
        `A secure credential setup or recovery link was requested for ${payload.loginEmail}.`,
        "",
        payload.recoveryUrl,
        "",
        `This single-use link expires at ${new Date(payload.expiresAt).toISOString()} UTC.`,
        "If you did not expect this message, do not use the link.",
      ].join("\n"),
      credentialRecoveryTracking: {
        deliveryId: delivery.id,
        attemptId: delivery.leaseToken,
      },
    });
    return preparation.ok ? { prepared: preparation.prepared } : preparation.outcome;
  },
  dispatch: ({ prepared }) => dispatchCredentialRecoveryPreparedSend(prepared),
  markDelivered: markCredentialRecoveryAccepted,
  resolve: (env, delivery, state, errorCode, ambiguous, now) =>
    settleCredentialRecoveryDeliveryFailure(
      env,
      delivery,
      state,
      errorCode,
      ambiguous,
      now,
    ),
  retry: retryCredentialRecoveryDelivery,
  park: parkCredentialRecoveryDelivery,
};

function isPreparedRecoverySend(
  value: PreparedRecoverySend | SesObservedOutcome,
): value is PreparedRecoverySend {
  return "prepared" in value;
}

type DeliveryDrainItemResult = {
  acceptedCount: number;
  failedCount: number;
};

const settledDelivery: DeliveryDrainItemResult = {
  acceptedCount: 0,
  failedCount: 0,
};

const failedDelivery: DeliveryDrainItemResult = {
  acceptedCount: 0,
  failedCount: 1,
};

function logDeliveryTransition(
  level: "info" | "error",
  phase: string,
  outcome: string,
  details: {
    errorCode?: string;
    errorName?: string;
    ambiguous?: boolean;
  } = {},
): void {
  const event = {
    operation: "credential_recovery_delivery",
    phase,
    outcome,
    ...details,
  };
  if (level === "error") {
    console.error("[credential-recovery] delivery transition", event);
    return;
  }
  console.info("[credential-recovery] delivery transition", event);
}

async function drainCredentialRecoveryDelivery(
  env: Env,
  delivery: LeasedCredentialRecoveryDelivery,
  startedAt: number,
  dependencies: DeliveryDrainDependencies,
): Promise<DeliveryDrainItemResult> {
  let preflight: "ready" | "terminal" | "lost";
  try {
    preflight = await dependencies.preflight(env, delivery, startedAt);
  } catch (error) {
    logDeliveryTransition("error", "preflight", "failed", {
      errorName: privacySafeErrorName(error),
    });
    return failedDelivery;
  }
  if (preflight !== "ready") {
    logDeliveryTransition(
      preflight === "lost" ? "error" : "info",
      "preflight",
      preflight,
    );
    return preflight === "lost" ? failedDelivery : settledDelivery;
  }

  let payload: CredentialRecoveryDeliveryPayload;
  try {
    payload = await dependencies.decrypt(env, delivery);
  } catch (error) {
    if (isRetryableCredentialRecoveryCryptoError(error)) {
      try {
        const resolved = dependencies.resolve
          ? await dependencies.resolve(
              env,
              delivery,
              "leased",
              "PAYLOAD_KEY_UNAVAILABLE",
              false,
              dependencies.now(),
            )
          : false;
        logDeliveryTransition(
          resolved ? "info" : "error",
          "settlement",
          resolved ? "retry_scheduled" : "lost",
          {
            errorCode: "PAYLOAD_KEY_UNAVAILABLE",
            errorName: privacySafeErrorName(error),
          },
        );
        return resolved ? settledDelivery : failedDelivery;
      } catch (settlementError) {
        logDeliveryTransition("error", "settlement", "failed", {
          errorCode: "PAYLOAD_KEY_UNAVAILABLE",
          errorName: privacySafeErrorName(settlementError),
        });
        return failedDelivery;
      }
    }
    let parked = false;
    try {
      parked = await dependencies.park(
        env,
        delivery,
        "PAYLOAD_CORRUPT",
        dependencies.now(),
      );
    } catch (parkError) {
      logDeliveryTransition("error", "park", "failed", {
        errorCode: "PAYLOAD_CORRUPT",
        errorName: privacySafeErrorName(parkError),
      });
      return failedDelivery;
    }
    logDeliveryTransition(parked ? "info" : "error", "decrypt", parked ? "parked" : "lost", {
      errorCode: "PAYLOAD_CORRUPT",
      errorName: privacySafeErrorName(error),
    });
    return failedDelivery;
  }

  let prepared: PreparedRecoverySend | undefined;
  if (dependencies.prepare) {
    let preparation: PreparedRecoverySend | SesObservedOutcome;
    try {
      preparation = await dependencies.prepare(env, delivery, payload);
    } catch (error) {
      logDeliveryTransition("error", "prepare", "failed", {
        errorCode: "SES_NOT_DISPATCHED",
        errorName: privacySafeErrorName(error),
      });
      preparation = { kind: "not_dispatched" };
    }
    if (!isPreparedRecoverySend(preparation)) {
      const errorCode = recoveryDeliveryErrorCode(preparation);
      try {
        const resolved = dependencies.resolve
          ? await dependencies.resolve(
              env,
              delivery,
              "leased",
              errorCode,
              false,
              dependencies.now(),
            )
          : false;
        logDeliveryTransition(
          resolved ? "info" : "error",
          "settlement",
          resolved ? "retry_scheduled" : "lost",
          { errorCode },
        );
        return resolved ? settledDelivery : failedDelivery;
      } catch (error) {
        logDeliveryTransition("error", "settlement", "failed", {
          errorCode,
          errorName: privacySafeErrorName(error),
        });
        return failedDelivery;
      }
    }
    prepared = preparation;
  }

  let fence: DispatchFenceResult | boolean;
  try {
    fence = await dependencies.fence(
      env,
      delivery,
      payload.expiresAt,
      dependencies.now(),
    );
  } catch (error) {
    logDeliveryTransition("error", "fence", "failed", {
      errorName: privacySafeErrorName(error),
    });
    return failedDelivery;
  }
  if (fence !== true && fence !== "dispatching") {
    logDeliveryTransition(
      fence === "lost" || fence === false ? "error" : "info",
      "fence",
      fence === false ? "terminal" : fence,
    );
    return fence === "lost" ? failedDelivery : settledDelivery;
  }

  let outcome: SesObservedOutcome;
  try {
    if (prepared && dependencies.dispatch) {
      outcome = await dependencies.dispatch(prepared);
    } else if (dependencies.send) {
      outcome = await dependencies.send(env, payload);
    } else {
      outcome = { kind: "not_dispatched" };
    }
  } catch (error) {
    logDeliveryTransition("error", "dispatch", "ambiguous", {
      errorCode: "SES_TRANSPORT_AMBIGUOUS",
      errorName: privacySafeErrorName(error),
      ambiguous: true,
    });
    outcome = { kind: "transport_ambiguous" };
  }
  if (outcome.kind === "accepted") {
    try {
      if (
        await dependencies.markDelivered(
          env,
          delivery,
          outcome.messageId,
          dependencies.now(),
        )
      ) {
        logDeliveryTransition("info", "commit", "accepted");
        return { acceptedCount: 1, failedCount: 0 };
      }
      logDeliveryTransition("error", "commit", "lost");
      return failedDelivery;
    } catch (error) {
      logDeliveryTransition("error", "commit", "failed", {
        errorName: privacySafeErrorName(error),
      });
      return failedDelivery;
    }
  }

  const errorCode = recoveryDeliveryErrorCode(outcome);
  const ambiguous =
    outcome.kind === "transport_ambiguous" ||
    outcome.kind === "invalid_success_response";
  try {
    const resolved = dependencies.resolve
      ? await dependencies.resolve(
          env,
          delivery,
          "dispatching",
          errorCode,
          ambiguous,
          dependencies.now(),
        )
      : await dependencies.retry(
          env,
          delivery,
          errorCode,
          dependencies.now(),
        );
    logDeliveryTransition(
      resolved ? "info" : "error",
      "settlement",
      resolved ? "retry_scheduled" : "lost",
      {
        errorCode,
        ambiguous,
      },
    );
    return resolved ? settledDelivery : failedDelivery;
  } catch (error) {
    logDeliveryTransition("error", "settlement", "failed", {
      errorCode,
      errorName: privacySafeErrorName(error),
      ambiguous,
    });
    return failedDelivery;
  }
}

export async function drainCredentialRecoveryDeliveries(
  env: Env,
  dependencies: DeliveryDrainDependencies = productionDrainDependencies,
): Promise<{ acceptedCount: number; failedCount: number; hasMore: boolean }> {
  const startedAt = dependencies.now();
  let recoveredCount = 0;
  if (dependencies.recoverExpired) {
    recoveredCount = await dependencies.recoverExpired(
      env,
      startedAt,
      CREDENTIAL_RECOVERY_DELIVERY_LIMITS.batchSize,
    );
  }
  const deliveries = await dependencies.lease(
    env,
    startedAt,
    Math.max(0, CREDENTIAL_RECOVERY_DELIVERY_LIMITS.batchSize - recoveredCount),
  );
  const itemResults = await Promise.allSettled(
    deliveries.map((delivery) =>
      drainCredentialRecoveryDelivery(env, delivery, startedAt, dependencies),
    ),
  );
  for (const item of itemResults) {
    if (item.status === "rejected") {
      logDeliveryTransition("error", "worker", "failed", {
        errorName: privacySafeErrorName(item.reason),
      });
    }
  }
  const acceptedCount = itemResults.reduce(
    (count, item) =>
      count + (item.status === "fulfilled" ? item.value.acceptedCount : 0),
    0,
  );
  const failedCount = itemResults.reduce(
    (count, item) =>
      count + (item.status === "fulfilled" ? item.value.failedCount : 1),
    0,
  );
  const result = {
    acceptedCount,
    failedCount,
    hasMore:
      recoveredCount + deliveries.length ===
      CREDENTIAL_RECOVERY_DELIVERY_LIMITS.batchSize,
  };
  console.info("[credential-recovery] delivery drain complete", {
    operation: "credential_recovery_delivery_drain",
    leasedCount: deliveries.length,
    recoveredAmbiguousCount: recoveredCount,
    ...result,
  });
  return result;
}
