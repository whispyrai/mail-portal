import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CalendarCheckIcon,
	CommandIcon,
	EnvelopeSimpleIcon,
	SignOutIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { useBrand } from "~/hooks/useBrand";
import MailCommandPalette, { MAIL_COMMAND_PALETTE_OPEN_EVENT } from "~/components/MailCommandPalette";

const destinations = [
	{ to: "/today", label: "Today", icon: CalendarCheckIcon },
	{ to: "/mailboxes", label: "Mailboxes", icon: EnvelopeSimpleIcon },
] as const;

function signOut() {
	const form = document.createElement("form");
	form.method = "POST";
	form.action = "/logout";
	document.body.appendChild(form);
	form.submit();
}

function DestinationLinks({ mobile = false }: { mobile?: boolean }) {
	return destinations.map(({ to, label, icon: Icon }) => (
		<NavLink
			key={to}
			to={to}
			className={({ isActive }) => mobile
				? `flex min-h-11 flex-1 items-center justify-center gap-2 border-b-2 px-3 text-sm font-medium ${isActive ? "border-kumo-brand text-kumo-default" : "border-transparent text-kumo-subtle"}`
				: `flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium ${isActive ? "bg-kumo-fill text-kumo-default" : "text-kumo-strong hover:bg-kumo-tint"}`
			}
		>
			<Icon size={18} aria-hidden="true" />
			{label}
		</NavLink>
	));
}

export default function GlobalShell() {
	const { appName } = useBrand();
	const { data: me } = useQuery({
		queryKey: ["me"],
		queryFn: async () => {
			const response = await fetch("/api/v1/me", { credentials: "same-origin" });
			return response.ok ? response.json() as Promise<{ email: string; role: string }> : null;
		},
		staleTime: Infinity,
	});
	return (
		<div className="flex h-screen h-dvh min-w-0 overflow-hidden bg-kumo-base">
			<MailCommandPalette />
			<aside className="hidden w-60 shrink-0 flex-col border-r border-kumo-line bg-kumo-recessed md:flex">
				<div className="border-b border-kumo-line px-5 py-5">
					<p className="text-xs font-semibold uppercase tracking-[0.16em] text-kumo-subtle">{appName}</p>
					<p className="mt-1.5 text-lg font-semibold tracking-tight text-kumo-default">Mail command center</p>
				</div>
				<nav className="flex-1 space-y-1 px-3 py-4" aria-label="Global navigation">
					<DestinationLinks />
				</nav>
				<div className="border-t border-kumo-line px-4 py-4">
					<p className="truncate text-xs text-kumo-subtle" title={me?.email}>{me?.email ?? "Signed in"}</p>
					<Button variant="ghost" icon={<SignOutIcon size={17} />} onClick={signOut} className="mt-2 min-h-11 w-full justify-start">Sign out</Button>
				</div>
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex min-h-14 items-center justify-between border-b border-kumo-line bg-kumo-base px-4 md:px-6">
					<div className="md:hidden">
						<p className="text-sm font-semibold text-kumo-default">{appName}</p>
					</div>
					<p className="hidden text-sm text-kumo-subtle md:block">One calm view across your permitted Mailboxes</p>
					<div className="flex items-center gap-1">
						<Tooltip content="Commands (⌘K)" side="bottom" asChild>
							<Button variant="ghost" shape="square" icon={<CommandIcon size={19} />} aria-label="Open command palette" onClick={() => window.dispatchEvent(new Event(MAIL_COMMAND_PALETTE_OPEN_EVENT))} className="min-h-11 min-w-11" />
						</Tooltip>
						<Button variant="ghost" shape="square" icon={<SignOutIcon size={19} />} aria-label="Sign out" onClick={signOut} className="min-h-11 min-w-11 md:hidden" />
					</div>
				</header>
				<nav className="flex border-b border-kumo-line bg-kumo-base md:hidden" aria-label="Global navigation">
					<DestinationLinks mobile />
				</nav>
				<main className="min-h-0 flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
