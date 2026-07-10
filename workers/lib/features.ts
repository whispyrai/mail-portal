// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Per-brand feature gating (WISER-239). One shared codebase serves multiple
// brands; brand-specific modules are gated by the `FEATURES` env var. The only
// gated module today is the Whispyr rep-quiz (`workers/quiz`), off for Wiser.
//
// Resolution: an explicit `FEATURES` array (declared per env in wrangler.jsonc)
// is the source of truth; when it is unset the brand's baseline applies, so a
// missing var never strips the quiz from live Whispyr (byte-identical) and a
// Wiser env that forgets FEATURES still never leaks the Whispyr quiz.

import type { Brand } from "../routes/brand";

type Feature = "quiz";

// The brand-specific modules a brand ships when `FEATURES` is unset. Whispyr
// ships the rep-quiz; a neutral brand ships none.
const DEFAULT_FEATURES: Record<Brand, readonly Feature[]> = {
	whispyr: ["quiz"],
	wiser: [],
};

/**
 * Whether `feature` is enabled for a resolved brand. An explicit `FEATURES`
 * array (from the env) wins; when it is undefined the brand baseline applies.
 */
function isFeatureEnabled(
	features: readonly string[] | undefined,
	brand: Brand,
	feature: Feature,
): boolean {
	const active = features ?? DEFAULT_FEATURES[brand];
	return active.includes(feature);
}

/** Convenience for the one gated module — the rep-quiz surface. */
export function isQuizEnabled(
	features: readonly string[] | undefined,
	brand: Brand,
): boolean {
	return isFeatureEnabled(features, brand, "quiz");
}
