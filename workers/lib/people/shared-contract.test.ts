import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeMailPeopleListCursor,
	encodeMailPeopleListCursor,
	encodeMailPersonTimelineCursor,
	compareCanonicalMailAddresses,
	hasUnsafeMailPeopleText,
	validateMailPeopleListResponse,
	validateMailPersonDetailResponse,
	validateMailPersonTimelineResponse,
	validateNormalizedMailPeopleListQuery,
} from "../../../shared/mail-people.ts";

const query = { q: "", sort: "recent" as const, limit: 2, cursor: null };

function person(input: { id: string; address: string; last: string }) {
	return {
		id: input.id,
		address: input.address,
		domain: input.address.split("@")[1],
		displayName: null,
		nameProvenance: "none" as const,
		firstInteractionAt: input.last,
		lastInteractionAt: input.last,
		lastInboundAt: input.last,
		lastOutboundAt: null,
		receivedCount: 1,
		sentCount: 0,
		conversationCount: 1,
		attachmentCount: 0,
		importedMessageCount: 0,
		latestDirection: "received" as const,
	};
}

test("People list cursors are canonical and bound to the complete normalized query", () => {
	const cursor = encodeMailPeopleListCursor(query, {
		sort: "recent",
		lastInteractionAt: "2026-07-12T10:00:00.000Z",
		address: "person@example.com",
	});
	assert.deepEqual(decodeMailPeopleListCursor(cursor, query), {
		sort: "recent",
		lastInteractionAt: "2026-07-12T10:00:00.000Z",
		address: "person@example.com",
	});
	assert.throws(
		() => decodeMailPeopleListCursor(cursor, { q: "other", sort: "recent" }),
		/does not match/i,
	);
	assert.throws(
		() => validateNormalizedMailPeopleListQuery({ ...query, extra: true }),
		/invalid/i,
	);
});

test("detail validation requires linkable representative mailbox coordinates", () => {
	const summary = person({
		id: "person-1",
		address: "person@example.com",
		last: "2026-07-12T10:00:00.000Z",
	});
	const conversation = {
		conversationId: "conversation-1",
		representativeMessageId: "message-1",
		representativeFolderId: "inbox",
		subject: "Hello",
		latestAt: "2026-07-12T10:00:00.000Z",
		latestDirection: "received" as const,
		messageCount: 1,
		unreadCount: 1,
		attachmentCount: 0,
	};
	assert.deepEqual(
		validateMailPersonDetailResponse(
			{ status: "ready", person: { ...summary, conversations: [conversation] } },
			"person-1",
		),
		{ status: "ready", person: { ...summary, conversations: [conversation] } },
	);
	const { representativeFolderId: _folder, ...unlinked } = conversation;
	assert.throws(
		() => validateMailPersonDetailResponse(
			{ status: "ready", person: { ...summary, conversations: [unlinked] } },
			"person-1",
		),
		/invalid/i,
	);
});

test("People list validation proves ordering, uniqueness, unsafe text, and the last-row cursor boundary", () => {
	const first = person({
		id: "person-1",
		address: "a@example.com",
		last: "2026-07-12T11:00:00.000Z",
	});
	const second = person({
		id: "person-2",
		address: "b@example.com",
		last: "2026-07-12T10:00:00.000Z",
	});
	const nextCursor = encodeMailPeopleListCursor(query, {
		sort: "recent",
		lastInteractionAt: second.lastInteractionAt,
		address: second.address,
	});
	assert.deepEqual(
		validateMailPeopleListResponse({ status: "ready", people: [first, second], nextCursor }, query),
		{ status: "ready", people: [first, second], nextCursor },
	);
	assert.throws(
		() => validateMailPeopleListResponse({ status: "ready", people: [second, first], nextCursor: null }, query),
		/invalid/i,
	);
	assert.throws(
		() => validateMailPeopleListResponse({ status: "ready", people: [first, { ...second, id: first.id }], nextCursor }, query),
		/invalid/i,
	);
	assert.throws(
		() => validateMailPeopleListResponse({ status: "ready", people: [{ ...first, displayName: "Unsafe\u202E" }], nextCursor: null }, query),
		/invalid/i,
	);
	assert.equal(hasUnsafeMailPeopleText("Unsafe\u202E"), true);
});

test("People address ordering is Unicode-stable and matches SQLite BINARY pagination", () => {
	const addressQuery = { q: "", sort: "address" as const, limit: 3, cursor: null };
	const addresses = ["z@example.com", "ä@example.com", "😀@example.com"];
	assert.deepEqual(
		[...addresses].sort(compareCanonicalMailAddresses),
		addresses,
	);
	const people = addresses.map((address, index) => person({
		id: `person-${index}`,
		address,
		last: "2026-07-12T10:00:00.000Z",
	}));
	assert.deepEqual(
		validateMailPeopleListResponse({ status: "ready", people, nextCursor: null }, addressQuery),
		{ status: "ready", people, nextCursor: null },
	);
});

test("timeline validation binds identity and cursor to the exact final evidence tuple", () => {
	const personId = "person-1";
	const timelineQuery = { limit: 1, cursor: null };
	const item = {
		messageId: "message-1",
		conversationId: "conversation-1",
		date: "2026-07-12T10:00:00.000Z",
		direction: "received" as const,
		role: "from" as const,
		subject: "Hello",
		folder: { id: "inbox", name: "Inbox" },
		origin: "live_inbound" as const,
		attachments: [],
	};
	const nextCursor = encodeMailPersonTimelineCursor(personId, {
		date: item.date,
		messageId: item.messageId,
		role: item.role,
	});
	assert.deepEqual(
		validateMailPersonTimelineResponse(
			{ status: "ready", personId, items: [item], nextCursor },
			personId,
			timelineQuery,
		),
		{ status: "ready", personId, items: [item], nextCursor },
	);
	assert.throws(
		() => validateMailPersonTimelineResponse(
			{ status: "ready", personId, items: [item], nextCursor },
			"person-2",
			timelineQuery,
		),
		/invalid/i,
	);
});
