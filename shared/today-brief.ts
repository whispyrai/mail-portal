import { Folders, type FolderId } from "./folders.ts";

export const TODAY_BRIEF_LIMITS = {
	candidates: 12,
	focusItems: 5,
	messagesPerCandidate: 2,
	reasonsPerCandidate: 2,
	citationsPerItem: 4,
	idChars: 200,
	idBytes: 400,
	actorUserIdChars: 200,
	mailboxChars: 320,
	timezoneChars: 100,
	conversationKeyChars: 300,
	senderChars: 320,
	subjectChars: 500,
	messageTextChars: 2_000,
	messageTextBytes: 8_000,
	normalizedInputBytes: 48 * 1_024,
	untrustedEvidenceChars: 40 * 1_024,
	untrustedEvidenceBytes: 52 * 1_024,
	modelSystemChars: 6_000,
	modelSerializedBytes: 64 * 1_024,
	modelOutputBytes: 16 * 1_024,
	whyNowChars: 280,
	suggestedNextStepChars: 280,
} as const;

export const TODAY_BRIEF_ELIGIBLE_FOLDERS = [
	Folders.INBOX,
	Folders.SENT,
	Folders.ARCHIVE,
	Folders.SNOOZED,
] as const satisfies readonly FolderId[];

export type TodayBriefEligibleFolder =
	(typeof TODAY_BRIEF_ELIGIBLE_FOLDERS)[number];
export type TodayBriefCandidateReason =
	| "overdue_reminder"
	| "today_reminder"
	| "unread_in_mailbox";

export type TodayBriefReminderEvidence = {
	id: string;
	version: number;
	state: "active";
	dueAt: string;
};

export type TodayBriefMessageEvidence = {
	id: string;
	date: string;
	folderId: TodayBriefEligibleFolder;
	sender: string;
	subject: string;
	text: string;
};

export type TodayBriefCandidateInput = {
	id: string;
	conversationKey: string;
	sourceEmailId: string;
	subject: string;
	counterparty: string;
	reasons: readonly TodayBriefCandidateReason[];
	reminder?: TodayBriefReminderEvidence | null;
	remindAt?: string | null;
	unreadInMailbox: boolean;
	messages: readonly TodayBriefMessageEvidence[];
};

export type TodayBriefInput = {
	actorUserId: string;
	mailboxId: string;
	localDate: string;
	timezone: string;
	omittedCount: number;
	candidates: readonly TodayBriefCandidateInput[];
};

export type NormalizedTodayBriefInput = {
	version: 1;
	actorUserId: string;
	mailboxId: string;
	localDate: string;
	timezone: string;
	omittedCount: number;
	candidates: Array<{
		id: string;
		conversationKey: string;
		sourceEmailId: string;
		subject: string;
		counterparty: string;
		reasons: TodayBriefCandidateReason[];
		reminder: TodayBriefReminderEvidence | null;
		remindAt: string | null;
		unreadInMailbox: boolean;
		messages: TodayBriefMessageEvidence[];
	}>;
};

export type TodayBriefFocusItem = {
	candidateId: string;
	rank: number;
	whyNow: string;
	suggestedNextStep: string;
	messageIds: string[];
	requiresHumanReview: true;
};

export type TodayBriefGeneratedResult = {
	items: TodayBriefFocusItem[];
};

const encoder = new TextEncoder();
const ELIGIBLE_FOLDER_SET = new Set<string>(TODAY_BRIEF_ELIGIBLE_FOLDERS);
const REASON_ORDER: Record<TodayBriefCandidateReason, number> = {
	overdue_reminder: 0,
	today_reminder: 1,
	unread_in_mailbox: 2,
};
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/;
const HTML_PATTERN = /<\/?(?:html|body|script|style|iframe|object|embed|svg|img|a|p|div|br|table|form)\b/i;

function isCandidateReason(value: unknown): value is TodayBriefCandidateReason {
	return typeof value === "string" && value in REASON_ORDER;
}

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function normalizeBoundedText(
	value: string,
	label: string,
	limits: {
		chars: number;
		bytes?: number;
		allowNewlines?: boolean;
		allowEmpty?: boolean;
	},
): string {
	if (typeof value !== "string") throw new Error(`${label} must be text`);
	const normalized = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.trim();
	if (!normalized && !limits.allowEmpty) throw new Error(`${label} is required`);
	if (!limits.allowNewlines && normalized.includes("\n")) {
		throw new Error(`${label} must be a single line`);
	}
	if (
		normalized.length > limits.chars ||
		byteLength(normalized) > (limits.bytes ?? limits.chars * 4)
	) {
		throw new Error(`${label} exceeds its safe bound`);
	}
	return normalized;
}

function normalizeIdentifier(value: string, label: string): string {
	const id = normalizeBoundedText(value, label, {
		chars: TODAY_BRIEF_LIMITS.idChars,
		bytes: TODAY_BRIEF_LIMITS.idBytes,
	});
	if (!ID_PATTERN.test(id)) throw new Error(`${label} is invalid`);
	return id;
}

function normalizeInstant(value: string, label: string): string {
	const text = normalizeBoundedText(value, label, { chars: 40 });
	if (
		!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ||
		!Number.isFinite(Date.parse(text))
	) {
		throw new Error(`${label} must be an ISO-8601 instant`);
	}
	return new Date(text).toISOString();
}

function normalizeLocalDate(value: string): string {
	const localDate = normalizeBoundedText(value, "Today brief local date", {
		chars: 10,
	});
	if (!LOCAL_DATE_PATTERN.test(localDate)) {
		throw new Error("Today brief local date is invalid");
	}
	const [year, month, day] = localDate.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.toISOString().slice(0, 10) !== localDate) {
		throw new Error("Today brief local date is invalid");
	}
	return localDate;
}

function normalizeMessage(
	message: TodayBriefMessageEvidence,
	candidateId: string,
): TodayBriefMessageEvidence {
	const folderId = message.folderId?.trim().toLowerCase();
	if (!ELIGIBLE_FOLDER_SET.has(folderId)) {
		throw new Error(`Candidate ${candidateId} has ineligible mail evidence`);
	}
	const text = normalizeBoundedText(
		message.text,
		`Candidate ${candidateId} message text`,
		{
			chars: TODAY_BRIEF_LIMITS.messageTextChars,
			bytes: TODAY_BRIEF_LIMITS.messageTextBytes,
			allowNewlines: true,
			allowEmpty: true,
		},
	);
	if (HTML_PATTERN.test(text)) {
		throw new Error(`Candidate ${candidateId} message evidence must be plain text`);
	}
	return {
		id: normalizeIdentifier(message.id, `Candidate ${candidateId} message ID`),
		date: normalizeInstant(message.date, `Candidate ${candidateId} message date`),
		folderId: folderId as TodayBriefEligibleFolder,
		sender: normalizeBoundedText(
			message.sender,
			`Candidate ${candidateId} message sender`,
			{ chars: TODAY_BRIEF_LIMITS.senderChars },
		),
		subject: normalizeBoundedText(
			message.subject,
			`Candidate ${candidateId} message subject`,
			{
				chars: TODAY_BRIEF_LIMITS.subjectChars,
				allowNewlines: true,
				allowEmpty: true,
			},
		),
		text,
	};
}

export function normalizeTodayBriefInput(
	input: TodayBriefInput,
): NormalizedTodayBriefInput {
	if (!input || typeof input !== "object") {
		throw new Error("Today brief input is required");
	}
	if (!Array.isArray(input.candidates)) {
		throw new Error("Today brief candidates are required");
	}
	if (input.candidates.length > TODAY_BRIEF_LIMITS.candidates) {
		throw new Error("Today brief candidate count exceeds its safe bound");
	}
	if (!Number.isSafeInteger(input.omittedCount) || input.omittedCount < 0) {
		throw new Error("Today brief omitted count is invalid");
	}

	const actorUserId = normalizeBoundedText(
		input.actorUserId,
		"Today brief actor",
		{ chars: TODAY_BRIEF_LIMITS.actorUserIdChars },
	);
	const mailboxId = normalizeBoundedText(input.mailboxId, "Today brief mailbox", {
		chars: TODAY_BRIEF_LIMITS.mailboxChars,
	}).toLowerCase();
	const timezone = normalizeBoundedText(input.timezone, "Today brief timezone", {
		chars: TODAY_BRIEF_LIMITS.timezoneChars,
	});
	if (!TIMEZONE_PATTERN.test(timezone)) {
		throw new Error("Today brief timezone is invalid");
	}

	const seenCandidateIds = new Set<string>();
	const seenEvidenceMessageIds = new Set<string>();
	const candidates = input.candidates.map((candidate) => {
		const id = normalizeIdentifier(candidate.id, "Today brief candidate ID");
		if (seenCandidateIds.has(id)) {
			throw new Error(`Duplicate Today brief candidate ID: ${id}`);
		}
		seenCandidateIds.add(id);
		if (!Array.isArray(candidate.reasons) || candidate.reasons.length === 0) {
			throw new Error(`Candidate ${id} requires a reason`);
		}
		const rawReasons = [...new Set<unknown>(candidate.reasons)];
		if (
			rawReasons.length !== candidate.reasons.length ||
			rawReasons.length > TODAY_BRIEF_LIMITS.reasonsPerCandidate ||
			!rawReasons.every(isCandidateReason)
		) {
			throw new Error(`Candidate ${id} reasons are invalid`);
		}
		const reasons: TodayBriefCandidateReason[] = rawReasons;
		reasons.sort((left, right) => REASON_ORDER[left] - REASON_ORDER[right]);
		const reminderReasons = reasons.filter((reason) => reason !== "unread_in_mailbox");
		if (reminderReasons.length > 1) {
			throw new Error(`Candidate ${id} has conflicting reminder reasons`);
		}
		if (reasons.includes("unread_in_mailbox") !== candidate.unreadInMailbox) {
			throw new Error(`Candidate ${id} unread state does not match its reasons`);
		}
		const rawReminder = candidate.reminder ?? null;
		if ((reminderReasons.length === 1) !== (rawReminder !== null)) {
			throw new Error(`Candidate ${id} reminder state does not match its reasons`);
		}
		const reminder = rawReminder
			? {
					id: normalizeIdentifier(rawReminder.id, `Candidate ${id} reminder ID`),
					version: rawReminder.version,
					state: rawReminder.state,
					dueAt: normalizeInstant(rawReminder.dueAt, `Candidate ${id} reminder due time`),
				}
			: null;
		if (
			reminder &&
			(!Number.isSafeInteger(reminder.version) ||
				reminder.version < 1 ||
				reminder.state !== "active")
		) {
			throw new Error(`Candidate ${id} reminder is invalid`);
		}
		const remindAt =
			candidate.remindAt === undefined
				? (reminder?.dueAt ?? null)
				: candidate.remindAt
					? normalizeInstant(candidate.remindAt, `Candidate ${id} remind time`)
					: null;
		if ((reminder?.dueAt ?? null) !== remindAt) {
			throw new Error(`Candidate ${id} remind time does not match its reminder`);
		}
		if (
			!Array.isArray(candidate.messages) ||
			candidate.messages.length === 0 ||
			candidate.messages.length > TODAY_BRIEF_LIMITS.messagesPerCandidate
		) {
			throw new Error(`Candidate ${id} evidence count is invalid`);
		}
		const seenMessageIds = new Set<string>();
		const messages = candidate.messages.map((message) => {
			const normalized = normalizeMessage(message, id);
			if (seenMessageIds.has(normalized.id)) {
				throw new Error(`Candidate ${id} has duplicate message evidence`);
			}
			if (seenEvidenceMessageIds.has(normalized.id)) {
				throw new Error(`Message ${normalized.id} belongs to multiple Today brief candidates`);
			}
			seenMessageIds.add(normalized.id);
			seenEvidenceMessageIds.add(normalized.id);
			return normalized;
		});
		messages.sort(
			(left, right) =>
				left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
		);
		return {
			id,
			conversationKey: normalizeBoundedText(
				candidate.conversationKey,
				`Candidate ${id} conversation key`,
				{ chars: TODAY_BRIEF_LIMITS.conversationKeyChars },
			),
			sourceEmailId: normalizeIdentifier(
				candidate.sourceEmailId,
				`Candidate ${id} source email ID`,
			),
			subject: normalizeBoundedText(candidate.subject, `Candidate ${id} subject`, {
				chars: TODAY_BRIEF_LIMITS.subjectChars,
				allowNewlines: true,
				allowEmpty: true,
			}),
			counterparty: normalizeBoundedText(
				candidate.counterparty,
				`Candidate ${id} counterparty`,
				{ chars: TODAY_BRIEF_LIMITS.senderChars, allowEmpty: true },
			),
			reasons,
			reminder,
			remindAt,
			unreadInMailbox: candidate.unreadInMailbox,
			messages,
		};
	});

	const normalized: NormalizedTodayBriefInput = {
		version: 1,
		actorUserId,
		mailboxId,
		localDate: normalizeLocalDate(input.localDate),
		timezone,
		omittedCount: input.omittedCount,
		candidates,
	};
	if (byteLength(JSON.stringify(normalized)) > TODAY_BRIEF_LIMITS.normalizedInputBytes) {
		throw new Error("Today brief input exceeds its safe UTF-8 bound");
	}
	return normalized;
}
