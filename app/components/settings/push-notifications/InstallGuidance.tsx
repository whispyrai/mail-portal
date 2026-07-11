// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { PwaInstallEnvironment } from "~/utils/pwa/detectPlatform";
import { Guidance } from "./Guidance";

type InstallGuidanceProps = {
	environment: PwaInstallEnvironment;
	installPromptAvailable: boolean;
	onInstall: () => void;
};

export function InstallGuidance({
	environment,
	installPromptAvailable,
	onInstall,
}: InstallGuidanceProps) {
	if (environment.browser === "in-app") {
		const browserName = environment.platform === "ios" ? "Safari" : "Chrome";
		return (
			<Guidance title={`Open in ${browserName} to continue`}>
				This in-app browser cannot install the mail app. Open this page in {browserName},
				then install it before enabling notifications.
			</Guidance>
		);
	}

	if (environment.platform === "ios") {
		if (!environment.isRecommendedMobileBrowser) {
			return (
				<Guidance title="Open in Safari to continue">
					On iPhone and iPad, notifications need the app installed from Safari.
					Open this page in Safari, then add it to your Home Screen.
				</Guidance>
			);
		}
			return (
				<Guidance title="Install to enable notifications">
					<ol className="mt-1 list-decimal space-y-1 pl-4">
						<li>
							Tap the Share button
							<ShareNetworkIcon
								size={14}
								aria-hidden="true"
								className="ms-1 inline-block align-text-bottom text-kumo-subtle"
							/>
						</li>
					<li>Choose &quot;Add to Home Screen&quot;</li>
					<li>Open the installed app, then return here to enable notifications</li>
				</ol>
			</Guidance>
		);
	}

	if (environment.platform === "android" && !environment.isRecommendedMobileBrowser) {
		return (
			<Guidance title="Open in Chrome to continue">
				On Android, install the app from Chrome before enabling notifications.
			</Guidance>
		);
	}

	if (installPromptAvailable) {
		return (
			<Button variant="primary" size="sm" onClick={onInstall}>
				Install app
			</Button>
		);
	}

	if (
		environment.platform === "android" ||
		environment.browser === "chrome" ||
		environment.browser === "edge"
	) {
		return (
			<Guidance title="Install to enable notifications">
				Open the browser menu and choose &quot;Install app&quot; or &quot;Add to Home
				screen&quot;. Then open the installed app and return here.
			</Guidance>
		);
	}

	return (
		<Guidance title="Open in Chrome or Edge to continue">
			Install this app from Chrome or Edge before enabling notifications.
		</Guidance>
	);
}
