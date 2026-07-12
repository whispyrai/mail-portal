export const RECIPIENT_MEMORY_LIMITS = {
	queryChars: 320,
	resultLimit: 20,
	maxRecipientsPerMessage: 50,
	seedInteractions: 2_000,
	seedEmailRows: 2_000,
} as const;

/** Durable provenance for deciding whether a stored email may teach recipient memory. */
export const RecipientMemoryOrigins = {
	LIVE_INBOUND: "live_inbound",
	ACCEPTED_OUTBOUND: "accepted_outbound",
	ADMIN_IMPORT: "admin_import",
} as const;

export type RecipientMemoryOrigin =
	(typeof RecipientMemoryOrigins)[keyof typeof RecipientMemoryOrigins];

export interface RecipientSuggestion {
	address: string;
	sentCount: number;
	receivedCount: number;
	lastSentAt: string | null;
	lastReceivedAt: string | null;
}

export interface RecipientSuggestionResponse {
	suggestions: RecipientSuggestion[];
}
