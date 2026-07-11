import type { Env } from "../types.ts";

const WINDOW_MS = 15 * 60 * 1_000;
const ACCOUNT_MAX_REQUESTS = 3;
const IP_MAX_REQUESTS = 10;

async function opaqueKey(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function allowRecoveryRequest(
  env: Env,
  input: { email: string; ip: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const cutoff = now - WINDOW_MS;
  const [accountKey, ipKey] = await Promise.all([
    opaqueKey(env.JWT_SECRET, `recovery:account:${input.email}`),
    opaqueKey(env.JWT_SECRET, `recovery:ip:${input.ip || "unknown"}`),
  ]);
  const upsert = (key: string) =>
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
			     WHEN credential_recovery_request_limits.window_started_at <= ? THEN excluded.window_started_at
			     ELSE credential_recovery_request_limits.window_started_at
			   END,
			   updated_at = excluded.updated_at`,
    ).bind(key, now, now, cutoff, cutoff);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM credential_recovery_request_limits WHERE updated_at < ?",
    ).bind(now - 24 * 60 * 60 * 1_000),
    upsert(accountKey),
    upsert(ipKey),
  ]);
  const rows = await env.DB.prepare(
    `SELECT throttle_key, request_count
		 FROM credential_recovery_request_limits
		 WHERE throttle_key IN (?, ?)`,
  )
    .bind(accountKey, ipKey)
    .all<{ throttle_key: string; request_count: number }>();
  const counts = new Map(
    rows.results.map((row) => [row.throttle_key, row.request_count]),
  );
  return (
    (counts.get(accountKey) ?? ACCOUNT_MAX_REQUESTS + 1) <=
      ACCOUNT_MAX_REQUESTS &&
    (counts.get(ipKey) ?? IP_MAX_REQUESTS + 1) <= IP_MAX_REQUESTS
  );
}
