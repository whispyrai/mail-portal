import type { Env } from "../types.ts";
import { privacySafeErrorName } from "./privacy-safe-error.ts";

export const CREDENTIAL_RECOVERY_CONTROL_ID = "global";

/**
 * Credential recovery is enabled only by the one exact D1 control row. Missing
 * schema during code-first rollout, missing rows, invalid values, and D1 errors
 * all freeze the feature without affecting unrelated Worker functionality.
 */
export async function isCredentialRecoveryEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT enabled
       FROM credential_recovery_control
       WHERE control_id = ?`,
    )
      .bind(CREDENTIAL_RECOVERY_CONTROL_ID)
      .first<{ enabled: unknown }>();
    return row?.enabled === 1;
  } catch (error) {
    console.warn("[credential-recovery] control unavailable", {
      operation: "credential_recovery_control_read",
      outcome: "disabled",
      errorName: privacySafeErrorName(error),
    });
    return false;
  }
}
