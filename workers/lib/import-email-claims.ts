type SqlValue = string | number | null;

export interface ImportClaimSql {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Iterable<T>;
}

export type ImportEmailClaimResult =
  | { status: "claimed" }
  | { status: "existing"; id: string; folder: string; rawSha256?: string }
  | { status: "identity_conflict"; id: string }
  | { status: "busy" };

export type ImportIdentitySource = "message-id" | "raw-sha256";

export function claimImportedEmail(
  sql: ImportClaimSql,
  emailId: string,
  legacyId: string,
  token: string,
  now: number,
  expiresAt: number,
  identitySource: ImportIdentitySource = "message-id",
  rawSha256: string | null = null,
): ImportEmailClaimResult {
  const candidateIds = emailId === legacyId ? [emailId] : [emailId, legacyId];
  const sourceEvidence = new Map<string, string>();
  for (const candidateId of candidateIds) {
    const evidence = [
      ...sql.exec<{ raw_sha256: string }>(
        `SELECT raw_sha256 FROM import_source_identities
         WHERE email_id = ? LIMIT 1`,
        candidateId,
      ),
    ][0];
    if (evidence) sourceEvidence.set(candidateId, evidence.raw_sha256);
  }
  const conflictingEvidence = candidateIds.find((candidateId) => {
    const digest = sourceEvidence.get(candidateId);
    return digest !== undefined &&
      (identitySource !== "raw-sha256" || digest !== rawSha256);
  });
  if (conflictingEvidence) {
    return { status: "identity_conflict", id: conflictingEvidence };
  }

  const existing = [
    ...sql.exec<{ id: string; folder_id: string }>(
      `SELECT id, folder_id FROM emails WHERE id IN (?, ?)
		 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
      emailId,
      legacyId,
      emailId,
    ),
  ][0];
  if (
    existing &&
    identitySource === "raw-sha256" &&
    sourceEvidence.get(existing.id) !== rawSha256
  ) {
    return { status: "identity_conflict", id: existing.id };
  }

  const blocked = [
    ...sql.exec<{ found: number }>(
      `SELECT 1 AS found FROM import_promotion_intents
		 WHERE email_id = ? AND state = 'integrity_blocked' LIMIT 1`,
      emailId,
    ),
  ][0];
  if (blocked) return { status: "busy" };

  if (existing) {
    const currentClaim = [
      ...sql.exec<{ claim_token: string }>(
        `SELECT claim_token FROM import_generation_claims
		 WHERE message_id = ? LIMIT 1`,
        emailId,
      ),
    ][0];
    if (currentClaim) {
      sql.exec(
        `DELETE FROM import_promotion_intents
		 WHERE email_id = ? AND claim_token = ? AND state = 'staging'`,
        emailId,
        currentClaim.claim_token,
      );
    }
    sql.exec(
      `DELETE FROM import_generation_claims WHERE message_id = ?`,
      emailId,
    );
    return identitySource === "raw-sha256"
      ? {
          status: "existing",
          id: existing.id,
          folder: existing.folder_id,
          rawSha256: rawSha256!,
        }
      : { status: "existing", id: existing.id, folder: existing.folder_id };
  }

  const expired = [
    ...sql.exec<{ claim_token: string }>(
      `SELECT claim_token FROM import_generation_claims
		 WHERE message_id = ? AND expires_at <= ? LIMIT 1`,
      emailId,
      now,
    ),
  ][0];
  if (expired) {
    sql.exec(
      `UPDATE import_promotion_intents
			 SET state = 'abandoned_watching', lease_token = NULL,
			 lease_expires_at = NULL, next_reconcile_at = ?, updated_at = ?
			 WHERE email_id = ? AND claim_token = ?
			 AND state IN ('recorded', 'reconciling', 'abandoned_watching')`,
      now,
      now,
      emailId,
      expired.claim_token,
    );
    sql.exec(
      `DELETE FROM import_promotion_intents
			 WHERE email_id = ? AND claim_token = ? AND state = 'staging'`,
      emailId,
      expired.claim_token,
    );
  }
  sql.exec(
    `DELETE FROM import_generation_claims
		 WHERE message_id = ? AND expires_at <= ?
		 AND NOT EXISTS (
			SELECT 1 FROM import_promotion_intents
			WHERE email_id = ? AND state = 'integrity_blocked'
		 )`,
    emailId,
    now,
    emailId,
  );
  sql.exec(
    `INSERT OR IGNORE INTO import_generation_claims
		 (message_id, claim_token, expires_at, created_at,
		  legacy_id, identity_source, raw_sha256)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
    emailId,
    token,
    expiresAt,
    now,
	legacyId,
	identitySource,
	rawSha256,
  );
  const claim = [
    ...sql.exec<{ claim_token: string }>(
      `SELECT claim_token FROM import_generation_claims WHERE message_id = ? LIMIT 1`,
      emailId,
    ),
  ][0];
  if (claim?.claim_token !== token) return { status: "busy" };
  if (identitySource === "raw-sha256") {
    sql.exec(
      `INSERT OR IGNORE INTO import_source_identities
       (email_id, raw_sha256, created_at) VALUES (?, ?, ?)`,
      emailId,
      rawSha256,
      now,
    );
    const reserved = [
      ...sql.exec<{ raw_sha256: string }>(
        `SELECT raw_sha256 FROM import_source_identities
         WHERE email_id = ? LIMIT 1`,
        emailId,
      ),
    ][0];
    if (reserved?.raw_sha256 !== rawSha256) {
      throw new Error("Import source identity reservation conflicted");
    }
  }
  return { status: "claimed" };
}

export function releaseImportedEmailClaim(
  sql: ImportClaimSql,
  emailId: string,
  token: string,
): boolean {
  const protectedIntent = [
    ...sql.exec<{ found: number }>(
      `SELECT 1 AS found FROM import_promotion_intents
		 WHERE email_id = ? AND claim_token = ?
		 AND state IN ('recorded', 'reconciling', 'abandoned_watching', 'integrity_blocked')
		 LIMIT 1`,
      emailId,
      token,
    ),
  ][0];
  if (protectedIntent) return false;
  sql.exec(
    `DELETE FROM import_promotion_intents
	 WHERE email_id = ? AND claim_token = ? AND state = 'staging'`,
    emailId,
    token,
  );
  sql.exec(
    `DELETE FROM import_generation_claims WHERE message_id = ? AND claim_token = ?`,
    emailId,
    token,
  );
  return true;
}

export function renewImportedEmailClaim(
  sql: ImportClaimSql,
  emailId: string,
  token: string,
  now: number,
  expiresAt: number,
): boolean {
  const current = [
    ...sql.exec<{ claim_token: string; expires_at: number }>(
      `SELECT claim_token, expires_at FROM import_generation_claims
		 WHERE message_id = ? LIMIT 1`,
      emailId,
    ),
  ][0];
  if (!current || current.claim_token !== token || current.expires_at <= now)
    return false;
  sql.exec(
    `UPDATE import_generation_claims SET expires_at = ?
		 WHERE message_id = ? AND claim_token = ? AND expires_at > ?`,
    expiresAt,
    emailId,
    token,
    now,
  );
  sql.exec(
    `UPDATE import_promotion_intents SET next_reconcile_at = ?, updated_at = ?
		 WHERE email_id = ? AND claim_token = ?
		 AND state IN ('staging', 'recorded')`,
    expiresAt,
    now,
    emailId,
    token,
  );
  return true;
}
