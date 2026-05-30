// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Outlet, useParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { useMailNotifications } from "~/hooks/useMailNotifications";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	// New-mail toasts + unread tab-title counter, scoped to this mailbox.
	useMailNotifications(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		isAgentPanelOpen,
		toggleAgentPanel,
		hydrateAgentPanel,
		closePanel,
	} = useUIStore();

	// Load the persisted agent-panel preference once on the client.
	useEffect(() => {
		hydrateAgentPanel();
	}, [hydrateAgentPanel]);

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closePanel, closeSidebar]);

	return (
		<div className="flex h-screen overflow-hidden">
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-kumo-contrast/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			{/* Agent + MCP sidebar — inline collapsible rail on desktop, full-height
			    right drawer (with backdrop) on mobile / tablet. */}
			{isAgentPanelOpen ? (
				<>
					{/* Mobile/tablet backdrop */}
					<div
						className="fixed inset-0 z-30 bg-kumo-contrast/30 lg:hidden"
						onClick={toggleAgentPanel}
						onKeyDown={(e) => e.key === "Escape" && toggleAgentPanel()}
						role="button"
						tabIndex={-1}
						aria-label="Close AI assistant"
					/>
					<div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] shrink-0 flex-col border-l border-kumo-line bg-kumo-base overflow-hidden lg:static lg:z-0 lg:w-[360px] lg:max-w-none">
						<AgentSidebar />
					</div>
				</>
			) : (
				// Slim re-open rail so the assistant is always one click away (desktop).
				<div className="hidden lg:flex w-11 shrink-0 border-l border-kumo-line flex-col items-center bg-kumo-base pt-3">
					<Tooltip content="Open AI assistant" side="left" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<RobotIcon size={20} />}
							onClick={toggleAgentPanel}
							aria-label="Open AI assistant"
						/>
					</Tooltip>
				</div>
			)}

			<ComposeEmail />
		</div>
	);
}
