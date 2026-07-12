// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePushSetupState } from "../push-setup-state.ts";

const ready = {
	mounted: true,
	configLoading: false,
	hasQueryError: false,
	hasVapidKey: true,
	installed: true,
	pushSupported: true,
	permission: "default",
} satisfies Parameters<typeof derivePushSetupState>[0];

test("push setup waits for hydration and deploy configuration", () => {
	assert.equal(derivePushSetupState({ ...ready, mounted: false }), "loading");
	assert.equal(derivePushSetupState({ ...ready, configLoading: true }), "loading");
	assert.equal(derivePushSetupState({ ...ready, hasQueryError: true }), "error");
	assert.equal(
		derivePushSetupState({ ...ready, hasVapidKey: false }),
		"not_configured",
	);
});

test("push setup requires installation before it offers notification permission", () => {
	assert.equal(derivePushSetupState({ ...ready, installed: false }), "install");
	assert.equal(derivePushSetupState(ready), "enable");
});

test("push setup explains blocked and unsupported installed states", () => {
	assert.equal(derivePushSetupState({ ...ready, permission: "denied" }), "blocked");
	assert.equal(derivePushSetupState({ ...ready, pushSupported: false }), "unsupported");
});
