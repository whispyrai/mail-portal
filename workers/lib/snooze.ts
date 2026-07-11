import { z } from "zod";
import { Folders, InternalFolders } from "../../shared/folders.ts";

export const SNOOZED_FOLDER_ID = "snoozed";
export const MIN_SNOOZE_DELAY_MS = 60_000;
export const MAX_SNOOZE_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_SNOOZE_TARGETS = 100;

export class SnoozeValidationError extends Error {
	constructor(message = "Snooze request is invalid") {
		super(message);
		this.name = "SnoozeValidationError";
	}
}

const boundedId = z.string().trim().min(1).max(256);
const SnoozeScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("message"), emailId: boundedId }).strict(),
	z.object({
		kind: z.literal("conversation"),
		conversationId: boundedId,
		emailId: boundedId,
		folderId: z.string().trim().min(1).max(128),
	}).strict(),
]);
const SnoozeRequestSchema = z.object({
	scope: SnoozeScopeSchema,
	wakeAt: z.string().max(40),
}).strict();

export type SnoozeRequest = z.infer<typeof SnoozeRequestSchema>;

export function normalizeSnoozeScope(input: unknown): SnoozeRequest["scope"] {
	const parsed = SnoozeScopeSchema.safeParse(input);
	if (!parsed.success) throw new SnoozeValidationError();
	return parsed.data;
}

export function normalizeSnoozeRequest(input: unknown, now = Date.now()): SnoozeRequest {
	const parsed = SnoozeRequestSchema.safeParse(input);
	if (!parsed.success) throw new SnoozeValidationError();
	const timestamp = Date.parse(parsed.data.wakeAt);
	if (
		!Number.isFinite(timestamp) ||
		timestamp < now + MIN_SNOOZE_DELAY_MS ||
		timestamp > now + MAX_SNOOZE_DELAY_MS
	) {
		throw new SnoozeValidationError("Wake time is outside the supported range");
	}
	return { ...parsed.data, wakeAt: new Date(timestamp).toISOString() };
}

const BLOCKED_SOURCE_FOLDERS = new Set<string>([
	SNOOZED_FOLDER_ID,
	Folders.SENT,
	Folders.DRAFT,
	Folders.OUTBOX,
	Folders.TRASH,
	Folders.SPAM,
	InternalFolders.RETIRED_OUTBOUND,
]);

export function isSnoozeSourceFolder(folderId: string | null | undefined): boolean {
	return Boolean(
		folderId &&
			!folderId.startsWith("_") &&
			!BLOCKED_SOURCE_FOLDERS.has(folderId),
	);
}

export function resolveUnsnoozeFolder(
	sourceFolderId: string | null | undefined,
	sourceFolderExists: boolean,
): string {
	return sourceFolderExists && isSnoozeSourceFolder(sourceFolderId)
		? sourceFolderId!
		: Folders.INBOX;
}

export interface SnoozedWakeRow {
	id: string;
	sourceFolderId: string | null;
	wakeAt: string;
}

export function planDueSnoozeWake(
	rows: SnoozedWakeRow[],
	now: number,
	folderExists: (folderId: string) => boolean,
) {
	const wake: Array<{ id: string; folderId: string }> = [];
	let nextWakeAt: number | null = null;
	for (const row of rows.slice(0, MAX_SNOOZE_TARGETS)) {
		const timestamp = Date.parse(row.wakeAt);
		if (!Number.isFinite(timestamp) || timestamp <= now) {
			wake.push({
				id: row.id,
				folderId: resolveUnsnoozeFolder(
					row.sourceFolderId,
					Boolean(row.sourceFolderId && folderExists(row.sourceFolderId)),
				),
			});
			continue;
		}
		nextWakeAt = nextWakeAt === null ? timestamp : Math.min(nextWakeAt, timestamp);
	}
	for (const overflow of rows.slice(MAX_SNOOZE_TARGETS)) {
		const timestamp = Date.parse(overflow.wakeAt);
		if (!Number.isFinite(timestamp) || timestamp <= now) {
			nextWakeAt = now;
			break;
		}
		nextWakeAt = nextWakeAt === null ? timestamp : Math.min(nextWakeAt, timestamp);
	}
	return { wake, nextWakeAt };
}

export function planIncomingReplyWake(
	threadId: string | null | undefined,
	rows: Array<{ id: string; threadId: string | null; sourceFolderId: string | null }>,
): { wake: Array<{ id: string; folderId: string }>; hasMore: boolean } {
	if (!threadId) return { wake: [], hasMore: false };
	const matches = rows.filter((row) => row.threadId === threadId);
	return {
		wake: matches.slice(0, MAX_SNOOZE_TARGETS).map((row) => ({
			id: row.id,
			// The incoming reply itself arrives in Inbox. Wake the hidden messages
			// there too so the active conversation is not split across old sources.
			folderId: Folders.INBOX,
		})),
		hasMore: matches.length > MAX_SNOOZE_TARGETS,
	};
}

export function snoozeBlocksGenericMove(row: {
	folderId: string;
	wakeAt: string | null | undefined;
	sourceFolderId?: string | null | undefined;
}): boolean {
	return row.folderId === SNOOZED_FOLDER_ID || Boolean(row.wakeAt) || Boolean(row.sourceFolderId);
}

export function earliestMailboxAlarm(
	candidates: Array<number | null | undefined>,
): number | null {
	let earliest: number | null = null;
	for (const candidate of candidates) {
		if (!Number.isFinite(candidate) || candidate! < 0) continue;
		earliest = earliest === null ? candidate! : Math.min(earliest, candidate!);
	}
	return earliest;
}
