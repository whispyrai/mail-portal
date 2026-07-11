import { Folders } from "../../shared/folders.ts";
import { isBatchTriageActionAllowed } from "../../shared/batch-triage.ts";
import type { MailCommand } from "./mail-keyboard.ts";

export type MailPaletteCommand = {
	id: string;
	title: string;
	description: string;
	group: "Actions" | "Navigate" | "Current conversation";
	keywords: string[];
	shortcut?: string;
	action:
		| { kind: "mail"; command: MailCommand }
		| { kind: "folder"; folderId: string };
};

export function buildMailPaletteCommands(context: {
	folderId?: string;
	hasSelectedMessage: boolean;
}): MailPaletteCommand[] {
	const commands: MailPaletteCommand[] = [
		{
			id: "compose",
			title: "Compose",
			description: "Write a new message",
			group: "Actions",
			keywords: ["new message", "email", "write"],
			shortcut: "C",
			action: { kind: "mail", command: "compose" },
		},
		{
			id: "search",
			title: "Search mail",
			description: "Focus the mailbox search field",
			group: "Actions",
			keywords: ["find", "query", "messages"],
			shortcut: "/",
			action: { kind: "mail", command: "focus-search" },
		},
		...([
			["inbox", "Inbox", "Received conversations", Folders.INBOX, "G I"],
			["sent", "Sent", "Messages accepted for delivery", Folders.SENT, "G S"],
			["drafts", "Drafts", "Messages waiting to be finished", Folders.DRAFT, "G D"],
			["archive-folder", "Archive", "Conversations kept outside the inbox", Folders.ARCHIVE, "G A"],
			["trash-folder", "Trash", "Messages moved to Trash", Folders.TRASH, undefined],
			["outbox", "Outbox", "Queued, scheduled, retrying, and uncertain mail", Folders.OUTBOX, undefined],
		] as const).map(([id, title, description, folderId, shortcut]) => ({
			id,
			title,
			description,
			group: "Navigate" as const,
			keywords: ["folder", title.toLowerCase(), ...(id === "outbox" ? ["queued"] : [])],
			...(shortcut ? { shortcut } : {}),
			action: { kind: "folder" as const, folderId },
		})),
		{
			id: "refresh",
			title: "Refresh",
			description: "Reload the current mailbox view",
			group: "Actions",
			keywords: ["reload", "sync", "update"],
			action: { kind: "mail", command: "refresh" },
		},
		{
			id: "shortcuts",
			title: "Keyboard shortcuts",
			description: "Show every mailbox keyboard shortcut",
			group: "Actions",
			keywords: ["help", "keys", "guide"],
			shortcut: "?",
			action: { kind: "mail", command: "show-shortcuts" },
		},
	];

	const folderId = context.folderId;
	if (!context.hasSelectedMessage || !folderId) return commands;
	if (isBatchTriageActionAllowed("mark_read", folderId)) {
		commands.push({
			id: "toggle-read",
			title: "Mark read / unread",
			description: "Toggle the current conversation's read state",
			group: "Current conversation",
			keywords: ["read", "unread", "seen"],
			shortcut: "U",
			action: { kind: "mail", command: "toggle-unread" },
		});
	}
	if (isBatchTriageActionAllowed("archive", folderId)) {
		commands.push({
			id: "archive-selected",
			title: "Archive conversation",
			description: "Move the current conversation to Archive",
			group: "Current conversation",
			keywords: ["file", "remove from inbox"],
			shortcut: "E",
			action: { kind: "mail", command: "archive" },
		});
	}
	if (isBatchTriageActionAllowed("trash", folderId)) {
		commands.push({
			id: "trash-selected",
			title: "Move conversation to Trash",
			description: "Use the current lifecycle confirmation before moving",
			group: "Current conversation",
			keywords: ["delete", "remove"],
			shortcut: "#",
			action: { kind: "mail", command: "trash" },
		});
	}
	return commands;
}

export function filterMailPaletteCommands(
	commands: readonly MailPaletteCommand[],
	query: string,
): MailPaletteCommand[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...commands];
	return commands
		.flatMap((command, index) => {
			const title = command.title.toLowerCase();
			const description = command.description.toLowerCase();
			const keywords = command.keywords.join(" ").toLowerCase();
			if (!terms.every((term) => `${title} ${description} ${keywords}`.includes(term))) {
				return [];
			}
			const exact = terms.join(" ");
			const score = title === exact ? 0 : title.startsWith(exact) ? 1 : title.includes(exact) ? 2 : keywords.includes(exact) ? 3 : 4;
			return [{ command, score, index }];
		})
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.map(({ command }) => command);
}

export function shouldOpenMailCommandPalette(input: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	isComposing: boolean;
	isTextEntry: boolean;
}): boolean {
	return input.key.toLowerCase() === "k" &&
		(input.metaKey || input.ctrlKey) &&
		!input.altKey &&
		!input.isComposing &&
		!input.isTextEntry;
}
