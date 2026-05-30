// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env extends Cloudflare.Env {
	// AWS SES credentials for outbound mail (set via `wrangler secret put`).
	// AWS_REGION is a plain var in wrangler.jsonc and comes through Cloudflare.Env.
	AWS_ACCESS_KEY_ID: string;
	AWS_SECRET_ACCESS_KEY: string;
	// HMAC secret for signing session JWTs (set via `wrangler secret put`).
	JWT_SECRET: string;
	// Email allowed to self-provision the first ADMIN account on first login.
	ADMIN_BOOTSTRAP_EMAIL: string;
	// KV namespace backing the OAuth provider (grants, clients, tokens). Required by
	// @cloudflare/workers-oauth-provider. Created via `wrangler kv namespace create OAUTH_KV`.
	OAUTH_KV: KVNamespace;
	// Injected into the handler env at runtime by OAuthProvider — the helper API the
	// consent handler uses to parse / look up / complete authorization requests.
	OAUTH_PROVIDER: OAuthHelpers;
}
