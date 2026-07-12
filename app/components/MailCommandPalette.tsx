import { Dialog } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
	buildMailPaletteCommands,
	filterMailPaletteCommands,
	shouldOpenMailCommandPalette,
	type MailPaletteCommand,
} from "~/lib/command-palette";
import { isMailShortcutProtectedTarget } from "~/lib/mail-keyboard";
import { useUIStore } from "~/hooks/useUIStore";
import { MAIL_COMMAND_EVENT } from "./MailKeyboardController";

export const MAIL_COMMAND_PALETTE_OPEN_EVENT = "mail-portal:open-command-palette";

export default function MailCommandPalette() {
	const { mailboxId, folder } = useParams<{ mailboxId: string; folder: string }>();
	const navigate = useNavigate();
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const listboxId = useId();
	const commands = useMemo(
		() => buildMailPaletteCommands({
			hasMailboxContext: Boolean(mailboxId),
			folderId: folder,
			hasSelectedMessage: Boolean(selectedEmailId),
		}),
		[folder, selectedEmailId],
	);
	const filteredCommands = useMemo(
		() => filterMailPaletteCommands(commands, query),
		[commands, query],
	);
	const activeCommand = filteredCommands[activeIndex];

	const changeOpen = (next: boolean) => {
		if (next) {
			previousFocusRef.current = document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
			setQuery("");
			setActiveIndex(0);
		}
		setOpen(next);
		if (!next) {
			requestAnimationFrame(() => previousFocusRef.current?.focus());
		}
	};

	useEffect(() => {
		const onOpenRequest = () => changeOpen(true);
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (!shouldOpenMailCommandPalette({
				key: event.key,
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				isComposing: event.isComposing,
				isTextEntry: isMailShortcutProtectedTarget(event.target),
			})) return;
			event.preventDefault();
			changeOpen(true);
		};
		window.addEventListener(MAIL_COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener(MAIL_COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	useEffect(() => {
		setActiveIndex(0);
	}, [query, commands]);

	const runCommand = (command: MailPaletteCommand) => {
		changeOpen(false);
		requestAnimationFrame(() => {
				if (command.action.kind === "folder") {
				if (mailboxId) {
					navigate(`/mailbox/${mailboxId}/emails/${command.action.folderId}`);
				}
					return;
				}
				if (command.action.kind === "destination") {
					navigate(command.action.to);
					return;
				}
				window.dispatchEvent(
				new CustomEvent(MAIL_COMMAND_EVENT, { detail: command.action.command }),
			);
		});
	};

	return (
		<Dialog.Root open={open} onOpenChange={changeOpen}>
			<Dialog
				size="lg"
				className="flex max-h-[min(680px,calc(100dvh-1rem))] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(680px,92vw)]"
			>
				<Dialog.Title className="sr-only">Command palette</Dialog.Title>
				<div className="flex min-h-14 items-center gap-3 border-b border-kumo-line px-4">
					<MagnifyingGlassIcon size={20} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
					<input
						autoFocus
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								if (filteredCommands.length > 0) {
									setActiveIndex((current) => Math.min(current + 1, filteredCommands.length - 1));
								}
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setActiveIndex((current) => Math.max(current - 1, 0));
							} else if (event.key === "Enter" && activeCommand) {
								event.preventDefault();
								runCommand(activeCommand);
							} else if (event.key === "Escape") {
								event.preventDefault();
								changeOpen(false);
							}
						}}
						placeholder="Type a command or destination…"
						className="min-h-12 min-w-0 flex-1 bg-transparent text-base text-kumo-default outline-none placeholder:text-kumo-subtle"
						role="combobox"
						aria-label="Search commands"
						aria-controls={listboxId}
						aria-expanded="true"
						aria-autocomplete="list"
						aria-activedescendant={activeCommand ? `${listboxId}-${activeCommand.id}` : undefined}
					/>
					<kbd className="hidden shrink-0 rounded border border-kumo-line bg-kumo-recessed px-2 py-1 text-xs font-medium text-kumo-subtle sm:block">
						Esc
					</kbd>
				</div>

				<div id={listboxId} role="listbox" aria-label="Available commands" className="min-h-0 flex-1 overflow-y-auto p-2">
					{filteredCommands.length === 0 ? (
						<p role="status" className="px-3 py-10 text-center text-sm text-kumo-subtle">
							No matching commands
						</p>
					) : (
						filteredCommands.map((command, index) => {
							const previous = filteredCommands[index - 1];
							return (
								<div key={command.id}>
									{previous?.group !== command.group && (
										<p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">
											{command.group}
										</p>
									)}
									<button
										id={`${listboxId}-${command.id}`}
										type="button"
										role="option"
										aria-selected={index === activeIndex}
										onMouseMove={() => setActiveIndex(index)}
										onClick={() => runCommand(command)}
										className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand ${
											index === activeIndex ? "bg-kumo-fill" : "hover:bg-kumo-tint"
										}`}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-semibold text-kumo-default">{command.title}</span>
											<span className="block truncate text-xs text-kumo-subtle">{command.description}</span>
										</span>
										{command.shortcut && (
											<kbd className="shrink-0 rounded border border-kumo-line bg-kumo-recessed px-2 py-1 text-[11px] font-semibold text-kumo-subtle">
												{command.shortcut}
											</kbd>
										)}
									</button>
								</div>
							);
						})
					)}
				</div>
				<p className="border-t border-kumo-line px-4 py-2 text-xs text-kumo-subtle">
					Use ↑ and ↓ to move, Enter to run. Destructive commands keep their existing confirmation.
				</p>
			</Dialog>
		</Dialog.Root>
	);
}
