import { Folders, InternalFolders } from "../../shared/folders.ts";
import {
	RECIPIENT_MEMORY_LIMITS,
	RecipientMemoryOrigins,
	type RecipientSuggestion,
} from "../../shared/recipient-suggestions.ts";
import { normalizeMailAddress } from "./mail-address.ts";

type SqlValue = string | number | null;

export interface RecipientMemorySql {
	exec<T>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

export class RecipientMemoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecipientMemoryError";
	}
}

export type RecipientInteractionDirection = "sent" | "received";

const RECIPIENT_MEMORY_EXCLUDED_FOLDERS = new Set<string>([
	Folders.DRAFT,
	Folders.OUTBOX,
	InternalFolders.RETIRED_OUTBOUND,
	Folders.SPAM,
	Folders.TRASH,
]);

interface RecipientInteractionInput {
	sourceEmailId: string;
	direction: RecipientInteractionDirection;
	occurredAt: string;
	mailboxAddress: string;
	addresses: readonly string[];
}

function splitAddresses(value: string | null | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((address) => address.trim())
		.filter(Boolean);
}

export function storedRecipientAddresses(input: {
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
}): string[] {
	return [
		...splitAddresses(input.recipient),
		...splitAddresses(input.cc),
		...splitAddresses(input.bcc),
	];
}

export function recipientMemoryFolderEligible(folderId: string): boolean {
	return !RECIPIENT_MEMORY_EXCLUDED_FOLDERS.has(folderId);
}

export function storedEmailInteraction(
	input: {
		sender?: string | null;
		recipient?: string | null;
		cc?: string | null;
		bcc?: string | null;
	},
	mailboxAddress: string,
): { direction: RecipientInteractionDirection; addresses: string[] } {
	const outbound = normalizeMailAddress(input.sender ?? "") ===
		normalizeMailAddress(mailboxAddress);
	return {
		direction: outbound ? "sent" : "received",
		addresses: outbound
			? storedRecipientAddresses(input)
			: [input.sender ?? ""],
	};
}

function normalizedAddresses(
	addresses: readonly string[],
	mailboxAddress: string,
	mode: "reject" | "truncate" = "reject",
): string[] {
	const self = normalizeMailAddress(mailboxAddress);
	const normalized = new Set<string>();
	for (const value of addresses) {
		const address = normalizeMailAddress(value);
		if (!address || address === self) continue;
		normalized.add(address);
	}
	if (normalized.size > RECIPIENT_MEMORY_LIMITS.maxRecipientsPerMessage) {
		if (mode === "truncate") {
			return [...normalized].slice(
				0,
				RECIPIENT_MEMORY_LIMITS.maxRecipientsPerMessage,
			);
		}
		throw new RecipientMemoryError(
			`A message cannot contain more than ${RECIPIENT_MEMORY_LIMITS.maxRecipientsPerMessage} recipients`,
		);
	}
	return [...normalized];
}

export function recordRecipientInteractions(
	sql: RecipientMemorySql,
	input: RecipientInteractionInput,
): number {
	const addresses = normalizedAddresses(input.addresses, input.mailboxAddress);
	let inserted = 0;
	for (const address of addresses) {
		const rows = [...sql.exec<{ address: string }>(
			`INSERT OR IGNORE INTO recipient_interactions
				(source_email_id, address, direction, occurred_at)
			 VALUES (?1, ?2, ?3, ?4)
			 RETURNING address`,
			input.sourceEmailId,
			address,
			input.direction,
			input.occurredAt,
		)];
		inserted += rows.length;
	}
	return inserted;
}

interface SeedEmailRow {
	id: string;
	folder_id: string;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
}

export function seedRecipientInteractions(
	sql: RecipientMemorySql,
	mailboxAddress: string,
): { seeded: boolean; interactionCount: number } {
	const existing = [...sql.exec<{ value: string }>(
		"SELECT value FROM recipient_interaction_meta WHERE key = 'recent_seed_v1' LIMIT 1",
	)];
	if (existing.length > 0) return { seeded: false, interactionCount: 0 };

	const mailbox = normalizeMailAddress(mailboxAddress);
	if (!mailbox) throw new RecipientMemoryError("Mailbox address is invalid");
	const rows = [...sql.exec<SeedEmailRow>(
		`SELECT id, folder_id, sender, recipient, cc, bcc, date
		 FROM emails
		 WHERE recipient_memory_origin IN (?1, ?2)
		   AND folder_id NOT IN (?3, ?4, ?5, ?6, ?7)
		   AND date IS NOT NULL
		 ORDER BY date DESC, id DESC
		 LIMIT ?8`,
		RecipientMemoryOrigins.LIVE_INBOUND,
		RecipientMemoryOrigins.ACCEPTED_OUTBOUND,
		Folders.DRAFT,
		Folders.OUTBOX,
		InternalFolders.RETIRED_OUTBOUND,
		Folders.SPAM,
		Folders.TRASH,
		RECIPIENT_MEMORY_LIMITS.seedEmailRows,
	)];
	let interactionCount = 0;
	for (const row of rows) {
		if (interactionCount >= RECIPIENT_MEMORY_LIMITS.seedInteractions) break;
		const interaction = storedEmailInteraction(row, mailbox);
		const remaining = RECIPIENT_MEMORY_LIMITS.seedInteractions - interactionCount;
		const normalized = normalizedAddresses(
			interaction.addresses,
			mailbox,
			"truncate",
		)
			.slice(0, remaining);
		interactionCount += recordRecipientInteractions(sql, {
			sourceEmailId: row.id,
			direction: interaction.direction,
			occurredAt: row.date!,
			mailboxAddress: mailbox,
			addresses: normalized,
		});
	}
	sql.exec(
		`INSERT INTO recipient_interaction_meta (key, value)
		 VALUES ('recent_seed_v1', ?1)`,
		String(interactionCount),
	);
	return { seeded: true, interactionCount };
}

interface SuggestionRow {
	address: string;
	sent_count: number;
	received_count: number;
	last_sent_at: string | null;
	last_received_at: string | null;
}

export function readRecipientSuggestions(
	sql: RecipientMemorySql,
	mailboxAddress: string,
	query: string,
	limit: number,
): RecipientSuggestion[] {
	const mailbox = normalizeMailAddress(mailboxAddress);
	if (!mailbox) throw new RecipientMemoryError("Mailbox address is invalid");
	const prefix = query.trim().toLowerCase();
	if (prefix.length > RECIPIENT_MEMORY_LIMITS.queryChars) {
		throw new RecipientMemoryError("Recipient query is too long");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > RECIPIENT_MEMORY_LIMITS.resultLimit) {
		throw new RecipientMemoryError("Recipient result limit is invalid");
	}

	const rows = [...sql.exec<SuggestionRow>(
		`SELECT
			address,
			SUM(CASE WHEN direction = 'sent' THEN 1 ELSE 0 END) AS sent_count,
			SUM(CASE WHEN direction = 'received' THEN 1 ELSE 0 END) AS received_count,
			MAX(CASE WHEN direction = 'sent' THEN occurred_at END) AS last_sent_at,
			MAX(CASE WHEN direction = 'received' THEN occurred_at END) AS last_received_at
		 FROM recipient_interactions
		 WHERE address <> ?1
		   AND (?2 = '' OR instr(address, ?2) = 1)
		 GROUP BY address
		 ORDER BY
			CASE WHEN address = ?2 THEN 0 ELSE 1 END ASC,
			CASE WHEN MAX(CASE WHEN direction = 'sent' THEN occurred_at END) IS NULL THEN 1 ELSE 0 END ASC,
			MAX(CASE WHEN direction = 'sent' THEN occurred_at END) DESC,
			COUNT(*) DESC,
			CASE WHEN MAX(CASE WHEN direction = 'received' THEN occurred_at END) IS NULL THEN 1 ELSE 0 END ASC,
			MAX(CASE WHEN direction = 'received' THEN occurred_at END) DESC,
			address ASC
		 LIMIT ?3`,
		mailbox,
		prefix,
		limit,
	)];
	return rows.map((row) => ({
		address: row.address,
		sentCount: Number(row.sent_count),
		receivedCount: Number(row.received_count),
		lastSentAt: row.last_sent_at,
		lastReceivedAt: row.last_received_at,
	}));
}
