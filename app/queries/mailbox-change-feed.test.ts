import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
	encodeMailboxChangeCursor,
	type MailboxChange,
} from "../../shared/mailbox-change-feed.ts";
import { ApiError } from "../services/api.ts";
import {
	MAILBOX_CHANGE_HIDDEN_MAX_BACKOFF_MS,
	MAILBOX_CHANGE_VISIBLE_MAX_BACKOFF_MS,
	createMailboxChangeFeedController,
	exitRevokedMailbox,
	invalidateMailboxChangeQueries,
	mailboxChangeCursorStorageKey,
	resolveMailboxChangeFeedStorage,
	type MailboxChangeFeedRuntime,
	type MailboxChangeFeedStorage,
} from "./mailbox-change-feed.ts";

function createRuntime(input: {
	online?: boolean;
	visible?: boolean;
} = {}) {
	const windowListeners = new Map<string, Set<() => void>>();
	const documentListeners = new Map<string, Set<() => void>>();
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let timerId = 0;
	let online = input.online ?? true;
	let visible = input.visible ?? true;
	const runtime: MailboxChangeFeedRuntime = {
		isOnline: () => online,
		isVisible: () => visible,
		setTimer: (callback, delay) => {
			timerId += 1;
			timers.set(timerId, { callback, delay });
			return timerId;
		},
		clearTimer: (id) => {
			timers.delete(id);
		},
		addWindowListener: (type, listener) => {
			const listeners = windowListeners.get(type) ?? new Set();
			listeners.add(listener);
			windowListeners.set(type, listeners);
		},
		removeWindowListener: (type, listener) => {
			windowListeners.get(type)?.delete(listener);
		},
		addDocumentListener: (type, listener) => {
			const listeners = documentListeners.get(type) ?? new Set();
			listeners.add(listener);
			documentListeners.set(type, listeners);
		},
		removeDocumentListener: (type, listener) => {
			documentListeners.get(type)?.delete(listener);
		},
	};
	return {
		runtime,
		timers,
		emitWindow: (type: string) => {
			for (const listener of windowListeners.get(type) ?? []) listener();
		},
		emitDocument: (type: string) => {
			for (const listener of documentListeners.get(type) ?? []) listener();
		},
		setOnline: (value: boolean) => {
			online = value;
		},
		setVisible: (value: boolean) => {
			visible = value;
		},
	};
}

test("each feed resource invalidates only its deterministic non-AI mailbox projections", async () => {
	const mailboxId = "team@example.com";
	const otherMailboxId = "private@example.com";
	const queryClient = new QueryClient();
	const keys = {
		emails: ["emails", mailboxId, { folder: "inbox" }],
		folders: ["folders", mailboxId],
		search: ["search", mailboxId, "invoice", 1, ""],
		savedResults: ["saved-view-results", mailboxId, "view-1", "{}", 1],
		recipients: ["recipient-suggestions", mailboxId, "a", 10],
		activity: ["conversation-activity", mailboxId, "message-1"],
		attachments: ["attachments", mailboxId, "list", { q: "", kind: "", folder: "" }],
		attachmentDetail: ["attachments", mailboxId, "detail", "attachment-1"],
		attachmentBytes: ["attachments", mailboxId, "bytes", "message-1", "attachment-1"],
		peopleList: ["people", mailboxId, "list", { q: "", sort: "recent" }],
		peopleDetail: ["people", mailboxId, "detail", "person-1"],
		peopleTimeline: ["people", mailboxId, "timeline", "person-1"],
		relationshipBrief: ["relationship-brief", mailboxId, "person-1"],
		labels: ["labels", mailboxId],
		outbound: ["outbound", mailboxId, "message-1"],
		ai: ["conversation-intelligence", mailboxId, "message-1"],
		today: ["today-brief", mailboxId, "Africa/Cairo"],
		settings: ["mailbox-signature-settings", mailboxId],
		reminders: ["follow-up-reminders", mailboxId],
		otherMailbox: ["emails", otherMailboxId, { folder: "inbox" }],
	} as const;
	for (const key of Object.values(keys)) queryClient.setQueryData(key, { ready: true });

	await invalidateMailboxChangeQueries(queryClient, mailboxId, [
		{
			sequence: 8,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:00.000Z",
			resource: "message",
			entityId: "message-1",
			parentId: null,
			operation: "updated",
		},
		{
			sequence: 9,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:01.000Z",
			resource: "attachment",
			entityId: "attachment-1",
			parentId: "message-1",
			operation: "updated",
		},
		{
			sequence: 10,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:02.000Z",
			resource: "label",
			entityId: "label-1",
			parentId: null,
			operation: "updated",
		},
		{
			sequence: 11,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:03.000Z",
			resource: "delivery",
			entityId: "delivery-1",
			parentId: "message-1",
			operation: "updated",
		},
	]);

	for (const key of [
		keys.emails,
		keys.folders,
		keys.search,
		keys.savedResults,
		keys.recipients,
		keys.activity,
		keys.attachments,
		keys.attachmentDetail,
		keys.peopleList,
		keys.peopleDetail,
		keys.peopleTimeline,
		keys.labels,
		keys.outbound,
	]) {
		assert.equal(queryClient.getQueryState(key)?.isInvalidated, true, JSON.stringify(key));
	}
	for (const key of [
		keys.attachmentBytes,
		keys.ai,
		keys.today,
		keys.relationshipBrief,
		keys.settings,
		keys.reminders,
		keys.otherMailbox,
	]) {
		assert.equal(queryClient.getQueryState(key)?.isInvalidated, false, JSON.stringify(key));
	}
});

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const storage: MailboxChangeFeedStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	};
	return { storage, values };
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function change(resource: MailboxChange["resource"]): MailboxChange {
	return {
		sequence: 1,
		schemaVersion: 1,
		committedAt: "2026-07-12T12:30:00.000Z",
		resource,
		entityId: `${resource}-1`,
		parentId: resource === "attachment" ? "message-1" : null,
		operation: "updated",
	};
}

test("message and folder changes refresh Files metadata while attachment changes refresh Conversation Activity", async () => {
	const mailboxId = "team@example.com";
	for (const scenario of [
		{ resource: "message", target: ["attachments", mailboxId, "list", {}] },
		{ resource: "folder", target: ["attachments", mailboxId, "list", {}] },
		{ resource: "attachment", target: ["conversation-activity", mailboxId, "message-1"] },
	] satisfies Array<{
		resource: MailboxChange["resource"];
		target: readonly unknown[];
	}>) {
		const queryClient = new QueryClient();
		queryClient.setQueryData(scenario.target, { ready: true });
		await invalidateMailboxChangeQueries(queryClient, mailboxId, [change(scenario.resource)]);
		assert.equal(
			queryClient.getQueryState(scenario.target)?.isInvalidated,
			true,
			scenario.resource,
		);
	}
});

test("attachment changes refresh People evidence without refetching the People list", async () => {
	const mailboxId = "team@example.com";
	const queryClient = new QueryClient();
	const list = ["people", mailboxId, "list", { q: "", sort: "recent" }] as const;
	const detail = ["people", mailboxId, "detail", "person-1"] as const;
	const timeline = ["people", mailboxId, "timeline", "person-1"] as const;
	for (const key of [list, detail, timeline]) queryClient.setQueryData(key, { ready: true });

	await invalidateMailboxChangeQueries(queryClient, mailboxId, [change("attachment")]);

	assert.equal(queryClient.getQueryState(list)?.isInvalidated, false);
	assert.equal(queryClient.getQueryState(detail)?.isInvalidated, true);
	assert.equal(queryClient.getQueryState(timeline)?.isInvalidated, true);
});

test("deterministic Message and attachment changes never auto-invalidate a paid relationship brief", async () => {
	const mailboxId = "team@example.com";
	const queryClient = new QueryClient();
	const brief = ["relationship-brief", mailboxId, "person-1"] as const;
	queryClient.setQueryData(brief, { state: "cached" });

	await invalidateMailboxChangeQueries(queryClient, mailboxId, [
		change("message"),
		change("attachment"),
	]);

	assert.equal(queryClient.getQueryState(brief)?.isInvalidated, false);
});

test("the feed resumes from and stores one versioned mailbox cursor without mail content", async () => {
	const mailboxId = "team@example.com";
	const storedCursor = encodeMailboxChangeCursor(7);
	const nextCursor = encodeMailboxChangeCursor(8);
	const key = mailboxChangeCursorStorageKey(mailboxId);
	const memory = memoryStorage({
		[key]: JSON.stringify({ version: 1, cursor: storedCursor }),
	});
	const browser = createRuntime();
	const requests: Array<string | null> = [];
	const controller = createMailboxChangeFeedController({
		mailboxId,
		queryClient: new QueryClient(),
		storage: memory.storage,
		runtime: browser.runtime,
		request: async (_mailboxId, cursor) => {
			requests.push(cursor);
			return { changes: [], nextCursor };
		},
	});

	controller.start();
	await settle();
	controller.stop();

	assert.deepEqual(requests, [storedCursor]);
	assert.equal(
		memory.values.get(key),
		JSON.stringify({ version: 1, cursor: nextCursor }),
	);
	assert.deepEqual(Object.keys(JSON.parse(memory.values.get(key)!)), [
		"version",
		"cursor",
	]);
});

test("one owner polls every five seconds when visible, thirty when hidden, and wakes immediately on browser signals", async () => {
	const browser = createRuntime();
	const memory = memoryStorage();
	let sequence = 0;
	const requests: Array<string | null> = [];
	const controller = createMailboxChangeFeedController({
		mailboxId: "team@example.com",
		queryClient: new QueryClient(),
		storage: memory.storage,
		runtime: browser.runtime,
		request: async (_mailboxId, cursor) => {
			requests.push(cursor);
			sequence += 1;
			return { changes: [], nextCursor: encodeMailboxChangeCursor(sequence) };
		},
	});

	controller.start();
	controller.start();
	await settle();
	assert.equal(requests.length, 1);
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [5_000]);

	browser.emitWindow("focus");
	await settle();
	assert.equal(requests.length, 2);
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [5_000]);

	browser.setVisible(false);
	browser.emitDocument("visibilitychange");
	await settle();
	assert.equal(requests.length, 2);
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [30_000]);

	browser.setOnline(false);
	const hiddenTimer = [...browser.timers.values()][0];
	hiddenTimer?.callback();
	await settle();
	assert.equal(requests.length, 2);

	browser.setOnline(true);
	browser.emitWindow("online");
	await settle();
	assert.equal(requests.length, 3);

	browser.setVisible(true);
	browser.emitDocument("visibilitychange");
	await settle();
	assert.equal(requests.length, 4);
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [5_000]);
	controller.stop();
});

test("transient failures back off within visible and hidden bounds and success restores normal cadence", async () => {
	const browser = createRuntime();
	let failuresRemaining = 8;
	const controller = createMailboxChangeFeedController({
		mailboxId: "team@example.com",
		queryClient: new QueryClient(),
		storage: memoryStorage().storage,
		runtime: browser.runtime,
		request: async () => {
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				throw new Error("temporarily unavailable");
			}
			return { changes: [], nextCursor: encodeMailboxChangeCursor(1) };
		},
	});

	controller.start();
	await settle();
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [10_000]);

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const scheduled = [...browser.timers.values()][0];
		scheduled?.callback();
		await settle();
	}
	assert.deepEqual(
		[...browser.timers.values()].map(({ delay }) => delay),
		[MAILBOX_CHANGE_VISIBLE_MAX_BACKOFF_MS],
	);

	browser.setVisible(false);
	browser.emitDocument("visibilitychange");
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const scheduled = [...browser.timers.values()][0];
		scheduled?.callback();
		await settle();
	}
	assert.deepEqual(
		[...browser.timers.values()].map(({ delay }) => delay),
		[MAILBOX_CHANGE_HIDDEN_MAX_BACKOFF_MS],
	);

	const recovery = [...browser.timers.values()][0];
	recovery?.callback();
	await settle();
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [30_000]);
	controller.stop();
});

test("a response from a mailbox that was switched away from cannot move its cursor or invalidate its cache", async () => {
	const oldMailbox = "old@example.com";
	const key = mailboxChangeCursorStorageKey(oldMailbox);
	const memory = memoryStorage();
	const browser = createRuntime();
	const queryClient = new QueryClient();
	const emailKey = ["emails", oldMailbox, { folder: "inbox" }] as const;
	queryClient.setQueryData(emailKey, { ready: true });
	let resolveRequest: ((page: {
		changes: [{
			sequence: number;
			schemaVersion: 1;
			committedAt: string;
			resource: "message";
			entityId: string;
			parentId: null;
			operation: "updated";
		}];
		nextCursor: string;
	}) => void) | undefined;
	const controller = createMailboxChangeFeedController({
		mailboxId: oldMailbox,
		queryClient,
		storage: memory.storage,
		runtime: browser.runtime,
		request: () => new Promise((resolve) => {
			resolveRequest = resolve;
		}),
	});

	controller.start();
	await settle();
	controller.stop();
	resolveRequest?.({
		changes: [{
			sequence: 1,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:00.000Z",
			resource: "message",
			entityId: "message-1",
			parentId: null,
			operation: "updated",
		}],
		nextCursor: encodeMailboxChangeCursor(1),
	});
	await settle();

	assert.equal(memory.values.has(key), false);
	assert.equal(queryClient.getQueryState(emailKey)?.isInvalidated, false);
	assert.equal(browser.timers.size, 0);
});

test("a forbidden feed purges every revoked-mailbox cache, clears its cursor, refreshes access, and reports the loss", async () => {
	const mailboxId = "revoked@example.com";
	const otherMailboxId = "still-visible@example.com";
	const key = mailboxChangeCursorStorageKey(mailboxId);
	const memory = memoryStorage({
		[key]: JSON.stringify({ version: 1, cursor: encodeMailboxChangeCursor(4) }),
	});
	const browser = createRuntime();
	const queryClient = new QueryClient();
	const accessibleMailboxesKey = ["mailboxes"] as const;
	const revokedKeys = [
		["emails", mailboxId, { folder: "inbox" }],
		["conversation-intelligence", mailboxId, "message-1"],
		["attachments", mailboxId, "bytes", "message-1", "attachment-1"],
		["mailbox-signature-settings", mailboxId],
		["follow-up-reminders", mailboxId],
		["push", mailboxId, "health", "actor@example.com"],
	] as const;
	const otherKey = ["emails", otherMailboxId, { folder: "inbox" }] as const;
	const adversarialOtherKey = ["search", otherMailboxId, mailboxId, 1, ""] as const;
	queryClient.setQueryData(accessibleMailboxesKey, [mailboxId, otherMailboxId]);
	for (const revokedKey of revokedKeys) queryClient.setQueryData(revokedKey, { private: true });
	queryClient.setQueryData(otherKey, { private: false });
	queryClient.setQueryData(adversarialOtherKey, { private: false });
	const losses: string[] = [];
	const controller = createMailboxChangeFeedController({
		mailboxId,
		queryClient,
		storage: memory.storage,
		runtime: browser.runtime,
		request: async () => {
			throw new ApiError(403, { error: "Forbidden" });
		},
		onAccessLost: (lostMailboxId) => losses.push(lostMailboxId),
	});

	controller.start();
	await settle();

	assert.equal(memory.values.has(key), false);
	for (const revokedKey of revokedKeys) {
		assert.equal(queryClient.getQueryState(revokedKey), undefined, JSON.stringify(revokedKey));
	}
	assert.deepEqual(queryClient.getQueryData(otherKey), { private: false });
	assert.deepEqual(queryClient.getQueryData(adversarialOtherKey), { private: false });
	assert.equal(queryClient.getQueryState(accessibleMailboxesKey)?.isInvalidated, true);
	assert.deepEqual(losses, [mailboxId]);
	assert.equal(browser.timers.size, 0);
	controller.stop();
});

test("revoked mailbox exit never waits for a stalled accessible-mailbox refresh", async () => {
	const queryClient = new QueryClient();
	let refreshStarted = false;
	queryClient.invalidateQueries = (() => {
		refreshStarted = true;
		return new Promise<void>(() => {});
	}) as typeof queryClient.invalidateQueries;
	const losses: string[] = [];
	const controller = createMailboxChangeFeedController({
		mailboxId: "revoked@example.com",
		queryClient,
		storage: memoryStorage().storage,
		runtime: createRuntime().runtime,
		request: async () => {
			throw new ApiError(403, { error: "Forbidden" });
		},
		onAccessLost: (mailboxId) => losses.push(mailboxId),
	});

	controller.start();
	await settle();

	assert.equal(refreshStarted, true);
	assert.deepEqual(losses, ["revoked@example.com"]);
	controller.stop();
});

test("a direct feature 403 reuses the revoked-mailbox exit without waiting for refresh", () => {
	const mailboxId = "revoked@example.com";
	const queryClient = new QueryClient();
	queryClient.setQueryData(["people", mailboxId, "list", {}], { secret: true });
	queryClient.setQueryData(["relationship-brief", mailboxId, "person-1"], { secret: true });
	let refreshStarted = false;
	let exited = false;
	queryClient.invalidateQueries = (() => {
		refreshStarted = true;
		return new Promise(() => undefined);
	}) as typeof queryClient.invalidateQueries;

	exitRevokedMailbox({
		queryClient,
		mailboxId,
		storage: memoryStorage().storage,
		onExit: () => {
			exited = true;
		},
	});

	assert.equal(queryClient.getQueryData(["people", mailboxId, "list", {}]), undefined);
	assert.equal(queryClient.getQueryData(["relationship-brief", mailboxId, "person-1"]), undefined);
	assert.equal(refreshStarted, true);
	assert.equal(exited, true);
});

test("unavailable browser storage falls back safely and read/write failures never stop live invalidation", async () => {
	const fallback = resolveMailboxChangeFeedStorage(() => {
		throw new DOMException("Storage denied", "SecurityError");
	});
	fallback.setItem("probe", "cursor-only");
	assert.equal(fallback.getItem("probe"), "cursor-only");
	fallback.removeItem("probe");

	const mailboxId = "team@example.com";
	const queryClient = new QueryClient();
	const emailKey = ["emails", mailboxId, { folder: "inbox" }] as const;
	queryClient.setQueryData(emailKey, { ready: true });
	const browser = createRuntime();
	const brokenStorage: MailboxChangeFeedStorage = {
		getItem: () => {
			throw new DOMException("Storage denied", "SecurityError");
		},
		setItem: () => {
			throw new DOMException("Quota exceeded", "QuotaExceededError");
		},
		removeItem: () => {
			throw new DOMException("Storage denied", "SecurityError");
		},
	};
	const controller = createMailboxChangeFeedController({
		mailboxId,
		queryClient,
		storage: brokenStorage,
		runtime: browser.runtime,
		request: async () => ({
			changes: [{
				sequence: 1,
				schemaVersion: 1,
				committedAt: "2026-07-12T12:30:00.000Z",
				resource: "message",
				entityId: "message-1",
				parentId: null,
				operation: "updated",
			}],
			nextCursor: encodeMailboxChangeCursor(1),
		}),
	});
	controller.start();
	await settle();

	assert.equal(queryClient.getQueryState(emailKey)?.isInvalidated, true);
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [5_000]);
	controller.stop();
});

test("focus, online, and visibility signals remain single-flight while one poll is pending", async () => {
	const browser = createRuntime();
	let requests = 0;
	let resolveRequest: ((page: { changes: []; nextCursor: string }) => void) | undefined;
	const controller = createMailboxChangeFeedController({
		mailboxId: "team@example.com",
		queryClient: new QueryClient(),
		storage: memoryStorage().storage,
		runtime: browser.runtime,
		request: () => {
			requests += 1;
			return new Promise((resolve) => {
				resolveRequest = resolve;
			});
		},
	});
	controller.start();
	await settle();
	browser.emitWindow("focus");
	browser.emitWindow("online");
	browser.emitDocument("visibilitychange");
	await settle();
	assert.equal(requests, 1);

	resolveRequest?.({ changes: [], nextCursor: encodeMailboxChangeCursor(1) });
	await settle();
	assert.deepEqual([...browser.timers.values()].map(({ delay }) => delay), [5_000]);
	controller.stop();
});
