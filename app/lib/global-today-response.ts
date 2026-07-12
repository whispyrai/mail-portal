import { z } from "zod";
import type { GlobalTodayResponse } from "../../shared/global-today.ts";

const id = z.string().min(1).max(500);
const timestamp = z.string().datetime({ offset: true });
const reminderPreview = z.object({
	subject: z.string().max(300),
	counterparty: z.string().max(500),
}).strict().nullable();
const reminder = z.object({
	id,
	ownerUserId: id,
	mailboxAddress: z.string().email().max(320),
	conversationKey: id,
	baselineMessageId: id,
	baselineMessageDate: timestamp,
	remindAt: timestamp,
	state: z.enum(["active", "completed", "dismissed"]),
	resolutionReason: z.enum(["manual", "dismissed", "inbound_reply"]).nullable(),
	version: z.number().int().positive(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	resolvedAt: z.number().int().nonnegative().nullable(),
	preview: reminderPreview,
}).strict();
const unreadPreview = z.object({
	messageId: id,
	conversationKey: id,
	sender: z.string().max(320),
	subject: z.string().max(300),
	date: timestamp,
}).strict();
const mailboxBase = {
	mailboxId: z.string().email().max(320),
	address: z.string().email().max(320),
	type: z.enum(["PERSONAL", "SHARED"]),
};
const ready = z.object({
	state: z.literal("ready"),
	complete: z.boolean(),
	accessChanged: z.boolean(),
	day: z.object({
		timeZone: z.string().min(1).max(100),
		localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
		startAt: timestamp,
		endAt: timestamp,
	}).strict(),
	currentMailboxCount: z.number().int().nonnegative(),
	mailboxes: z.array(z.object({
		...mailboxBase,
		reminders: z.array(reminder).max(500),
		unreadConversationCount: z.number().int().nonnegative(),
		unreadPreviews: z.array(unreadPreview).max(3),
	}).strict()).max(12),
	failures: z.array(z.object({
		...mailboxBase,
		reason: z.enum(["timeout", "unavailable"]),
	}).strict()).max(12),
	totals: z.object({
		privateRemindersDue: z.number().int().nonnegative(),
		unreadConversations: z.number().int().nonnegative(),
	}).strict().nullable(),
	generatedAt: timestamp,
}).strict();
const responseSchema = z.discriminatedUnion("state", [
	ready,
	z.object({
		state: z.literal("capacity_exceeded"),
		resource: z.enum(["mailboxes", "reminders"]),
		limit: z.number().int().positive(),
		actual: z.number().int().positive(),
	}).strict(),
]).superRefine((value, context) => {
	if (value.state !== "ready") return;
	if (value.complete && value.totals === null) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Complete Today requires totals" });
	}
	if (!value.complete && value.totals !== null) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Partial Today cannot expose totals" });
	}
	const identities = [...value.mailboxes, ...value.failures].map((mailbox) => mailbox.mailboxId);
	if (new Set(identities).size !== identities.length) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Mailbox identities must be unique" });
	}
});

export function parseGlobalTodayResponse(value: unknown): GlobalTodayResponse {
	return responseSchema.parse(value) as GlobalTodayResponse;
}
