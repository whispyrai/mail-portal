import { Folders, isInternalFolderId } from "../../shared/folders.ts";
import { authoredRelationshipBriefText } from "./relationship-brief-evidence.ts";

export const SEMANTIC_MESSAGE_POLICY_VERSION = 1;
export const SEMANTIC_MESSAGE_CHUNK_VERSION = 1;
export const SEMANTIC_EMBEDDING_MODEL = "@cf/baai/bge-m3" as const;

export const SEMANTIC_MESSAGE_LIMITS = {
	subjectChars: 500,
	participantChars: 1_000,
	bodyChars: 24_000,
	chunkChars: 1_200,
	chunkOverlapChars: 200,
	chunksPerMessage: 20,
	vectorIdChars: 64,
} as const;

const EXCLUDED_FOLDERS = new Set<string>([
	Folders.DRAFT,
	Folders.OUTBOX,
	Folders.TRASH,
	Folders.SPAM,
]);

export type SemanticMessageSource = {
	id: string;
	folderId: string;
	subject: string;
	sender: string;
	recipient: string;
	cc: string;
	bcc: string;
	date: string;
	body: string;
	semanticVersion: number;
};

export type SemanticMessageChunk = {
	ordinal: number;
	embeddingText: string;
	excerpt: string;
};

function normalizedText(value: string, maximum: number): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/[\u0080-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/gu, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, maximum);
}

export function semanticMessageEligible(folderId: string): boolean {
	return Boolean(folderId) && !isInternalFolderId(folderId) && !EXCLUDED_FOLDERS.has(folderId);
}

export function semanticMessageChunks(source: SemanticMessageSource): SemanticMessageChunk[] {
	if (!semanticMessageEligible(source.folderId)) return [];
	const subject = normalizedText(source.subject, SEMANTIC_MESSAGE_LIMITS.subjectChars);
	const participants = normalizedText(
		[source.sender, source.recipient, source.cc, source.bcc].filter(Boolean).join(" | "),
		SEMANTIC_MESSAGE_LIMITS.participantChars,
	);
	const body = normalizedText(
		authoredRelationshipBriefText(source.body),
		SEMANTIC_MESSAGE_LIMITS.bodyChars,
	);
	const searchable = [subject, participants, body].filter(Boolean).join("\n");
	if (!searchable) return [];

	const chunks: SemanticMessageChunk[] = [];
	let start = 0;
	while (
		start < searchable.length &&
		chunks.length < SEMANTIC_MESSAGE_LIMITS.chunksPerMessage
	) {
		let end = Math.min(start + SEMANTIC_MESSAGE_LIMITS.chunkChars, searchable.length);
		if (end < searchable.length) {
			const boundary = searchable.lastIndexOf(" ", end);
			if (boundary > start + SEMANTIC_MESSAGE_LIMITS.chunkChars / 2) end = boundary;
		}
		const excerpt = searchable.slice(start, end).trim();
		if (excerpt) {
			chunks.push({
				ordinal: chunks.length,
				embeddingText: excerpt,
				excerpt,
			});
		}
		if (end >= searchable.length) break;
		start = Math.max(end - SEMANTIC_MESSAGE_LIMITS.chunkOverlapChars, start + 1);
	}
	return chunks;
}

export function semanticVectorId(sourceToken: string, ordinal: number): string {
	if (!/^[a-f0-9]{32}$/.test(sourceToken)) {
		throw new Error("Semantic source token is invalid");
	}
	if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 100) {
		throw new Error("Semantic chunk ordinal is invalid");
	}
	return `sm1_${sourceToken}_${ordinal.toString(36).padStart(2, "0")}`;
}

export async function semanticSourceFingerprint(source: SemanticMessageSource): Promise<string> {
	const canonical = JSON.stringify({
		policyVersion: SEMANTIC_MESSAGE_POLICY_VERSION,
		chunkVersion: SEMANTIC_MESSAGE_CHUNK_VERSION,
		id: source.id,
		subject: normalizedText(source.subject, SEMANTIC_MESSAGE_LIMITS.subjectChars),
		sender: normalizedText(source.sender, 320),
		recipient: normalizedText(source.recipient, 320),
		cc: normalizedText(source.cc, 1_000),
		bcc: normalizedText(source.bcc, 1_000),
		date: normalizedText(source.date, 64),
		body: normalizedText(source.body, SEMANTIC_MESSAGE_LIMITS.bodyChars),
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function semanticMailboxNamespace(
	environment: string,
	mailboxId: string,
): Promise<string> {
	const canonical = `${environment.trim().toLowerCase()}\u0000${mailboxId.trim().toLowerCase()}`;
	if (!environment.trim() || !mailboxId.trim()) {
		throw new Error("Semantic namespace requires environment and Mailbox identity");
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	const token = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `mb1_${token.slice(0, 48)}`;
}
