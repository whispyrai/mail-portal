import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
	GLOBAL_TODAY_LIMITS,
	globalTodayMailboxOrder,
	globalTodayReminderOrder,
	type GlobalTodayMailboxPulse,
	type GlobalTodayMailboxSnapshot,
	type GlobalTodayReadyResponse,
	type GlobalTodayResponse,
} from "../../shared/global-today.ts";
import type { MailboxRow } from "../db/users-schema.ts";
import type { Env } from "../types.ts";
import { followUpReminderD1Store } from "./follow-up-reminders-d1.ts";
import type { FollowUpReminderStoreCursor } from "./follow-up-reminders.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import type { TodayBriefDayBoundary } from "./today-brief-timezone.ts";

type ReminderCursor = FollowUpReminderStoreCursor | null;
type GlobalTodayReadBudget = { unsettled: number };

export type GlobalTodayDependencies = {
	listAccessibleMailboxes(actorUserId: string): Promise<MailboxRow[]>;
	canAccessMailbox(actorUserId: string, mailboxId: string): Promise<boolean>;
	listReminderPage(input: {
		actorUserId: string;
		mailboxId: string;
		limit: number;
		cursor: ReminderCursor;
	}): Promise<{ reminders: FollowUpReminder[]; nextCursor: ReminderCursor }>;
	readMailbox(input: {
		mailboxId: string;
		baselineMessageIds: string[];
	}): Promise<GlobalTodayMailboxPulse>;
	mailboxTimeoutMs?: number;
	now(): number;
};

class GlobalTodayMailboxTimeoutError extends Error {
	constructor() {
		super("Global Today Mailbox snapshot timed out");
		this.name = "GlobalTodayMailboxTimeoutError";
	}
}

function orderedRoster(rows: MailboxRow[]) {
	return [...rows].sort(globalTodayMailboxOrder);
}

function rosterFingerprint(rows: MailboxRow[]) {
	return rows.map((row) => `${row.type}:${row.address}`).join("\n");
}

function rosterChangedResponse(
	dependencies: GlobalTodayDependencies,
	day: TodayBriefDayBoundary,
	finalRoster: readonly MailboxRow[],
): GlobalTodayReadyResponse & { retryForRosterChange: true } {
	return {
		state: "ready",
		complete: false,
		accessChanged: true,
		day,
		currentMailboxCount: finalRoster.length,
		mailboxes: [],
		failures: [],
		totals: null,
		generatedAt: new Date(dependencies.now()).toISOString(),
		retryForRosterChange: true,
	};
}

async function withMailboxTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new GlobalTodayMailboxTimeoutError()),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function mapWithConcurrency<T, TResult>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;
	async function run() {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await worker(items[index]!);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
	return results;
}

async function listAllReminders(
	dependencies: GlobalTodayDependencies,
	actorUserId: string,
	roster: readonly MailboxRow[],
) {
	const reminders: FollowUpReminder[] = [];
	for (const mailbox of roster) {
		let cursor: ReminderCursor = null;
		do {
			const page = await dependencies.listReminderPage({
				actorUserId,
				mailboxId: mailbox.address,
				limit: GLOBAL_TODAY_LIMITS.reminderPageSize,
				cursor,
			});
			reminders.push(...page.reminders);
			if (reminders.length > GLOBAL_TODAY_LIMITS.reminders) {
				return { reminders, overflow: true as const };
			}
			cursor = page.nextCursor;
		} while (cursor);
	}
	reminders.sort(globalTodayReminderOrder);
	return { reminders, overflow: false as const };
}

async function runAttempt(
	dependencies: GlobalTodayDependencies,
	actorUserId: string,
	day: TodayBriefDayBoundary,
	readBudget: GlobalTodayReadBudget,
): Promise<GlobalTodayResponse & { retryForRosterChange?: boolean }> {
	const initialRoster = orderedRoster(await dependencies.listAccessibleMailboxes(actorUserId));
	if (initialRoster.length > GLOBAL_TODAY_LIMITS.mailboxes) {
		const finalRoster = orderedRoster(await dependencies.listAccessibleMailboxes(actorUserId));
		if (rosterFingerprint(initialRoster) !== rosterFingerprint(finalRoster)) {
			return rosterChangedResponse(dependencies, day, finalRoster);
		}
		return { state: "capacity_exceeded", resource: "mailboxes", limit: GLOBAL_TODAY_LIMITS.mailboxes, actual: initialRoster.length };
	}
	const reminderResult = await listAllReminders(dependencies, actorUserId, initialRoster);
	if (reminderResult.overflow) {
		const finalRoster = orderedRoster(await dependencies.listAccessibleMailboxes(actorUserId));
		if (rosterFingerprint(initialRoster) !== rosterFingerprint(finalRoster)) {
			return rosterChangedResponse(dependencies, day, finalRoster);
		}
		return { state: "capacity_exceeded", resource: "reminders", limit: GLOBAL_TODAY_LIMITS.reminders, actual: reminderResult.reminders.length };
	}
	const remindersByMailbox = new Map<string, FollowUpReminder[]>();
	for (const reminder of reminderResult.reminders) {
		const current = remindersByMailbox.get(reminder.mailboxAddress) ?? [];
		current.push(reminder);
		remindersByMailbox.set(reminder.mailboxAddress, current);
	}

	const outcomes = await mapWithConcurrency(initialRoster, GLOBAL_TODAY_LIMITS.concurrency, async (mailbox) => {
		try {
			const reminders = remindersByMailbox.get(mailbox.address) ?? [];
			if (readBudget.unsettled >= GLOBAL_TODAY_LIMITS.concurrency) {
				throw new GlobalTodayMailboxTimeoutError();
			}
			readBudget.unsettled += 1;
			const read = dependencies.readMailbox({
				mailboxId: mailbox.address,
				baselineMessageIds: reminders.map((reminder) => reminder.baselineMessageId),
			});
			void read.finally(() => { readBudget.unsettled -= 1; }).catch(() => {});
			const pulse = await withMailboxTimeout(read, dependencies.mailboxTimeoutMs ?? GLOBAL_TODAY_LIMITS.mailboxTimeoutMs);
			if (!(await dependencies.canAccessMailbox(actorUserId, mailbox.address))) {
				return { kind: "revoked" as const, mailbox };
			}
			const previews = new Map(pulse.reminderPreviews.map((preview) => [preview.baselineMessageId, preview]));
			const snapshot: GlobalTodayMailboxSnapshot = {
				mailboxId: mailbox.address,
				address: mailbox.address,
				type: mailbox.type,
				reminders: reminders.map((reminder) => {
					const preview = previews.get(reminder.baselineMessageId);
					return { ...reminder, preview: preview ? { subject: preview.subject, counterparty: preview.counterparty } : null };
				}),
				unreadConversationCount: pulse.unreadConversationCount,
				unreadPreviews: pulse.unreadPreviews,
			};
			return { kind: "success" as const, mailbox, snapshot };
		} catch (error) {
			return { kind: "failure" as const, mailbox, reason: error instanceof GlobalTodayMailboxTimeoutError ? "timeout" as const : "unavailable" as const };
		}
	});

	const finalRoster = orderedRoster(await dependencies.listAccessibleMailboxes(actorUserId));
	const finalAddresses = new Set(finalRoster.map((mailbox) => mailbox.address));
	const rosterChanged = rosterFingerprint(initialRoster) !== rosterFingerprint(finalRoster);
	const mailboxes: GlobalTodayMailboxSnapshot[] = [];
	const failures: GlobalTodayReadyResponse["failures"] = [];
	for (const outcome of outcomes) {
		if (!finalAddresses.has(outcome.mailbox.address)) continue;
		if (outcome.kind === "success") mailboxes.push(outcome.snapshot);
		if (outcome.kind === "failure") failures.push({
			mailboxId: outcome.mailbox.address,
			address: outcome.mailbox.address,
			type: outcome.mailbox.type,
			reason: outcome.reason,
		});
	}
	mailboxes.sort(globalTodayMailboxOrder);
	failures.sort(globalTodayMailboxOrder);
	const complete = !rosterChanged && mailboxes.length === finalRoster.length && failures.length === 0;
	const endAt = Date.parse(day.endAt);
	const totals = complete ? {
		privateRemindersDue: mailboxes.reduce((total, mailbox) => total + mailbox.reminders.filter(
			(reminder) => reminder.state === "active" && Date.parse(reminder.remindAt) < endAt,
		).length, 0),
		unreadConversations: mailboxes.reduce((total, mailbox) => total + mailbox.unreadConversationCount, 0),
	} : null;
	const response: GlobalTodayReadyResponse & { retryForRosterChange?: boolean } = {
		state: "ready",
		complete,
		accessChanged: rosterChanged || outcomes.some((outcome) => outcome.kind === "revoked"),
		day,
		currentMailboxCount: finalRoster.length,
		mailboxes,
		failures,
		totals,
		generatedAt: new Date(dependencies.now()).toISOString(),
	};
	if (rosterChanged) response.retryForRosterChange = true;
	return response;
}

export async function buildGlobalToday(
	dependencies: GlobalTodayDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary },
): Promise<GlobalTodayResponse> {
	const readBudget: GlobalTodayReadBudget = { unsettled: 0 };
	const first = await runAttempt(dependencies, input.actorUserId, input.day, readBudget);
	if (first.state !== "ready" || !first.retryForRosterChange) return first;
	const second = await runAttempt(dependencies, input.actorUserId, input.day, readBudget);
	if (second.state !== "ready") return second;
	const { retryForRosterChange: _ignored, ...response } = second;
	return { ...response, accessChanged: true };
}

export function createGlobalTodayDependencies(env: Env): GlobalTodayDependencies {
	const access = mailboxAccess(env);
	const reminders = followUpReminderD1Store(env);
	return {
		listAccessibleMailboxes: (actorUserId) => access.listAccessibleMailboxes(actorUserId),
		canAccessMailbox: (actorUserId, mailboxId) => access.canAccessMailbox(actorUserId, mailboxId),
		listReminderPage: ({ actorUserId, mailboxId, limit, cursor }) => reminders.list({ ownerUserId: actorUserId, mailboxAddress: mailboxId, limit, cursor }),
		readMailbox: ({ mailboxId, baselineMessageIds }) => {
			// Cloudflare Durable Object error handling docs note that an exception can
			// leave a stub broken. Each aggregate read creates one fresh, single-use stub.
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
			return stub.getGlobalTodaySnapshot(mailboxId, baselineMessageIds);
		},
		mailboxTimeoutMs: GLOBAL_TODAY_LIMITS.mailboxTimeoutMs,
		now: Date.now,
	};
}
