import type { Env } from "../types.ts";
import type {
  CredentialRecoveryIssue,
  CredentialRecoveryStore,
} from "./credential-recovery.ts";

export function credentialRecoveryD1(env: Env): CredentialRecoveryStore {
  return {
    async issue(record: CredentialRecoveryIssue) {
      const recent = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM credential_recovery_tokens WHERE user_id = ? AND created_at > ?",
      )
        .bind(record.userId, record.createdAt - 15 * 60 * 1_000)
        .first<{ count: number }>();
      if ((recent?.count ?? 0) >= 3) {
        throw new Error(
          "Too many recovery links were requested. Try again in 15 minutes.",
        );
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE credential_recovery_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
        ).bind(record.createdAt, record.userId),
        env.DB.prepare(
          `INSERT INTO credential_recovery_tokens
					 (id, user_id, token_hash, expires_at, issued_by, purpose, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          record.id,
          record.userId,
          record.tokenHash,
          record.expiresAt,
          record.issuedBy ?? null,
          record.purpose,
          record.createdAt,
        ),
        env.DB.prepare(
          `INSERT INTO credential_recovery_audit
						 (id, user_id, event_type, actor_user_id, created_at)
						 VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          record.userId,
          record.purpose === "setup" ? "setup_issued" : "recovery_issued",
          record.issuedBy ?? null,
          record.createdAt,
        ),
      ]);
    },

    async consume(input) {
      const record = await env.DB.prepare(
        `SELECT t.id, t.user_id, t.purpose, u.email, u.ownership_confirmed_at
				 FROM credential_recovery_tokens t
				 JOIN users u ON u.id = t.user_id
				 WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ?`,
      )
        .bind(input.tokenHash, input.now)
        .first<{
          id: string;
          user_id: string;
          email: string;
          purpose: "setup" | "recovery";
          ownership_confirmed_at: number | null;
        }>();
      if (!record) return null;
      if (
        record.purpose === "setup" &&
        record.ownership_confirmed_at !== null
      ) {
        return null;
      }
      if (
        record.purpose === "recovery" &&
        record.ownership_confirmed_at === null
      ) {
        return null;
      }
      const nonce = crypto.randomUUID();
      const outcome =
        record.ownership_confirmed_at === null ? "claimed" : "recovered";
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE credential_recovery_tokens
					 SET consumed_at = ?, consumption_nonce = ?
					 WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
        ).bind(input.now, nonce, record.id, input.now),
        env.DB.prepare(
          `UPDATE users
					 SET password_hash = ?, password_salt = ?, mcp_token_hash = ?,
						     session_version = session_version + 1,
						     ownership_confirmed_at = COALESCE(ownership_confirmed_at, ?),
						     updated_at = ?
					 WHERE id = ? AND EXISTS (
					   SELECT 1 FROM credential_recovery_tokens
					   WHERE id = ? AND consumption_nonce = ?
					 )`,
        ).bind(
          input.passwordHash,
          input.passwordSalt,
          input.mcpTokenHash,
          input.now,
          input.now,
          record.user_id,
          record.id,
          nonce,
        ),
        env.DB.prepare(
          `INSERT INTO credential_recovery_audit
						 (id, user_id, event_type, actor_user_id, created_at)
						 SELECT ?, ?, ?, NULL, ?
						 WHERE EXISTS (
						   SELECT 1 FROM credential_recovery_tokens
						   WHERE id = ? AND consumption_nonce = ?
						 )`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          record.user_id,
          outcome === "claimed"
            ? "ownership_confirmed"
            : "credentials_recovered",
          input.now,
          record.id,
          nonce,
        ),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1
      ) {
        return null;
      }
      return { userId: record.user_id, loginEmail: record.email, outcome };
    },
  };
}
