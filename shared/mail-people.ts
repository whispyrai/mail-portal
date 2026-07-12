import { decodeBase64Url } from "./base64url.ts";

export const MAIL_PEOPLE_LIMITS = {
	queryChars: 200,
	resultLimit: 50,
	cursorChars: 1_024,
	identifierChars: 320,
	displayNameChars: 160,
	subjectChars: 1_000,
	filenameChars: 500,
	mimetypeChars: 255,
	backfillBatchSize: 100,
	replayPageSize: 100,
	retryAfterMs: 750,
	recentConversationLimit: 12,
	timelineAttachmentsPerMessage: 20,
} as const;

export const MAIL_PEOPLE_SORTS = ["recent", "frequent", "address"] as const;
export type MailPeopleSort = (typeof MAIL_PEOPLE_SORTS)[number];
export type MailPersonDirection = "sent" | "received";
export type MailPersonRole = "from" | "to" | "cc" | "bcc";
export type MailPersonOrigin = "live_inbound" | "accepted_outbound" | "admin_import";
export type MailPersonNameProvenance = "live" | "imported" | "none";

export type MailPeopleBuildingResponse = {
	status: "building";
	schemaVersion: 1;
	processedMessages: number;
	retryAfterMs: number;
};

export type MailPersonSummary = {
	id: string;
	address: string;
	domain: string;
	displayName: string | null;
	nameProvenance: MailPersonNameProvenance;
	firstInteractionAt: string;
	lastInteractionAt: string;
	lastInboundAt: string | null;
	lastOutboundAt: string | null;
	receivedCount: number;
	sentCount: number;
	conversationCount: number;
	attachmentCount: number;
	importedMessageCount: number;
	latestDirection: MailPersonDirection;
};

export type MailPeopleListReadyResponse = {
	status: "ready";
	people: MailPersonSummary[];
	nextCursor: string | null;
};

export type MailPeopleListResponse =
	| MailPeopleBuildingResponse
	| MailPeopleListReadyResponse;

export type MailPersonConversationSummary = {
	conversationId: string;
	representativeMessageId: string;
	representativeFolderId: string;
	subject: string;
	latestAt: string;
	latestDirection: MailPersonDirection;
	messageCount: number;
	unreadCount: number;
	attachmentCount: number;
};

export type MailPersonDetail = MailPersonSummary & {
	conversations: MailPersonConversationSummary[];
};

export type MailPersonDetailResponse =
	| MailPeopleBuildingResponse
	| { status: "ready"; person: MailPersonDetail | null };

export type MailPersonTimelineAttachment = {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
};

export type MailPersonTimelineItem = {
	messageId: string;
	conversationId: string;
	date: string;
	direction: MailPersonDirection;
	role: MailPersonRole;
	subject: string;
	folder: { id: string; name: string };
	origin: MailPersonOrigin;
	attachments: MailPersonTimelineAttachment[];
};

export type MailPersonTimelineResponse =
	| MailPeopleBuildingResponse
	| {
			status: "ready";
			personId: string;
			items: MailPersonTimelineItem[];
			nextCursor: string | null;
	  };

export type NormalizedMailPeopleListQuery = {
	q: string;
	sort: MailPeopleSort;
	limit: number;
	cursor: string | null;
};

export type NormalizedMailPersonTimelineQuery = {
	limit: number;
	cursor: string | null;
};

export type MailPeopleListCursor =
	| { sort: "recent"; lastInteractionAt: string; address: string }
	| { sort: "frequent"; messageCount: number; lastInteractionAt: string; address: string }
	| { sort: "address"; address: string };

export type MailPersonTimelineCursor = {
	date: string;
	messageId: string;
	role: MailPersonRole;
};

export class MailPeopleContractError extends Error {
	readonly code = "INVALID_QUERY";

	constructor(message: string) {
		super(message);
		this.name = "MailPeopleContractError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNSAFE_UNICODE =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/u;

export function hasUnsafeMailPeopleText(value: string): boolean {
	return UNSAFE_UNICODE.test(value);
}

function invalid(message: string): never {
	throw new MailPeopleContractError(message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function record(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(message);
	return value as Record<string, unknown>;
}

function boundedText(
	value: unknown,
	maximum: number,
	options: { nullable?: boolean; empty?: boolean } = {},
): string | null {
	if (options.nullable && value === null) return null;
	if (
		typeof value !== "string" ||
		(!options.empty && !value) ||
		value !== value.trim().normalize("NFC") ||
		UNSAFE_UNICODE.test(value) ||
		Array.from(value).length > maximum
	) invalid("People response is invalid");
	return value;
}

function canonicalAddress(value: unknown): string {
	const address = boundedText(value, MAIL_PEOPLE_LIMITS.identifierChars)!;
	const at = address.indexOf("@");
	if (
		address !== address.toLowerCase() ||
		at <= 0 ||
		at !== address.lastIndexOf("@") ||
		at === address.length - 1 ||
		/\s/u.test(address)
	) invalid("People response is invalid");
	return address;
}

/**
 * Match SQLite's explicit BINARY ordering for normalized UTF-8 addresses.
 * UTF-8 byte order preserves Unicode scalar-value order, while localeCompare
 * is locale-dependent and JavaScript's ordinary string comparison is UTF-16.
 */
export function compareCanonicalMailAddresses(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const difference = leftCodePoints[index]! - rightCodePoints[index]!;
		if (difference) return difference < 0 ? -1 : 1;
	}
	return leftCodePoints.length === rightCodePoints.length
		? 0
		: leftCodePoints.length < rightCodePoints.length ? -1 : 1;
}

function canonicalDate(value: unknown, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (typeof value !== "string") invalid("People response is invalid");
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
		invalid("People response is invalid");
	}
	return value;
}

function count(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) invalid("People response is invalid");
	return Number(value);
}

function encodeCursor(value: Record<string, unknown>): string {
	let binary = "";
	for (const byte of encoder.encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string): Record<string, unknown> {
	if (
		!value ||
		value.length > MAIL_PEOPLE_LIMITS.cursorChars ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) invalid("People cursor is invalid");
	const bytes = decodeBase64Url(value);
	if (!bytes) invalid("People cursor is invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch {
		invalid("People cursor is invalid");
	}
	const decoded = record(parsed, "People cursor is invalid");
	if (encodeCursor(decoded) !== value) invalid("People cursor is invalid");
	return decoded;
}

export function encodeMailPeopleListCursor(
	query: Pick<NormalizedMailPeopleListQuery, "q" | "sort">,
	cursor: MailPeopleListCursor,
): string {
	if (cursor.sort !== query.sort) invalid("People cursor sort does not match the query");
	return encodeCursor({ v: 1, kind: "people-list", q: query.q, ...cursor });
}

export function decodeMailPeopleListCursor(
	value: string,
	query: Pick<NormalizedMailPeopleListQuery, "q" | "sort">,
): MailPeopleListCursor {
	const cursor = decodeCursor(value);
	if (cursor.v !== 1 || cursor.kind !== "people-list" || cursor.q !== query.q || cursor.sort !== query.sort) {
		invalid("People cursor does not match the query");
	}
	const address = canonicalAddress(cursor.address);
	if (query.sort === "address" && exactKeys(cursor, ["v", "kind", "q", "sort", "address"])) {
		return { sort: "address", address };
	}
	const lastInteractionAt = canonicalDate(cursor.lastInteractionAt)!;
	if (query.sort === "recent" && exactKeys(cursor, ["v", "kind", "q", "sort", "lastInteractionAt", "address"])) {
		return { sort: "recent", lastInteractionAt, address };
	}
	if (query.sort === "frequent" && exactKeys(cursor, ["v", "kind", "q", "sort", "messageCount", "lastInteractionAt", "address"])) {
		return {
			sort: "frequent",
			messageCount: count(cursor.messageCount),
			lastInteractionAt,
			address,
		};
	}
	return invalid("People cursor is invalid");
}

export function encodeMailPersonTimelineCursor(
	personId: string,
	cursor: MailPersonTimelineCursor,
): string {
	return encodeCursor({ v: 1, kind: "person-timeline", personId, ...cursor });
}

export function decodeMailPersonTimelineCursor(
	value: string,
	personId: string,
): MailPersonTimelineCursor {
	const cursor = decodeCursor(value);
	if (
		!exactKeys(cursor, ["v", "kind", "personId", "date", "messageId", "role"]) ||
		cursor.v !== 1 || cursor.kind !== "person-timeline" || cursor.personId !== personId ||
		typeof cursor.role !== "string" || !["from", "to", "cc", "bcc"].includes(cursor.role)
	) invalid("People timeline cursor does not match the Person");
	return {
		date: canonicalDate(cursor.date)!,
		messageId: boundedText(cursor.messageId, MAIL_PEOPLE_LIMITS.identifierChars)!,
		role: cursor.role as MailPersonRole,
	};
}

function one(params: URLSearchParams, key: string): string | null {
	const values = params.getAll(key);
	if (values.length > 1) invalid(`${key} cannot be repeated`);
	return values[0] ?? null;
}

function limit(params: URLSearchParams): number {
	const raw = one(params, "limit");
	if (raw === null) return 25;
	if (!/^[1-9]\d*$/.test(raw)) invalid("limit must be a whole number from 1 through 50");
	const parsed = Number(raw);
	if (parsed < 1 || parsed > MAIL_PEOPLE_LIMITS.resultLimit) {
		invalid("limit must be a whole number from 1 through 50");
	}
	return parsed;
}

export function normalizeMailPeopleListQuery(params: URLSearchParams): NormalizedMailPeopleListQuery {
	for (const key of params.keys()) {
		if (!["q", "sort", "limit", "cursor"].includes(key)) invalid(`Unsupported People query parameter: ${key}`);
	}
	const q = (one(params, "q") ?? "").trim().toLowerCase().normalize("NFC");
	if (Array.from(q).length > MAIL_PEOPLE_LIMITS.queryChars || UNSAFE_UNICODE.test(q)) {
		invalid("People query is invalid");
	}
	const rawSort = one(params, "sort") ?? "recent";
	if (!MAIL_PEOPLE_SORTS.includes(rawSort as MailPeopleSort)) invalid("People sort is invalid");
	const sort = rawSort as MailPeopleSort;
	const cursor = one(params, "cursor");
	return validateNormalizedMailPeopleListQuery({ q, sort, limit: limit(params), cursor });
}

export function validateNormalizedMailPeopleListQuery(
	value: unknown,
): NormalizedMailPeopleListQuery {
	const query = record(value, "People query is invalid");
	if (!exactKeys(query, ["q", "sort", "limit", "cursor"])) invalid("People query is invalid");
	if (
		typeof query.q !== "string" ||
		query.q !== query.q.trim().toLowerCase().normalize("NFC") ||
		Array.from(query.q).length > MAIL_PEOPLE_LIMITS.queryChars ||
		UNSAFE_UNICODE.test(query.q) ||
		typeof query.sort !== "string" ||
		!MAIL_PEOPLE_SORTS.includes(query.sort as MailPeopleSort) ||
		!Number.isSafeInteger(query.limit) ||
		Number(query.limit) < 1 ||
		Number(query.limit) > MAIL_PEOPLE_LIMITS.resultLimit ||
		(query.cursor !== null && typeof query.cursor !== "string")
	) invalid("People query is invalid");
	const normalized: NormalizedMailPeopleListQuery = {
		q: query.q,
		sort: query.sort as MailPeopleSort,
		limit: Number(query.limit),
		cursor: query.cursor as string | null,
	};
	if (normalized.cursor) decodeMailPeopleListCursor(normalized.cursor, normalized);
	return normalized;
}

export function normalizeMailPersonTimelineQuery(
	params: URLSearchParams,
	personId: string,
): NormalizedMailPersonTimelineQuery {
	for (const key of params.keys()) {
		if (!["limit", "cursor"].includes(key)) invalid(`Unsupported People timeline query parameter: ${key}`);
	}
	const cursor = one(params, "cursor");
	return validateNormalizedMailPersonTimelineQuery({ limit: limit(params), cursor }, personId);
}

export function validateMailPersonId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim().normalize("NFC") ||
		UNSAFE_UNICODE.test(value) ||
		Array.from(value).length > MAIL_PEOPLE_LIMITS.identifierChars
	) invalid("Person id is invalid");
	return value;
}

export function validateNormalizedMailPersonTimelineQuery(
	value: unknown,
	personId: string,
): NormalizedMailPersonTimelineQuery {
	validateMailPersonId(personId);
	const query = record(value, "People timeline query is invalid");
	if (
		!exactKeys(query, ["limit", "cursor"]) ||
		!Number.isSafeInteger(query.limit) ||
		Number(query.limit) < 1 ||
		Number(query.limit) > MAIL_PEOPLE_LIMITS.resultLimit ||
		(query.cursor !== null && typeof query.cursor !== "string")
	) invalid("People timeline query is invalid");
	const normalized: NormalizedMailPersonTimelineQuery = {
		limit: Number(query.limit),
		cursor: query.cursor as string | null,
	};
	if (normalized.cursor) decodeMailPersonTimelineCursor(normalized.cursor, personId);
	return normalized;
}

function building(value: Record<string, unknown>): MailPeopleBuildingResponse | null {
	if (value.status !== "building") return null;
	if (!exactKeys(value, ["status", "schemaVersion", "processedMessages", "retryAfterMs"]) || value.schemaVersion !== 1) {
		invalid("People response is invalid");
	}
	return {
		status: "building",
		schemaVersion: 1,
		processedMessages: count(value.processedMessages),
		retryAfterMs: count(value.retryAfterMs),
	};
}

function summary(value: unknown): MailPersonSummary {
	const row = record(value, "People response is invalid");
	const keys = [
		"id", "address", "domain", "displayName", "nameProvenance", "firstInteractionAt",
		"lastInteractionAt", "lastInboundAt", "lastOutboundAt", "receivedCount", "sentCount",
		"conversationCount", "attachmentCount", "importedMessageCount", "latestDirection",
	];
	if (!exactKeys(row, keys)) invalid("People response is invalid");
	if (!["live", "imported", "none"].includes(String(row.nameProvenance))) invalid("People response is invalid");
	if (!["sent", "received"].includes(String(row.latestDirection))) invalid("People response is invalid");
	return {
		id: boundedText(row.id, MAIL_PEOPLE_LIMITS.identifierChars)!,
		address: canonicalAddress(row.address),
		domain: boundedText(row.domain, MAIL_PEOPLE_LIMITS.identifierChars)!,
		displayName: boundedText(row.displayName, MAIL_PEOPLE_LIMITS.displayNameChars, { nullable: true }),
		nameProvenance: row.nameProvenance as MailPersonNameProvenance,
		firstInteractionAt: canonicalDate(row.firstInteractionAt)!,
		lastInteractionAt: canonicalDate(row.lastInteractionAt)!,
		lastInboundAt: canonicalDate(row.lastInboundAt, true),
		lastOutboundAt: canonicalDate(row.lastOutboundAt, true),
		receivedCount: count(row.receivedCount),
		sentCount: count(row.sentCount),
		conversationCount: count(row.conversationCount),
		attachmentCount: count(row.attachmentCount),
		importedMessageCount: count(row.importedMessageCount),
		latestDirection: row.latestDirection as MailPersonDirection,
	};
}

function compareSummaries(
	left: MailPersonSummary,
	right: MailPersonSummary,
	sort: MailPeopleSort,
): number {
	if (sort === "address") {
		return compareCanonicalMailAddresses(left.address, right.address);
	}
	if (sort === "frequent") {
		const frequency = (right.receivedCount + right.sentCount) -
			(left.receivedCount + left.sentCount);
		if (frequency) return frequency;
	}
	const recency = right.lastInteractionAt.localeCompare(left.lastInteractionAt);
	return recency || compareCanonicalMailAddresses(left.address, right.address);
}

export function validateMailPeopleListResponse(
	value: unknown,
	query: NormalizedMailPeopleListQuery,
): MailPeopleListResponse {
	const response = record(value, "People response is invalid");
	const pending = building(response);
	if (pending) return pending;
	if (!exactKeys(response, ["status", "people", "nextCursor"]) || response.status !== "ready" || !Array.isArray(response.people)) {
		invalid("People response is invalid");
	}
	if (response.nextCursor !== null && typeof response.nextCursor !== "string") invalid("People response is invalid");
	const people = response.people.map(summary);
	if (people.length > query.limit) invalid("People response is invalid");
	const identities = new Set<string>();
	for (let index = 0; index < people.length; index += 1) {
		const person = people[index]!;
		if (person.domain !== person.address.slice(person.address.lastIndexOf("@") + 1)) {
			invalid("People response is invalid");
		}
		if (identities.has(person.id) || identities.has(person.address)) invalid("People response is invalid");
		identities.add(person.id);
		identities.add(person.address);
		if (index > 0 && compareSummaries(people[index - 1]!, person, query.sort) > 0) {
			invalid("People response is invalid");
		}
	}
	if (response.nextCursor !== null) {
		if (people.length !== query.limit || people.length === 0) invalid("People response is invalid");
		const cursor = decodeMailPeopleListCursor(response.nextCursor, query);
		const last = people.at(-1)!;
		if (
			cursor.address !== last.address ||
			(cursor.sort !== "address" && cursor.lastInteractionAt !== last.lastInteractionAt) ||
			(cursor.sort === "frequent" && cursor.messageCount !== last.receivedCount + last.sentCount)
		) invalid("People response is invalid");
	}
	return {
		status: "ready",
		people,
		nextCursor: response.nextCursor,
	};
}

export function validateMailPersonDetailResponse(
	value: unknown,
	personId: string,
): MailPersonDetailResponse {
	const response = record(value, "People response is invalid");
	const pending = building(response);
	if (pending) return pending;
	if (!exactKeys(response, ["status", "person"]) || response.status !== "ready") invalid("People response is invalid");
	if (response.person === null) return { status: "ready", person: null };
	const person = record(response.person, "People response is invalid");
	if (!Array.isArray(person.conversations)) invalid("People response is invalid");
	const { conversations: _conversations, ...summaryFields } = person;
	if (person.conversations.length > MAIL_PEOPLE_LIMITS.recentConversationLimit) invalid("People response is invalid");
	const conversationIds = new Set<string>();
	const conversations = person.conversations.map((value): MailPersonConversationSummary => {
		const row = record(value, "People response is invalid");
		if (!exactKeys(row, ["conversationId", "representativeMessageId", "representativeFolderId", "subject", "latestAt", "latestDirection", "messageCount", "unreadCount", "attachmentCount"]) || !["sent", "received"].includes(String(row.latestDirection))) {
			invalid("People response is invalid");
		}
		const conversation = {
			conversationId: boundedText(row.conversationId, MAIL_PEOPLE_LIMITS.identifierChars)!,
			representativeMessageId: boundedText(row.representativeMessageId, MAIL_PEOPLE_LIMITS.identifierChars)!,
			representativeFolderId: boundedText(row.representativeFolderId, MAIL_PEOPLE_LIMITS.identifierChars)!,
			subject: boundedText(row.subject, MAIL_PEOPLE_LIMITS.subjectChars, { empty: true })!,
			latestAt: canonicalDate(row.latestAt)!,
			latestDirection: row.latestDirection as MailPersonDirection,
			messageCount: count(row.messageCount),
			unreadCount: count(row.unreadCount),
			attachmentCount: count(row.attachmentCount),
		};
		if (conversationIds.has(conversation.conversationId)) invalid("People response is invalid");
		conversationIds.add(conversation.conversationId);
		return conversation;
	});
	for (let index = 1; index < conversations.length; index += 1) {
		const previous = conversations[index - 1]!;
		const current = conversations[index]!;
		if (
			previous.latestAt < current.latestAt ||
			(previous.latestAt === current.latestAt && previous.conversationId > current.conversationId)
		) invalid("People response is invalid");
	}
	const personSummary = summary(summaryFields);
	if (personSummary.id !== personId) invalid("People response is invalid");
	return { status: "ready", person: { ...personSummary, conversations } };
}

export function validateMailPersonTimelineResponse(
	value: unknown,
	personId: string,
	query: NormalizedMailPersonTimelineQuery,
): MailPersonTimelineResponse {
	const response = record(value, "People response is invalid");
	const pending = building(response);
	if (pending) return pending;
	if (!exactKeys(response, ["status", "personId", "items", "nextCursor"]) || response.status !== "ready" || !Array.isArray(response.items)) {
		invalid("People response is invalid");
	}
	const responsePersonId = boundedText(response.personId, MAIL_PEOPLE_LIMITS.identifierChars)!;
	if (responsePersonId !== personId) invalid("People response is invalid");
	if (response.nextCursor !== null && typeof response.nextCursor !== "string") invalid("People response is invalid");
	if (response.items.length > query.limit) invalid("People response is invalid");
	const identities = new Set<string>();
	const items = response.items.map((value): MailPersonTimelineItem => {
		const row = record(value, "People response is invalid");
		if (!exactKeys(row, ["messageId", "conversationId", "date", "direction", "role", "subject", "folder", "origin", "attachments"]) || !Array.isArray(row.attachments)) {
			invalid("People response is invalid");
		}
		if (!["sent", "received"].includes(String(row.direction)) || !["from", "to", "cc", "bcc"].includes(String(row.role)) || !["live_inbound", "accepted_outbound", "admin_import"].includes(String(row.origin))) {
			invalid("People response is invalid");
		}
		const folder = record(row.folder, "People response is invalid");
		if (!exactKeys(folder, ["id", "name"])) invalid("People response is invalid");
		const timelineItem = {
			messageId: boundedText(row.messageId, MAIL_PEOPLE_LIMITS.identifierChars)!,
			conversationId: boundedText(row.conversationId, MAIL_PEOPLE_LIMITS.identifierChars)!,
			date: canonicalDate(row.date)!,
			direction: row.direction as MailPersonDirection,
			role: row.role as MailPersonRole,
			subject: boundedText(row.subject, MAIL_PEOPLE_LIMITS.subjectChars, { empty: true })!,
			folder: {
				id: boundedText(folder.id, MAIL_PEOPLE_LIMITS.identifierChars)!,
				name: boundedText(folder.name, MAIL_PEOPLE_LIMITS.identifierChars)!,
			},
			origin: row.origin as MailPersonOrigin,
			attachments: (() => {
				if (row.attachments.length > MAIL_PEOPLE_LIMITS.timelineAttachmentsPerMessage) {
					invalid("People response is invalid");
				}
				return row.attachments.map((attachment) => {
				const item = record(attachment, "People response is invalid");
				if (!exactKeys(item, ["id", "filename", "mimetype", "size"])) invalid("People response is invalid");
				return {
					id: boundedText(item.id, MAIL_PEOPLE_LIMITS.identifierChars)!,
					filename: boundedText(item.filename, MAIL_PEOPLE_LIMITS.filenameChars)!,
					mimetype: boundedText(item.mimetype, MAIL_PEOPLE_LIMITS.mimetypeChars)!,
					size: count(item.size),
				};
				});
			})(),
		};
		const identity = `${timelineItem.messageId}\n${timelineItem.role}`;
		if (identities.has(identity)) invalid("People response is invalid");
		identities.add(identity);
		return timelineItem;
	});
	for (let index = 1; index < items.length; index += 1) {
		const previous = items[index - 1]!;
		const current = items[index]!;
		if (
			previous.date < current.date ||
			(previous.date === current.date && previous.messageId > current.messageId) ||
			(previous.date === current.date && previous.messageId === current.messageId && previous.role > current.role)
		) invalid("People response is invalid");
	}
	if (response.nextCursor !== null) {
		if (items.length !== query.limit || items.length === 0) invalid("People response is invalid");
		const cursor = decodeMailPersonTimelineCursor(response.nextCursor, personId);
		const last = items.at(-1)!;
		if (cursor.date !== last.date || cursor.messageId !== last.messageId || cursor.role !== last.role) {
			invalid("People response is invalid");
		}
	}
	return { status: "ready", personId: responsePersonId, items, nextCursor: response.nextCursor };
}
