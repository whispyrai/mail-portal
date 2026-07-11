// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { BellIcon } from "@phosphor-icons/react";

export function NotificationCard({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-4 flex items-center gap-2">
				<BellIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Notifications</span>
			</div>
			{children}
		</div>
	);
}
