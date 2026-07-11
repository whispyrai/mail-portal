// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantCopyFor } from "./assistant-copy.ts";

test("Wiser assistant copy is role-neutral", () => {
	const copy = assistantCopyFor("wiser", "Wiser");
	const allCopy = [copy.emptyState, copy.composePlaceholder, ...copy.suggestedPrompts].join(" ");
	assert.doesNotMatch(allCopy, /prospect|sales|realty|pricing|demo|\brep\b/i);
});

test("Whispyr assistant copy preserves its sales-specific guidance", () => {
	const copy = assistantCopyFor("whispyr", "Whispyr");
	assert.match(copy.emptyState, /prospects waiting on you/i);
	assert.match(copy.composePlaceholder, /ABC Realty/i);
	assert.match(copy.composePlaceholder, /pricing/i);
});
