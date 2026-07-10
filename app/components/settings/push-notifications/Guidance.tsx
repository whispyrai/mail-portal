// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export function Guidance({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2.5">
			<div className="text-sm font-medium text-kumo-default">{title}</div>
			<div className="mt-0.5 text-xs text-kumo-subtle">{children}</div>
		</div>
	);
}
