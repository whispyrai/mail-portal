// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
	layout("routes/global.tsx", [
		index("routes/global-index.tsx"),
		route("today", "routes/global-today.tsx"),
		route("meaning", "routes/global-meaning.tsx"),
		route("mailboxes", "routes/home.tsx"),
	]),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("today", "routes/today.tsx"),
		route("people", "routes/people.tsx"),
		route("attachments", "routes/attachments.tsx"),
		route("automations", "routes/automations.tsx"),
		route("open/:emailId", "routes/open-message.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("settings", "routes/settings.tsx"),
		route("search", "routes/search-results.tsx"),
		route("views/:viewId", "routes/saved-view-results.tsx"),
	]),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
