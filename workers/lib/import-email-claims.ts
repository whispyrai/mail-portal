type SqlValue = string | number | null;

export interface ImportClaimSql {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

export type ImportEmailClaimResult =
	| { status: "claimed" }
	| { status: "existing"; id: string }
	| { status: "busy" };

export function claimImportedEmail(
	sql: ImportClaimSql,
	emailId: string,
	legacyId: string,
	token: string,
	now: number,
	expiresAt: number,
): ImportEmailClaimResult {
	const existing = [...sql.exec<{ id: string }>(
		`SELECT id FROM emails WHERE id IN (?, ?)
		 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
		emailId,
		legacyId,
		emailId,
	)][0];
	if (existing) {
		sql.exec(`DELETE FROM import_generation_claims WHERE message_id = ?`, emailId);
		return { status: "existing", id: existing.id };
	}

	sql.exec(
		`DELETE FROM import_generation_claims
		 WHERE message_id = ? AND expires_at <= ?`,
		emailId,
		now,
	);
	sql.exec(
		`INSERT OR IGNORE INTO import_generation_claims
		 (message_id, claim_token, expires_at, created_at)
		 VALUES (?, ?, ?, ?)`,
		emailId,
		token,
		expiresAt,
		now,
	);
	const claim = [...sql.exec<{ claim_token: string }>(
		`SELECT claim_token FROM import_generation_claims WHERE message_id = ? LIMIT 1`,
		emailId,
	)][0];
	return claim?.claim_token === token ? { status: "claimed" } : { status: "busy" };
}

export function releaseImportedEmailClaim(
	sql: ImportClaimSql,
	emailId: string,
	token: string,
): void {
	sql.exec(
		`DELETE FROM import_generation_claims WHERE message_id = ? AND claim_token = ?`,
		emailId,
		token,
	);
}

export function renewImportedEmailClaim(
	sql: ImportClaimSql,
	emailId: string,
	token: string,
	now: number,
	expiresAt: number,
): boolean {
	const current = [...sql.exec<{ claim_token: string; expires_at: number }>(
		`SELECT claim_token, expires_at FROM import_generation_claims
		 WHERE message_id = ? LIMIT 1`,
		emailId,
	)][0];
	if (
		!current ||
		current.claim_token !== token ||
		current.expires_at <= now
	) return false;
	sql.exec(
		`UPDATE import_generation_claims SET expires_at = ?
		 WHERE message_id = ? AND claim_token = ? AND expires_at > ?`,
		expiresAt,
		emailId,
		token,
		now,
	);
	return true;
}
