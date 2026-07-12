import {
	normalizeGlobalTodayBriefInput,
	type GlobalTodayBriefCounts,
	type GlobalTodayBriefPublicCandidate,
	type NormalizedGlobalTodayBriefInput,
} from "../../shared/global-today-brief.ts";
import { TODAY_BRIEF_LIMITS, type TodayBriefCandidateInput } from "../../shared/today-brief.ts";
import type {
	GlobalTodayBriefCandidateMetadata,
	GlobalTodayBriefMailboxEvidence,
	GlobalTodayBriefMailboxMetadata,
} from "./today-brief-candidates.ts";

export type GlobalTodayBriefMailboxCandidateSource = {
	mailboxId: string;
	address: string;
	type: "PERSONAL" | "SHARED";
	metadata: GlobalTodayBriefMailboxMetadata;
};

export type SelectedGlobalTodayBriefCandidate = {
	mailbox: GlobalTodayBriefMailboxCandidateSource;
	candidate: GlobalTodayBriefCandidateMetadata;
};

export type GlobalTodayBriefCandidateAuthority = {
	publicCandidate: GlobalTodayBriefPublicCandidate;
	conversationKey: string;
	evidence: Map<string, { mailboxId: string; messageId: string }>;
};

export type PreparedGlobalTodayBriefCandidates = {
	input: NormalizedGlobalTodayBriefInput;
	counts: GlobalTodayBriefCounts;
	omittedCount: number;
	authority: Map<string, GlobalTodayBriefCandidateAuthority>;
	authorityFingerprintInput: unknown;
};

const GLOBAL_MODEL_TEXT_BYTES = {
	subject: 240,
	counterparty: 200,
	sender: 200,
	messageText: 600,
} as const;

function truncateUtf8(value: string, maximumBytes: number) {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= maximumBytes) return value;
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const size = encoder.encode(character).byteLength;
		if (bytes + size > maximumBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

function reminderGroup(candidate: GlobalTodayBriefCandidateMetadata) {
	if (candidate.reasons.includes("overdue_reminder")) return 0;
	if (candidate.reasons.includes("today_reminder")) return 1;
	return 2;
}

function reminderOrder(left: SelectedGlobalTodayBriefCandidate, right: SelectedGlobalTodayBriefCandidate) {
	return reminderGroup(left.candidate) - reminderGroup(right.candidate) ||
		Date.parse(left.candidate.reminder!.dueAt) - Date.parse(right.candidate.reminder!.dueAt) ||
		left.mailbox.address.localeCompare(right.mailbox.address) ||
		left.candidate.conversationKey.localeCompare(right.candidate.conversationKey);
}

function unreadRoundOrder(left: SelectedGlobalTodayBriefCandidate, right: SelectedGlobalTodayBriefCandidate) {
	return Date.parse(right.candidate.latestMessageAt) - Date.parse(left.candidate.latestMessageAt) ||
		left.mailbox.address.localeCompare(right.mailbox.address) ||
		left.candidate.conversationKey.localeCompare(right.candidate.conversationKey);
}

function compoundKey(candidate: SelectedGlobalTodayBriefCandidate) {
	return `${candidate.mailbox.mailboxId}\n${candidate.candidate.conversationKey}`;
}

export function selectGlobalTodayBriefCandidates(
	mailboxes: readonly GlobalTodayBriefMailboxCandidateSource[],
): SelectedGlobalTodayBriefCandidate[] {
	const all = mailboxes.flatMap((mailbox) => mailbox.metadata.candidates.map((candidate) => ({ mailbox, candidate })));
	const selected: SelectedGlobalTodayBriefCandidate[] = [];
	const selectedKeys = new Set<string>();
	for (const candidate of all.filter((item) => item.candidate.reminder !== null).sort(reminderOrder)) {
		if (selected.length >= TODAY_BRIEF_LIMITS.candidates) break;
		selected.push(candidate);
		selectedKeys.add(compoundKey(candidate));
	}
	if (selected.length >= TODAY_BRIEF_LIMITS.candidates) return selected;

	const unreadByMailbox = mailboxes.map((mailbox) => ({
		mailbox,
		candidates: mailbox.metadata.candidates
			.filter((candidate) => candidate.unreadInMailbox && !selectedKeys.has(`${mailbox.mailboxId}\n${candidate.conversationKey}`))
			.sort((left, right) => Date.parse(right.latestMessageAt) - Date.parse(left.latestMessageAt) || left.conversationKey.localeCompare(right.conversationKey)),
	}));
	for (let round = 0; selected.length < TODAY_BRIEF_LIMITS.candidates; round += 1) {
		const roundCandidates = unreadByMailbox.flatMap(({ mailbox, candidates }) => {
			const candidate = candidates[round];
			return candidate ? [{ mailbox, candidate }] : [];
		}).sort(unreadRoundOrder);
		if (roundCandidates.length === 0) break;
		for (const candidate of roundCandidates) {
			if (selected.length >= TODAY_BRIEF_LIMITS.candidates) break;
			selected.push(candidate);
			selectedKeys.add(compoundKey(candidate));
		}
	}
	return selected;
}

export function prepareGlobalTodayBriefCandidates(input: {
	localDate: string;
	timezone: string;
	mailboxes: readonly GlobalTodayBriefMailboxCandidateSource[];
	evidenceByMailbox: ReadonlyMap<string, GlobalTodayBriefMailboxEvidence>;
}): PreparedGlobalTodayBriefCandidates {
	const selected = selectGlobalTodayBriefCandidates(input.mailboxes);
	const counts = input.mailboxes.reduce<GlobalTodayBriefCounts>((total, mailbox) => ({
		privateRemindersDue: total.privateRemindersDue + mailbox.metadata.counts.privateRemindersDue,
		unreadConversations: total.unreadConversations + mailbox.metadata.counts.unreadConversations,
	}), { privateRemindersDue: 0, unreadConversations: 0 });
	const totalCandidateCount = input.mailboxes.reduce((total, mailbox) => total + mailbox.metadata.totalCandidateCount, 0);
	const omittedCount = Math.max(0, totalCandidateCount - selected.length);
	const authority = new Map<string, GlobalTodayBriefCandidateAuthority>();
	const candidates: TodayBriefCandidateInput[] = selected.map(({ mailbox, candidate }, candidateIndex) => {
		const candidateId = `candidate-${String(candidateIndex + 1).padStart(2, "0")}`;
		const evidence = input.evidenceByMailbox.get(mailbox.mailboxId);
		if (!evidence || evidence.sequence !== mailbox.metadata.sequence) {
			throw new Error("Global Today brief evidence sequence changed");
		}
		const messages = evidence.evidence.find((item) => item.conversationKey === candidate.conversationKey)?.messages ?? [];
		if (messages.length === 0) throw new Error("Global Today brief candidate evidence is incomplete");
		const evidenceAuthority = new Map<string, { mailboxId: string; messageId: string }>();
		const opaqueMessages = messages.map((message, messageIndex) => {
			const id = `evidence-${String(candidateIndex + 1).padStart(2, "0")}-${String(messageIndex + 1).padStart(2, "0")}`;
			evidenceAuthority.set(id, { mailboxId: mailbox.mailboxId, messageId: message.id });
			return {
				...message,
				id,
				sender: truncateUtf8(message.sender, GLOBAL_MODEL_TEXT_BYTES.sender),
				subject: truncateUtf8(message.subject, GLOBAL_MODEL_TEXT_BYTES.subject),
				text: truncateUtf8(message.text, GLOBAL_MODEL_TEXT_BYTES.messageText),
			};
		});
		const sourceIndex = messages.findIndex((message) => message.id === candidate.sourceEmailId);
		if (sourceIndex < 0) throw new Error("Global Today brief source evidence is incomplete");
		const sourceEmailId = opaqueMessages[sourceIndex]!.id;
		const publicCandidate: GlobalTodayBriefPublicCandidate = {
			candidateId,
			mailboxId: mailbox.mailboxId,
			mailboxAddress: mailbox.address,
			mailboxType: mailbox.type,
			sourceMessageId: candidate.sourceEmailId,
			subject: candidate.subject,
			counterparty: candidate.counterparty,
			reasons: [...candidate.reasons],
			...(candidate.reminder ? { remindAt: candidate.reminder.dueAt } : {}),
		};
		authority.set(candidateId, {
			publicCandidate,
			conversationKey: candidate.conversationKey,
			evidence: evidenceAuthority,
		});
		return {
			id: candidateId,
			conversationKey: `conversation-${String(candidateIndex + 1).padStart(2, "0")}`,
			sourceEmailId,
			subject: truncateUtf8(candidate.subject, GLOBAL_MODEL_TEXT_BYTES.subject),
			counterparty: truncateUtf8(candidate.counterparty, GLOBAL_MODEL_TEXT_BYTES.counterparty),
			reasons: [...candidate.reasons],
			reminder: candidate.reminder ? {
				id: `reminder-${String(candidateIndex + 1).padStart(2, "0")}`,
				version: candidate.reminder.version,
				state: "active",
				dueAt: candidate.reminder.dueAt,
			} : null,
			remindAt: candidate.reminder?.dueAt ?? null,
			unreadInMailbox: candidate.unreadInMailbox,
			messages: opaqueMessages,
		};
	});
	const normalized = normalizeGlobalTodayBriefInput({
		localDate: input.localDate,
		timezone: input.timezone,
		omittedCount,
		candidates,
	});
	return {
		input: normalized,
		counts,
		omittedCount,
		authority,
		authorityFingerprintInput: {
			mailboxes: input.mailboxes.map((mailbox) => ({
				mailboxId: mailbox.mailboxId,
				address: mailbox.address,
				type: mailbox.type,
				sequence: mailbox.metadata.sequence,
			})),
			selected: selected.map(({ mailbox, candidate }) => ({ mailboxId: mailbox.mailboxId, candidate })),
			evidence: [...input.evidenceByMailbox].map(([mailboxId, evidence]) => ({ mailboxId, evidence })),
		},
	};
}
