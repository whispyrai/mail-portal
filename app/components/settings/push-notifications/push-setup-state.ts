// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type PushSetupState =
	| "loading"
	| "error"
	| "not_configured"
	| "install"
	| "blocked"
	| "unsupported"
	| "enable";

type PushSetupInput = {
	mounted: boolean;
	configLoading: boolean;
	hasQueryError: boolean;
	hasVapidKey: boolean;
	installed: boolean;
	pushSupported: boolean;
	permission: NotificationPermission;
};

export function derivePushSetupState(input: PushSetupInput): PushSetupState {
	if (!input.mounted || input.configLoading) return "loading";
	if (input.hasQueryError) return "error";
	if (!input.hasVapidKey) return "not_configured";
	if (!input.installed) return "install";
	if (input.permission === "denied") return "blocked";
	if (!input.pushSupported) return "unsupported";
	return "enable";
}
