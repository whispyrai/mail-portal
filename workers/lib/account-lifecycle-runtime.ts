import type { Env } from "../types.ts";
import { generateMcpToken, hashPassword } from "./auth.ts";
import { createAccountLifecycle } from "./account-lifecycle.ts";
import { requireAgentConnectionReconciliation } from "./agent-connection-revocation-outbox.ts";

export function accountLifecycle(
  env: Env,
  reconcileAgent: (
    mailboxId: string,
    userId: string,
  ) => Promise<void> = (mailboxId, userId) =>
    requireAgentConnectionReconciliation(env, { mailboxId, userId }),
) {
  return createAccountLifecycle({
    generateReplacementPassword: () =>
      hashPassword(generateMcpToken(), env.JWT_SECRET),
    store: {
      async deactivate(input) {
        const mailboxRows = await env.DB.prepare(
          `SELECT DISTINCT m.address
					 FROM mailboxes m
					 LEFT JOIN mailbox_memberships mm ON mm.mailbox_id = m.id
					 WHERE m.owner_user_id = ? OR mm.user_id = ?`,
        )
          .bind(input.userId, input.userId)
          .all<{ address: string }>();
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE users
						 SET is_active = 0, password_hash = ?, password_salt = ?,
						     mcp_token_hash = NULL, session_version = session_version + 1,
						     updated_at = ?
						 WHERE id = ?`,
          ).bind(
            input.passwordHash,
            input.passwordSalt,
            input.at,
            input.userId,
          ),
          env.DB.prepare(
            "UPDATE mailboxes SET is_active = 0, updated_at = ? WHERE owner_user_id = ?",
          ).bind(input.at, input.userId),
          env.DB.prepare(
            "UPDATE credential_recovery_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
          ).bind(input.at, input.userId),
          env.DB.prepare(
            `INSERT INTO credential_recovery_audit
						 (id, user_id, event_type, actor_user_id, created_at)
						 SELECT ?, ?, 'account_deactivated', NULL, ?
						 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
          ).bind(
            `audit_${crypto.randomUUID()}`,
            input.userId,
            input.at,
            input.userId,
          ),
        ]);
        if ((results[0]?.meta.changes ?? 0) !== 1) {
          throw new Error("User was not found");
        }
        return { mailboxIds: mailboxRows.results.map((row) => row.address) };
      },
      async activate(userId) {
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?",
          ).bind(now, userId),
          env.DB.prepare(
            "UPDATE mailboxes SET is_active = 1, updated_at = ? WHERE owner_user_id = ?",
          ).bind(now, userId),
        ]);
      },
    },
    async purgePush(userId, mailboxId) {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
      await stub.removePushSubscriptionsForUser(userId);
    },
    async disconnectAgent(userId, mailboxId) {
      await reconcileAgent(mailboxId, userId);
    },
  });
}
