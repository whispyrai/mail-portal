import { z } from "zod";

export const SEMANTIC_SEARCH_LIMITS = {
	queryChars: 500,
	queryBytes: 1_000,
	resultLimit: 20,
	excerptChars: 600,
	attachmentFilenameChars: 255,
	mailboxes: 20,
} as const;

export function truncateSemanticSearchText(
	value: string,
	maxCodeUnits: number,
): string {
	if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 1) {
		throw new Error("Semantic text bound is invalid");
	}
	let result = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		const scalar = codePoint >= 0xd800 && codePoint <= 0xdfff
			? "\uFFFD"
			: character;
		if (result.length + scalar.length > maxCodeUnits) break;
		result += scalar;
	}
	return result;
}

export const SEMANTIC_SEARCH_STATES = [
	"complete",
	"partial",
	"building",
	"unavailable",
] as const;

export type SemanticSearchState = (typeof SEMANTIC_SEARCH_STATES)[number];

export type SemanticSearchRequest = {
	query: string;
};

type SemanticSearchResultBase = {
	mailboxId: string;
	mailboxAddress: string;
	messageId: string;
	score: number;
	subject: string;
	counterparty: string;
	date: string;
	folderId: string;
	excerpt: string;
};

export type SemanticSearchResult = SemanticSearchResultBase & (
	| {
		source: "message";
		excerptKind: "authored_mail";
	}
	| {
		source: "attachment";
		attachmentId: string;
		attachmentFilename: string;
		excerptKind: "extracted_attachment";
	}
);

export type SemanticSearchMailboxStatus = {
	mailboxId: string;
	mailboxAddress: string;
	state: "complete" | "building" | "unavailable";
};

export type SemanticSearchResponse = {
	state: SemanticSearchState;
	accessChanged: boolean;
	results: SemanticSearchResult[];
	mailboxes: SemanticSearchMailboxStatus[];
};

const strictText = (maximum: number) => z.string().max(maximum);
const identifier = z.string().min(1).max(300).refine(
	(value) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
	"Semantic identifier contains an invalid Unicode scalar",
);
const mailboxAddress = z.string().min(3).max(320);

const requestSchema = z.object({
	query: z.string().trim().min(2).max(SEMANTIC_SEARCH_LIMITS.queryChars),
}).strict();

const resultBaseShape = {
	mailboxId: identifier,
	mailboxAddress,
	messageId: identifier,
	score: z.number().finite().min(0).max(1),
	subject: strictText(500),
	counterparty: strictText(320),
	date: strictText(64),
	folderId: strictText(200),
	excerpt: z.string().min(1).max(SEMANTIC_SEARCH_LIMITS.excerptChars),
};

const resultSchema = z.discriminatedUnion("source", [
	z.object({
		...resultBaseShape,
		source: z.literal("message"),
		excerptKind: z.literal("authored_mail"),
	}).strict(),
	z.object({
		...resultBaseShape,
		source: z.literal("attachment"),
		attachmentId: identifier,
		attachmentFilename: strictText(SEMANTIC_SEARCH_LIMITS.attachmentFilenameChars).min(1),
		excerptKind: z.literal("extracted_attachment"),
	}).strict(),
]);

const mailboxStatusSchema = z.object({
	mailboxId: identifier,
	mailboxAddress,
	state: z.enum(["complete", "building", "unavailable"]),
}).strict();

const responseSchema = z.object({
	state: z.enum(SEMANTIC_SEARCH_STATES),
	accessChanged: z.boolean(),
	results: z.array(resultSchema).max(SEMANTIC_SEARCH_LIMITS.resultLimit),
	mailboxes: z.array(mailboxStatusSchema).max(SEMANTIC_SEARCH_LIMITS.mailboxes),
}).strict().superRefine((value, context) => {
	const identities = new Set<string>();
	for (const result of value.results) {
		const identity = result.source === "message"
			? `${result.mailboxId}\u0000message\u0000${result.messageId}`
			: `${result.mailboxId}\u0000attachment\u0000${result.messageId}\u0000${result.attachmentId}`;
		if (identities.has(identity)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Semantic results contain a duplicate source identity",
			});
		}
		identities.add(identity);
	}

	const mailboxIds = new Set<string>();
	const mailboxById = new Map<string, SemanticSearchMailboxStatus>();
	for (const mailbox of value.mailboxes) {
		if (mailboxIds.has(mailbox.mailboxId)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Semantic response contains a duplicate Mailbox identity",
			});
		}
		mailboxIds.add(mailbox.mailboxId);
		mailboxById.set(mailbox.mailboxId, mailbox);
	}

	for (const result of value.results) {
		const mailbox = mailboxById.get(result.mailboxId);
		if (!mailbox) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Semantic result references an unknown Mailbox",
			});
			continue;
		}
		if (mailbox.state !== "complete" || mailbox.mailboxAddress !== result.mailboxAddress) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Semantic evidence requires an address-identical complete Mailbox",
			});
		}
	}

	const completeMailboxes = value.mailboxes.filter((mailbox) => mailbox.state === "complete").length;
	const buildingMailboxes = value.mailboxes.filter((mailbox) => mailbox.state === "building").length;
	const expectedState: SemanticSearchState = value.mailboxes.length === 0 ||
		completeMailboxes === value.mailboxes.length
		? "complete"
		: completeMailboxes > 0
			? "partial"
			: buildingMailboxes > 0
				? "building"
				: "unavailable";
	if (value.state !== expectedState) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Semantic response state contradicts its Mailbox readiness",
		});
	}
	if (value.state === "building" && value.results.length > 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Building semantic responses cannot expose partial evidence",
		});
	}
	if (value.state === "unavailable" && value.results.length > 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Unavailable semantic responses cannot expose evidence",
		});
	}
});

export function parseSemanticSearchRequest(value: unknown): SemanticSearchRequest {
	const parsed = requestSchema.parse(value);
	if (new TextEncoder().encode(parsed.query).byteLength > SEMANTIC_SEARCH_LIMITS.queryBytes) {
		throw new Error("Semantic search query exceeds its UTF-8 byte boundary");
	}
	return parsed;
}

export function parseSemanticSearchResponse(value: unknown): SemanticSearchResponse {
	return responseSchema.parse(value);
}
