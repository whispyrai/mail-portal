// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { CommandIcon, ExamIcon, GearSixIcon, ListIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, RobotIcon, ShieldCheckIcon, SignOutIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useBrand } from "~/hooks/useBrand";
import { MAIL_FOCUS_SEARCH_EVENT } from "~/components/MailKeyboardController";
import { MAIL_COMMAND_PALETTE_OPEN_EVENT } from "~/components/MailCommandPalette";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();
	const { quizEnabled } = useBrand();
	const [me, setMe] = useState<{ email: string; role: string } | null>(null);

	useEffect(() => {
		const focusSearch = () => {
			setIsSearchExpanded(true);
			requestAnimationFrame(() => {
				const input = document.querySelector<HTMLInputElement>(
					'input[aria-label="Search emails"]',
				);
				input?.focus();
			});
		};
		window.addEventListener(MAIL_FOCUS_SEARCH_EVENT, focusSearch);
		return () =>
			window.removeEventListener(MAIL_FOCUS_SEARCH_EVENT, focusSearch);
	}, []);

	// Identify the signed-in user to show the admin link + sign-out (see /api/v1/me).
	useEffect(() => {
		fetch("/api/v1/me", { credentials: "same-origin" })
			.then((r) => (r.ok ? (r.json() as Promise<{ email: string; role: string }>) : null))
			.then((data) => setMe(data))
			.catch(() => setMe(null));
	}, []);

	// /logout is a POST endpoint; submit a throwaway form to hit it.
	const signOut = () => {
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "/logout";
		document.body.appendChild(form);
		form.submit();
	};

	// Sync search input with URL query param so it stays populated
	const urlQuery = searchParams.get("q") || "";
	useEffect(() => {
		if (location.pathname.includes("/search") && urlQuery) {
			setSearchQuery(urlQuery);
		}
	}, [urlQuery, location.pathname]);

	const performSearch = () => {
		if (mailboxId && searchQuery.trim()) {
			const q = searchQuery.trim();
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
			setIsSearchExpanded(false);
		}
	};

	const clearSearch = () => {
		setSearchQuery("");
		if (location.pathname.includes("/search") && mailboxId) {
			navigate(`/mailbox/${mailboxId}/emails/inbox`);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			performSearch();
		}
		if (e.key === "Escape") {
			if (searchQuery) {
				clearSearch();
			} else {
				setIsSearchExpanded(false);
			}
		}
	};

	const isSettingsActive = location.pathname.includes("/settings");

	return (
		<header className="flex items-center gap-2 px-3 py-2.5 bg-kumo-base border-b border-kumo-line sticky top-0 z-10 md:px-5 md:gap-4">
			{/* Hamburger menu - mobile only */}
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ListIcon size={20} />}
				onClick={toggleSidebar}
				aria-label="Toggle sidebar"
				className="md:hidden shrink-0"
			/>

			{/* Search - full on desktop, collapsible on mobile */}
			<div
				className={`flex-1 max-w-lg transition-all flex items-center gap-1 ${
					isSearchExpanded ? "flex" : "hidden md:flex"
				}`}
			>
				<div className="flex-1 relative flex items-center">
					<Input
						className="w-full"
						aria-label="Search emails"
						placeholder="Search emails... (try from:name, is:unread, has:attachment)"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={clearSearch}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors"
							aria-label="Clear search"
						>
							<XIcon size={14} />
						</button>
					)}
				</div>
				<Tooltip content="Search" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<MagnifyingGlassIcon size={20} />}
						onClick={performSearch}
						aria-label="Search"
					/>
				</Tooltip>
			</div>

			{/* Search toggle button - mobile only, hidden when search is expanded */}
			{!isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<MagnifyingGlassIcon size={20} />}
					onClick={() => setIsSearchExpanded(true)}
					aria-label="Search"
					className="md:hidden shrink-0"
				/>
			)}

			<Tooltip content="Commands (⌘K)" side="bottom" asChild>
				<Button
					variant="ghost"
					size="sm"
					icon={<CommandIcon size={20} />}
					onClick={() => window.dispatchEvent(new Event(MAIL_COMMAND_PALETTE_OPEN_EVENT))}
					aria-label="Open command palette"
					className="min-h-11 shrink-0 px-2"
				>
					<span className="hidden lg:inline">Commands</span>
				</Button>
			</Tooltip>

			<div className="flex items-center gap-1 ml-auto shrink-0">
				<Tooltip content={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"} side="bottom" asChild>
					<Button
						variant={isAgentPanelOpen ? "secondary" : "ghost"}
						shape="square"
						icon={<RobotIcon size={20} />}
						onClick={toggleAgentPanel}
						aria-label="Toggle agent panel"
						className="shrink-0"
					/>
				</Tooltip>
				<Tooltip content="Settings" side="bottom" asChild>
					<Button
						variant={isSettingsActive ? "secondary" : "ghost"}
						shape="square"
						icon={<GearSixIcon size={20} />}
						onClick={() =>
							navigate(
								isSettingsActive
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							)
						}
						aria-label="Settings"
					/>
				</Tooltip>
				{/* Quizzes is a Whispyr-only module — hidden where FEATURES omits it, e.g.
				    Wiser (WISER-239). quizEnabled is SSR'd via the root loader so the
				    button never flashes on. The routes also 404 server-side. */}
				{quizEnabled && (
					<Tooltip content="Quizzes" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<ExamIcon size={20} />}
							onClick={() => {
								// Worker-rendered pages (outside the SPA) — full-page nav. Admins land on
								// the management console; everyone else on their quiz list.
								window.location.href = me?.role === "ADMIN" ? "/admin/quizzes" : "/quizzes";
							}}
							aria-label="Quizzes"
						/>
					</Tooltip>
				)}
				<Tooltip content="Bulk send" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<PaperPlaneTiltIcon size={20} />}
						onClick={() => {
							window.location.href = "/bulk";
						}}
						aria-label="Bulk send"
					/>
				</Tooltip>
				{me?.role === "ADMIN" && (
					<Tooltip content="Admin" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<ShieldCheckIcon size={20} />}
							onClick={() => {
								window.location.href = "/admin/users";
							}}
							aria-label="Admin"
						/>
					</Tooltip>
				)}
				<Tooltip content={me ? `Sign out (${me.email})` : "Sign out"} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<SignOutIcon size={20} />}
						onClick={signOut}
						aria-label="Sign out"
					/>
				</Tooltip>
			</div>
		</header>
	);
}
