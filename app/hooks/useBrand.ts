// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useRouteLoaderData } from "react-router";
import type { loader } from "~/root";

// Whispyr display bits used when the root loader data is absent — during the
// error boundary render, and as a defensive default. Same fail-safe brand as
// resolveBrand's server-side default (WISER-238). quizEnabled mirrors the
// whispyr baseline so the fallback never hides a live feature (WISER-239).
const FALLBACK = {
	brand: "whispyr",
	name: "Whispyr",
	appName: "Whispyr Mail",
	favicon: "/favicon.svg",
	appleTouchIcon: "/apple-touch-icon.png",
	legacyFavicon: "/favicon.ico",
	legacyFaviconType: "image/x-icon",
	legacyFaviconSizes: "48x48 32x32 16x16",
	quizEnabled: true,
	semanticSearchEnabled: false,
	themeColor: "#faf8f5",
} as const;

/** The active brand's display strings, SSR'd from BRAND via the root loader. */
export function useBrand() {
	return useRouteLoaderData<typeof loader>("root") ?? FALLBACK;
}
