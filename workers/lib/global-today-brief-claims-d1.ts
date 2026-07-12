import type { Env } from "../types.ts";
import { resolveAiCostControlConfig } from "./ai-cost-control.ts";

export type GlobalTodayBriefClaim = {
	cacheKey: string;
	cacheScope: string;
	ownerUserId: string;
	claimToken: string;
	expiresAt: number;
};

function validateClaim(input: GlobalTodayBriefClaim, now: number) {
	if (
		input.cacheKey.length < 20 || input.cacheKey.length > 300 ||
		input.cacheScope.length < 1 || input.cacheScope.length > 1_000 ||
		input.ownerUserId.length < 1 || input.ownerUserId.length > 200 ||
		input.claimToken.length < 16 || input.claimToken.length > 200 ||
		!Number.isSafeInteger(input.expiresAt) ||
		input.expiresAt <= now || input.expiresAt > now + 5 * 60 * 1_000
	) {
		throw new Error("Global Today brief generation claim is invalid");
	}
}

export function globalTodayBriefClaimStore(env: Pick<Env, "DB"> & Partial<Env>) {
	const environment = resolveAiCostControlConfig(env).environment;
	return {
		async claim(input: GlobalTodayBriefClaim, now = Date.now()) {
			validateClaim(input, now);
			await env.DB.prepare(
				"DELETE FROM global_today_brief_generation_claims WHERE expires_at <= ?",
			).bind(now).run();
			const row = await env.DB.prepare(
				`INSERT INTO global_today_brief_generation_claims (
				   environment, cache_key, cache_scope, owner_user_id, claim_token,
				   expires_at, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(environment, cache_key, cache_scope) DO UPDATE SET
				   owner_user_id = excluded.owner_user_id,
				   claim_token = excluded.claim_token,
				   expires_at = excluded.expires_at,
				   updated_at = excluded.updated_at
				 WHERE global_today_brief_generation_claims.expires_at <= ?
				    OR (
				      global_today_brief_generation_claims.owner_user_id = excluded.owner_user_id
				      AND global_today_brief_generation_claims.claim_token = excluded.claim_token
				    )
				 RETURNING claim_token`,
			)
				.bind(
					environment,
					input.cacheKey,
					input.cacheScope,
					input.ownerUserId,
					input.claimToken,
					input.expiresAt,
					now,
					now,
					now,
				)
				.first<{ claim_token: string }>();
			return row?.claim_token === input.claimToken;
		},

		async owns(input: Omit<GlobalTodayBriefClaim, "expiresAt">, now = Date.now()) {
			const row = await env.DB.prepare(
				`SELECT claim_token
				 FROM global_today_brief_generation_claims
				 WHERE environment = ? AND cache_key = ? AND cache_scope = ?
				   AND owner_user_id = ? AND claim_token = ? AND expires_at > ?`,
			)
				.bind(environment, input.cacheKey, input.cacheScope, input.ownerUserId, input.claimToken, now)
				.first<{ claim_token: string }>();
			return row?.claim_token === input.claimToken;
		},

		async release(input: Omit<GlobalTodayBriefClaim, "expiresAt">) {
			const result = await env.DB.prepare(
				`DELETE FROM global_today_brief_generation_claims
				 WHERE environment = ? AND cache_key = ? AND cache_scope = ?
				   AND owner_user_id = ? AND claim_token = ?`,
			)
				.bind(environment, input.cacheKey, input.cacheScope, input.ownerUserId, input.claimToken)
				.run();
			return Number(result.meta.changes ?? 0) === 1;
		},
	};
}
