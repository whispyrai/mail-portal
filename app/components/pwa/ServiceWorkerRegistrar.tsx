// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";

/**
 * Registers the Web Push / PWA service worker once on mount (WISER-240).
 * Renders nothing. `updateViaCache: "none"` pairs with the SW's no-cache
 * header so a redeploy swaps the worker on the next load.
 */
export function ServiceWorkerRegistrar() {
	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
		navigator.serviceWorker
			.register("/sw.js", { scope: "/", updateViaCache: "none" })
			.catch((err) => console.error("[pwa] service worker registration failed", err));
	}, []);
	return null;
}
