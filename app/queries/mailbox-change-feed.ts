import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
	decodeMailboxChangeCursor,
	type MailboxChange,
	type MailboxChangePage,
} from "../../shared/mailbox-change-feed.ts";
import api, { ApiError } from "../services/api.ts";

export const MAILBOX_CHANGE_VISIBLE_POLL_MS = 5_000;
export const MAILBOX_CHANGE_HIDDEN_POLL_MS = 30_000;
export const MAILBOX_CHANGE_VISIBLE_MAX_BACKOFF_MS = 60_000;
export const MAILBOX_CHANGE_HIDDEN_MAX_BACKOFF_MS = 300_000;

export interface MailboxChangeFeedStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

type MailboxChangeFeedListener = () => void;

export interface MailboxChangeFeedRuntime {
	isOnline(): boolean;
	isVisible(): boolean;
	setTimer(callback: () => void, delay: number): number;
	clearTimer(id: number): void;
	addWindowListener(type: "focus" | "online", listener: MailboxChangeFeedListener): void;
	removeWindowListener(type: "focus" | "online", listener: MailboxChangeFeedListener): void;
	addDocumentListener(type: "visibilitychange", listener: MailboxChangeFeedListener): void;
	removeDocumentListener(type: "visibilitychange", listener: MailboxChangeFeedListener): void;
}

type MailboxChangeFeedRequest = (
	mailboxId: string,
	cursor: string | null,
	options?: { signal?: AbortSignal },
) => Promise<MailboxChangePage>;

export function mailboxChangeCursorStorageKey(mailboxId: string): string {
	return `mailbox-change-feed:v1:${encodeURIComponent(mailboxId)}`;
}

function readCursor(storage: MailboxChangeFeedStorage, mailboxId: string): string | null {
	const key = mailboxChangeCursorStorageKey(mailboxId);
	try {
		const raw = storage.getItem(key);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		const record = parsed as Record<string, unknown>;
		if (
			Object.keys(record).join(",") !== "version,cursor" ||
			record.version !== 1 ||
			typeof record.cursor !== "string"
		) throw new Error();
		decodeMailboxChangeCursor(record.cursor);
		return record.cursor;
	} catch {
		try {
			storage.removeItem(key);
		} catch {
			// Storage can be unavailable in private or hardened browser contexts.
		}
		return null;
	}
}

function writeCursor(
	storage: MailboxChangeFeedStorage,
	mailboxId: string,
	cursor: string,
): void {
	try {
		storage.setItem(
			mailboxChangeCursorStorageKey(mailboxId),
			JSON.stringify({ version: 1, cursor }),
		);
	} catch {
		// The in-memory cursor remains authoritative for this mounted route.
	}
}

type InvalidatedQueryRoot =
	| "attachments"
	| "conversation-activity"
	| "emails"
	| "folders"
	| "labels"
	| "outbound"
	| "people"
	| "recipient-suggestions"
	| "saved-view-results"
	| "search";

const INVALIDATED_ROOTS_BY_RESOURCE: Record<MailboxChange["resource"], readonly InvalidatedQueryRoot[]> = {
	message: [
		"attachments",
		"conversation-activity",
		"emails",
		"folders",
		"people",
		"recipient-suggestions",
		"saved-view-results",
		"search",
	],
	attachment: [
		"attachments",
		"conversation-activity",
		"emails",
		"people",
		"saved-view-results",
		"search",
	],
	folder: ["attachments", "emails", "folders", "saved-view-results", "search"],
	label: ["emails", "labels", "saved-view-results", "search"],
	message_label: ["conversation-activity", "emails", "saved-view-results", "search"],
	delivery: ["conversation-activity", "emails", "outbound"],
	delivery_attempt: ["conversation-activity", "emails", "outbound"],
};

export function invalidateMailboxChangeQueries(
	queryClient: QueryClient,
	mailboxId: string,
	changes: readonly MailboxChange[],
): Promise<void> {
	const roots = new Set<InvalidatedQueryRoot>();
	let messagePeopleChanged = false;
	let attachmentPeopleChanged = false;
	for (const change of changes) {
		if (change.resource === "message") messagePeopleChanged = true;
		if (change.resource === "attachment") attachmentPeopleChanged = true;
		for (const root of INVALIDATED_ROOTS_BY_RESOURCE[change.resource]) roots.add(root);
	}
	if (roots.size === 0) return Promise.resolve();
	return queryClient.invalidateQueries({
		predicate: (query) => {
			const [root, scopedMailboxId, projection] = query.queryKey;
			if (root === "people" && scopedMailboxId === mailboxId) {
				return messagePeopleChanged ||
					(attachmentPeopleChanged && (projection === "detail" || projection === "timeline"));
			}
			return (
				typeof root === "string" &&
				roots.has(root as InvalidatedQueryRoot) &&
				scopedMailboxId === mailboxId &&
				!(root === "attachments" && projection === "bytes")
			);
		},
	});
}

const volatileCursorValues = new Map<string, string>();
const volatileCursorStorage: MailboxChangeFeedStorage = {
	getItem: (key) => volatileCursorValues.get(key) ?? null,
	setItem: (key, value) => {
		volatileCursorValues.set(key, value);
	},
	removeItem: (key) => {
		volatileCursorValues.delete(key);
	},
};

export function resolveMailboxChangeFeedStorage(
	readStorage: () => MailboxChangeFeedStorage,
): MailboxChangeFeedStorage {
	try {
		return readStorage();
	} catch {
		return volatileCursorStorage;
	}
}

function removeCursor(storage: MailboxChangeFeedStorage, mailboxId: string): void {
	try {
		storage.removeItem(mailboxChangeCursorStorageKey(mailboxId));
	} catch {
		// Access revocation still purges memory/query state if storage is unavailable.
	}
}

function evictRevokedMailbox(
	queryClient: QueryClient,
	mailboxId: string,
): void {
	queryClient.removeQueries({
		predicate: (query) =>
			query.queryKey[1] === mailboxId ||
			(
				query.queryKey[0] === "push" &&
				query.queryKey[1] === "devices" &&
				query.queryKey[2] === mailboxId
			),
	});
	void queryClient.invalidateQueries({
		queryKey: ["mailboxes"],
		exact: true,
	});
}

export function exitRevokedMailbox(input: {
	queryClient: QueryClient;
	mailboxId: string;
	storage: MailboxChangeFeedStorage;
	onExit?: (mailboxId: string) => void;
}): void {
	removeCursor(input.storage, input.mailboxId);
	evictRevokedMailbox(input.queryClient, input.mailboxId);
	input.onExit?.(input.mailboxId);
}

export function createMailboxChangeFeedController(input: {
	mailboxId: string;
	queryClient: QueryClient;
	storage: MailboxChangeFeedStorage;
	runtime: MailboxChangeFeedRuntime;
	request?: MailboxChangeFeedRequest;
	onAccessLost?: (mailboxId: string) => void;
}) {
	const request = input.request ?? api.listMailboxChanges;
	let started = false;
	let active = false;
	let timer: number | null = null;
	let controller: AbortController | null = null;
	let cursor = readCursor(input.storage, input.mailboxId);
	let consecutiveFailures = 0;

	const clearTimer = () => {
		if (timer === null) return;
		input.runtime.clearTimer(timer);
		timer = null;
	};

	const schedule = () => {
		if (!active || !input.runtime.isOnline()) return;
		clearTimer();
		const visible = input.runtime.isVisible();
		const baseDelay = visible
			? MAILBOX_CHANGE_VISIBLE_POLL_MS
			: MAILBOX_CHANGE_HIDDEN_POLL_MS;
		const maximumDelay = visible
			? MAILBOX_CHANGE_VISIBLE_MAX_BACKOFF_MS
			: MAILBOX_CHANGE_HIDDEN_MAX_BACKOFF_MS;
		timer = input.runtime.setTimer(
			() => void poll(),
			Math.min(baseDelay * (2 ** consecutiveFailures), maximumDelay),
		);
	};

	const poll = async () => {
		if (!active || !input.runtime.isOnline() || controller) return;
		clearTimer();
		const requestController = new AbortController();
		controller = requestController;
		try {
			const page = await request(input.mailboxId, cursor, {
				signal: requestController.signal,
			});
			if (!active || controller !== requestController) return;
			await invalidateMailboxChangeQueries(
				input.queryClient,
				input.mailboxId,
				page.changes,
			);
			if (!active || controller !== requestController) return;
			cursor = page.nextCursor;
			writeCursor(input.storage, input.mailboxId, cursor);
			consecutiveFailures = 0;
		} catch (error) {
			if (error instanceof ApiError && error.status === 403) {
				active = false;
				clearTimer();
				detachListeners();
				exitRevokedMailbox({
					queryClient: input.queryClient,
					mailboxId: input.mailboxId,
					storage: input.storage,
					onExit: controller === requestController
						? input.onAccessLost
						: undefined,
				});
				// Navigation intentionally does not wait for the accessible-mailbox
				// refresh started by exitRevokedMailbox.
			} else if (active && !requestController.signal.aborted) {
				consecutiveFailures += 1;
			}
			// Other failures retry from the last accepted cursor.
		} finally {
			if (controller === requestController) controller = null;
			if (active) schedule();
		}
	};

	const pollImmediately = () => {
		if (!active || !input.runtime.isOnline()) return;
		clearTimer();
		void poll();
	};

	const handleVisibilityChange = () => {
		if (!active || !input.runtime.isOnline()) return;
		if (input.runtime.isVisible()) {
			pollImmediately();
			return;
		}
		schedule();
	};

	const detachListeners = () => {
		input.runtime.removeWindowListener("focus", pollImmediately);
		input.runtime.removeWindowListener("online", pollImmediately);
		input.runtime.removeDocumentListener("visibilitychange", handleVisibilityChange);
	};

	return {
		start() {
			if (started) return;
			started = true;
			active = true;
			input.runtime.addWindowListener("focus", pollImmediately);
			input.runtime.addWindowListener("online", pollImmediately);
			input.runtime.addDocumentListener("visibilitychange", handleVisibilityChange);
			pollImmediately();
		},
		stop() {
			if (!started) return;
			started = false;
			active = false;
			clearTimer();
			controller?.abort();
			controller = null;
			detachListeners();
		},
	};
}

function browserRuntime(): MailboxChangeFeedRuntime {
	return {
		isOnline: () => navigator.onLine,
		isVisible: () => document.visibilityState === "visible",
		setTimer: (callback, delay) => window.setTimeout(callback, delay),
		clearTimer: (id) => window.clearTimeout(id),
		addWindowListener: (type, listener) => window.addEventListener(type, listener),
		removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
		addDocumentListener: (type, listener) => document.addEventListener(type, listener),
		removeDocumentListener: (type, listener) => document.removeEventListener(type, listener),
	};
}

export function useMailboxChangeFeed(mailboxId: string | undefined): void {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	useEffect(() => {
		if (!mailboxId) return;
		const controller = createMailboxChangeFeedController({
			mailboxId,
			queryClient,
			storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			runtime: browserRuntime(),
			onAccessLost: () => navigate("/", { replace: true }),
		});
		controller.start();
		return () => controller.stop();
	}, [mailboxId, navigate, queryClient]);
}
