import assert from "node:assert/strict";
import test from "node:test";
import {
	groupFollowUpReminders,
	type FollowUpReminder,
} from "../../shared/follow-up-reminders.ts";
import {
	FollowUpReminderError,
	createFollowUpReminderService,
	type FollowUpReminderStore,
	type ReminderOperation,
} from "./follow-up-reminders.ts";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const MAILBOX = "shared@wiserchat.ai";

function reminder(overrides: Partial<FollowUpReminder> = {}): FollowUpReminder {
	return {
		id: "reminder-1",
		ownerUserId: "user-1",
		mailboxAddress: MAILBOX,
		conversationKey: "thread-1",
		baselineMessageId: "message-1",
		baselineMessageDate: "2026-07-11T10:00:00.000Z",
		remindAt: "2026-07-11T14:00:00.000Z",
		state: "active",
		resolutionReason: null,
		version: 1,
		createdAt: NOW,
		updatedAt: NOW,
		resolvedAt: null,
		...overrides,
	};
}

function fixture(access: boolean | ((userId: string) => boolean) = true) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const rows = new Map<string, FollowUpReminder>();
	const createKeys = new Map<string, { fingerprint: string; reminder: FollowUpReminder }>();
	const operations = new Map<string, { fingerprint: string; row: FollowUpReminder }>();
	const hasAccess = (userId: string) =>
		typeof access === "function" ? access(userId) : access;
	let anchor = {
		conversationKey: "thread-1",
		baselineMessageId: "message-1",
		baselineMessageDate: "2026-07-11T10:00:00.000Z",
	};
	const store: FollowUpReminderStore = {
		async list(input) {
			calls.push({ method: "list", args: [input] });
			const matching = [...rows.values()]
				.filter(
					(row) => row.ownerUserId === input.ownerUserId && row.mailboxAddress === input.mailboxAddress,
				)
				.filter((row) => {
					if (!input.cursor) return true;
					const due = Date.parse(row.remindAt);
					return due > input.cursor.remindAt ||
						(due === input.cursor.remindAt && row.id > input.cursor.id);
				})
				.sort((left, right) =>
					Date.parse(left.remindAt) - Date.parse(right.remindAt) ||
					left.id.localeCompare(right.id));
			const page = matching.slice(0, input.limit);
			const last = page.at(-1);
			return {
				reminders: page,
				nextCursor: matching.length > input.limit && last
					? { remindAt: Date.parse(last.remindAt), id: last.id }
					: null,
			};
		},
		async findCreateReplay(input) {
			const prior = createKeys.get(`${input.ownerUserId}:${input.idempotencyKey}`);
			if (!prior) return null;
			return prior.fingerprint === input.fingerprint
				? { status: "replayed", reminder: prior.reminder }
				: { status: "idempotency_conflict" };
		},
		async createOrReplay(input) {
			calls.push({ method: "createOrReplay", args: [input] });
			const key = `${input.row.ownerUserId}:${input.idempotencyKey}`;
			const prior = createKeys.get(key);
			if (prior) {
				return prior.fingerprint === input.fingerprint
					? { status: "replayed", reminder: prior.reminder }
					: { status: "idempotency_conflict" };
			}
			const active = [...rows.values()].find((row) =>
				row.ownerUserId === input.row.ownerUserId &&
				row.mailboxAddress === input.row.mailboxAddress &&
				row.conversationKey === input.row.conversationKey &&
				row.state === "active",
			);
			if (active) return { status: "active_conflict", reminder: active };
			rows.set(input.row.id, input.row);
			createKeys.set(key, { fingerprint: input.fingerprint, reminder: input.row });
			return { status: "created", reminder: input.row };
		},
		async applyOperation(input) {
			calls.push({ method: "applyOperation", args: [input] });
			const opKey = `${input.ownerUserId}:${input.operationId}`;
			const prior = operations.get(opKey);
			if (prior) {
				return prior.fingerprint === input.fingerprint
					? { status: "replayed", reminder: prior.row }
					: { status: "idempotency_conflict" };
			}
			const current = rows.get(input.reminderId);
			if (!current || current.ownerUserId !== input.ownerUserId || current.mailboxAddress !== input.mailboxAddress) {
				return { status: "not_found" };
			}
			if (current.version !== input.expectedVersion || current.state !== "active") {
				return { status: "state_conflict", reminder: current };
			}
			const next: FollowUpReminder = {
				...current,
				version: current.version + 1,
				updatedAt: input.occurredAt,
				...(input.action === "snooze"
					? { remindAt: input.remindAt! }
					: {
							state: input.action === "dismiss" ? "dismissed" : "completed",
							resolutionReason: input.action === "dismiss" ? "dismissed" : "manual",
							resolvedAt: input.occurredAt,
						}),
			};
			rows.set(next.id, next);
			operations.set(opKey, { fingerprint: input.fingerprint, row: next });
			return { status: "applied", reminder: next };
		},
		async completeForInboundReply(input) {
			calls.push({ method: "completeForInboundReply", args: [input] });
			let completed = 0;
			for (const current of rows.values()) {
				if (
					current.mailboxAddress !== input.mailboxAddress ||
					current.conversationKey !== input.conversationKey ||
					current.state !== "active" ||
					current.baselineMessageId === input.inboundMessageId ||
					Date.parse(current.baselineMessageDate) >= Date.parse(input.inboundMessageDate) ||
					!hasAccess(current.ownerUserId)
				) continue;
				const next = {
					...current,
					state: "completed" as const,
					resolutionReason: "inbound_reply" as const,
					resolvedAt: input.occurredAt,
					updatedAt: input.occurredAt,
					version: current.version + 1,
				};
				rows.set(current.id, next);
				completed += 1;
			}
			return completed;
		},
	};
	const service = createFollowUpReminderService({
		store,
		canAccessMailbox: async (userId, mailboxAddress) => {
			calls.push({ method: "canAccessMailbox", args: [userId, mailboxAddress] });
			return hasAccess(userId);
		},
		resolveReminderAnchor: async (mailboxAddress, emailId) => {
			calls.push({ method: "resolveReminderAnchor", args: [mailboxAddress, emailId] });
			return emailId === "missing" ? null : anchor;
		},
		now: () => NOW,
		id: () => "reminder-1",
	});
	return {
		service,
		rows,
		calls,
		setAnchor(next: typeof anchor) { anchor = next; },
	};
}

const validCreate = {
	emailId: "message-1",
	remindAt: "2026-07-12T09:00:00.000Z",
	idempotencyKey: "create-reminder-1",
};

test("personal reminders are owner scoped and require live mailbox access", async () => {
	const allowed = fixture();
	const created = await allowed.service.create("user-1", "SHARED@WISERCHAT.AI", validCreate);
	assert.equal(created.ownerUserId, "user-1");
	assert.equal(created.mailboxAddress, MAILBOX);
	await allowed.service.list("user-1", MAILBOX, 50);
	assert.deepEqual(
		allowed.calls.filter((call) => call.method === "list")[0]?.args,
		[{
			ownerUserId: "user-1",
			mailboxAddress: MAILBOX,
			limit: 50,
			cursor: null,
		}],
	);

	const denied = fixture(false);
	await assert.rejects(
		() => denied.service.create("user-1", MAILBOX, validCreate),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "FORBIDDEN",
	);
	assert.equal(denied.calls.some((call) => call.method === "createOrReplay"), false);
});

test("reminder list cursors are opaque, Unicode-safe, and recheck live access", async () => {
	const state = fixture();
	state.rows.set("first", reminder({ id: "first", conversationKey: "thread-first" }));
	state.rows.set("réponse", reminder({ id: "réponse", conversationKey: "thread-unicode" }));
	const firstPage = await state.service.list("user-1", MAILBOX, 1);
	assert.equal(firstPage.reminders.length, 1);
	assert.ok(firstPage.nextCursor);
	const secondPage = await state.service.list(
		"user-1",
		MAILBOX,
		1,
		firstPage.nextCursor,
	);
	assert.equal(secondPage.reminders.length, 1);
	assert.equal(secondPage.nextCursor, null);
	assert.equal(
		state.calls.filter((call) => call.method === "canAccessMailbox").length,
		2,
	);
	await assert.rejects(
		() => state.service.list("user-1", MAILBOX, 1, "not-a-real-cursor"),
		(error: unknown) =>
			error instanceof FollowUpReminderError && error.code === "INVALID",
	);
});

test("create is bounded, idempotent, and allows one active reminder per personal conversation", async () => {
	const { service } = fixture();
	const first = await service.create("user-1", MAILBOX, validCreate);
	const replay = await service.create("user-1", MAILBOX, validCreate);
	assert.deepEqual(replay, first);
	await assert.rejects(
		() => service.create("user-1", MAILBOX, { ...validCreate, remindAt: "2026-07-13T09:00:00.000Z" }),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "IDEMPOTENCY_CONFLICT",
	);
	await assert.rejects(
		() => service.create("user-1", MAILBOX, { ...validCreate, idempotencyKey: "create-reminder-2" }),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "ACTIVE_CONFLICT",
	);
	for (const remindAt of [
		"2026-07-11T11:59:59.000Z",
		"2027-07-12T12:00:00.000Z",
		"2026-07-12T09:00:00",
	]) {
		await assert.rejects(
			() => fixture().service.create("user-1", MAILBOX, { ...validCreate, remindAt }),
			(error: unknown) => error instanceof FollowUpReminderError && error.code === "INVALID",
		);
	}
	assert.equal(
		(await fixture().service.create("user-1", MAILBOX, {
			...validCreate,
			remindAt: "2026-07-12T09:00:00+02:00",
		})).remindAt,
		"2026-07-12T09:00:00+02:00",
	);
});

test("create replay remains stable when the stored conversation advances", async () => {
	const state = fixture();
	const first = await state.service.create("user-1", MAILBOX, validCreate);
	state.setAnchor({
		conversationKey: "thread-1",
		baselineMessageId: "message-2",
		baselineMessageDate: "2026-07-11T11:00:00.000Z",
	});
	assert.deepEqual(
		await state.service.create("user-1", MAILBOX, validCreate),
		first,
	);
	assert.equal(
		state.calls.filter((call) => call.method === "resolveReminderAnchor").length,
		1,
	);
	await assert.rejects(
		() => state.service.create("user-1", MAILBOX, {
			...validCreate,
			remindAt: "2026-07-13T09:00:00.000Z",
		}),
		(error: unknown) =>
			error instanceof FollowUpReminderError &&
			error.code === "IDEMPOTENCY_CONFLICT",
	);
});

test("dismiss, complete, and snooze are typed CAS operations with replay protection", async () => {
	for (const operation of [
		{ action: "dismiss", operationId: "dismiss-reminder-1" },
		{ action: "complete", operationId: "complete-reminder-1" },
		{ action: "snooze", operationId: "snooze-reminder-1", remindAt: "2026-07-14T09:00:00.000Z" },
	] satisfies ReminderOperation[]) {
		const { service } = fixture();
		const created = await service.create("user-1", MAILBOX, validCreate);
		const result = await service.apply("user-1", MAILBOX, created.id, {
			...operation,
			expectedVersion: 1,
		});
		const replay = await service.apply("user-1", MAILBOX, created.id, {
			...operation,
			expectedVersion: 1,
		});
		assert.deepEqual(replay, result);
		assert.equal(result.version, 2);
		assert.equal(result.state, operation.action === "snooze" ? "active" : operation.action === "dismiss" ? "dismissed" : "completed");
	}
});

test("a newer stored inbound reply completes only eligible owners' active reminders", async () => {
	const { service, rows } = fixture((ownerUserId) => ownerUserId === "user-1");
	rows.set("eligible", reminder({ id: "eligible", ownerUserId: "user-1" }));
	rows.set("revoked", reminder({ id: "revoked", ownerUserId: "user-2" }));
	const completed = await service.completeForInboundReply({
		mailboxAddress: MAILBOX,
		conversationKey: "thread-1",
		inboundMessageId: "message-2",
		inboundMessageDate: "2026-07-11T13:00:00.000Z",
	});
	assert.equal(completed, 1);
	assert.equal(rows.get("eligible")?.resolutionReason, "inbound_reply");
	assert.equal(rows.get("revoked")?.state, "active");
});

test("Today, overdue, and upcoming groups are deterministic and mutually exclusive", () => {
	const groups = groupFollowUpReminders(
		[
			reminder({ id: "upcoming", remindAt: "2026-07-12T09:00:00.000Z" }),
			reminder({ id: "today-b", remindAt: "2026-07-11T15:00:00.000Z" }),
			reminder({ id: "overdue", remindAt: "2026-07-11T11:59:59.000Z" }),
			reminder({ id: "today-a", remindAt: "2026-07-11T13:00:00.000Z" }),
		],
		{
			now: "2026-07-11T12:00:00.000Z",
			tomorrowStart: "2026-07-12T00:00:00.000Z",
		},
	);
	assert.deepEqual(groups.overdue.map((row) => row.id), ["overdue"]);
	assert.deepEqual(groups.today.map((row) => row.id), ["today-a", "today-b"]);
	assert.deepEqual(groups.upcoming.map((row) => row.id), ["upcoming"]);
});
