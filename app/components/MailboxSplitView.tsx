// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { lazy, Suspense, type ReactNode } from "react";
import LazyLoadBoundary from "~/components/LazyLoadBoundary";
import { useUIStore } from "~/hooks/useUIStore";

const EmailPanel = lazy(() => import("~/components/EmailPanel"));

function EmailPanelLoadingFallback({ onBack }: { onBack: () => void }) {
	return (
		<div className="animate-pulse p-5 space-y-4" role="status" aria-label="Opening conversation">
			<button
				type="button"
				className="min-h-11 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring md:hidden"
				onClick={onBack}
			>
				Back to messages
			</button>
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3">
				<div className="size-10 rounded-full bg-kumo-fill" />
				<div className="flex-1 space-y-2">
					<div className="h-3 w-40 rounded bg-kumo-fill" />
					<div className="h-2.5 w-24 rounded bg-kumo-fill" />
				</div>
			</div>
			<span className="sr-only">Opening conversation...</span>
		</div>
	);
}

function EmailPanelLoadError({ onBack }: { onBack: () => void }) {
	return (
		<div className="grid h-full place-items-center p-5" role="alert">
			<div className="max-w-sm text-center">
				<h2 className="font-semibold text-kumo-default">Conversation could not open</h2>
				<p className="mt-2 text-sm text-kumo-subtle">
					The message list is safe. Reload to try loading this conversation again.
				</p>
				<div className="mt-4 flex flex-wrap justify-center gap-2">
					<button
						type="button"
						className="min-h-11 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default"
						onClick={onBack}
					>
						Back to messages
					</button>
					<button
						type="button"
						className="min-h-11 rounded-md bg-kumo-brand px-3 text-sm font-medium text-kumo-inverse"
						onClick={() => window.location.reload()}
					>
						Reload mail
					</button>
				</div>
			</div>
		</div>
	);
}

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
	const { closePanel } = useUIStore();

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
					<LazyLoadBoundary
						fallback={<EmailPanelLoadError onBack={closePanel} />}
						resetKey={selectedEmailId}
					>
						<Suspense fallback={<EmailPanelLoadingFallback onBack={closePanel} />}>
							<EmailPanel emailId={selectedEmailId} />
						</Suspense>
					</LazyLoadBoundary>
				</section>
			)}
		</div>
	);
}
