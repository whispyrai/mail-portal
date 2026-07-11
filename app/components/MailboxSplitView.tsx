// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ReactNode } from "react";
import EmailPanel from "~/components/EmailPanel";

interface MailboxSplitViewProps {
	selectedEmailId: string | null;
	children: ReactNode;
}

export default function MailboxSplitView({
	selectedEmailId,
	children,
}: MailboxSplitViewProps) {
	// Compose now lives in a centered modal (ComposeEmail), so the split view is
	// purely: email list on the left, the open thread on the right.
	const isPanelOpen = selectedEmailId !== null;

	return (
		<div className="flex h-full min-h-0 min-w-0 overflow-hidden">
			<section
				aria-label="Message list"
				className={`flex flex-col min-w-0 shrink-0 ${
					isPanelOpen
						? "hidden md:flex md:w-[380px] md:border-r md:border-kumo-line"
						: "w-full"
				}`}
			>
				{children}
			</section>
			{isPanelOpen && selectedEmailId && (
				<section
					aria-label="Conversation"
					className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden w-full md:w-auto"
				>
					<EmailPanel emailId={selectedEmailId} />
				</section>
			)}
		</div>
	);
}
