import assert from "node:assert/strict";
import test from "node:test";
import type {
	MailPeopleListResponse,
	MailPersonSummary,
	MailPersonTimelineResponse,
} from "../../shared/mail-people.ts";
import {
	buildMailPeopleQueryOptions,
	buildMailPersonTimelineQueryOptions,
	compareMailPeople,
	flattenMailPeoplePages,
} from "./people.ts";

function person(input: Partial<MailPersonSummary> & Pick<MailPersonSummary, "id" | "address">): MailPersonSummary {
	return {
		id: input.id,
		address: input.address,
		domain: "example.com",
		displayName: null,
		nameProvenance: "none",
		firstInteractionAt: "2026-06-01T10:00:00.000Z",
		lastInteractionAt: "2026-07-12T10:00:00.000Z",
		lastInboundAt: "2026-07-12T10:00:00.000Z",
		lastOutboundAt: null,
		receivedCount: 1,
		sentCount: 0,
		conversationCount: 1,
		attachmentCount: 0,
		importedMessageCount: 0,
		latestDirection: "received",
		...input,
	};
}

test("People ordering follows recent, frequent, and address contracts", () => {
	const recent = person({ id: "recent", address: "z@example.com" });
	const older = person({
		id: "older",
		address: "a@example.com",
		lastInteractionAt: "2026-07-10T10:00:00.000Z",
		receivedCount: 20,
	});
	assert.ok(compareMailPeople(recent, older, "recent") < 0);
	assert.ok(compareMailPeople(older, recent, "frequent") < 0);
	assert.ok(compareMailPeople(older, recent, "address") < 0);
	assert.ok(compareMailPeople(
		person({ id: "z", address: "z@example.com" }),
		person({ id: "umlaut", address: "ä@example.com" }),
		"address",
	) < 0);
});

test("a building page hides previously loaded relationship rows and polls at the server interval", () => {
	const ready: MailPeopleListResponse = {
		status: "ready",
		people: [person({ id: "one", address: "one@example.com" })],
		nextCursor: null,
	};
	const building: MailPeopleListResponse = {
		status: "building",
		schemaVersion: 1,
		processedMessages: 100,
		retryAfterMs: 750,
	};
	assert.deepEqual(flattenMailPeoplePages([ready, building]), []);

	const options = buildMailPeopleQueryOptions("team@example.com", {
		q: "",
		sort: "recent",
	});
	assert.equal(
		options.refetchInterval({ state: { data: { pages: [building] } } }),
		750,
	);
});

test("People pagination rejects duplicate or backward rows across pages", async () => {
	const first = person({ id: "one", address: "one@example.com" });
	const options = buildMailPeopleQueryOptions(
		"team@example.com",
		{ q: "", sort: "recent" },
		async () => ({ status: "ready", people: [first], nextCursor: null }),
	);
	const signal = new AbortController().signal;
	await assert.rejects(
		options.queryFn({
			pageParam: { cursor: "next", boundary: first, seenIds: [first.id] },
			signal,
		}),
		/inconsistent/i,
	);
	await assert.rejects(
		buildMailPeopleQueryOptions(
			"team@example.com",
			{ q: "", sort: "address" },
			async () => ({
				status: "ready",
				people: [person({ id: "before", address: "a@example.com" })],
				nextCursor: null,
			}),
		).queryFn({
			pageParam: {
				cursor: "next",
				boundary: person({ id: "after", address: "z@example.com" }),
				seenIds: [],
			},
			signal,
		}),
		/inconsistent/i,
	);
});

test("timeline pagination rejects repeated Message evidence", async () => {
	const page: MailPersonTimelineResponse = {
		status: "ready",
		personId: "person-1",
		items: [{
			messageId: "message-1",
			conversationId: "conversation-1",
			date: "2026-07-12T10:00:00.000Z",
			direction: "received",
			role: "from",
			subject: "Hello",
			folder: { id: "inbox", name: "Inbox" },
			origin: "live_inbound",
			attachments: [],
		}],
		nextCursor: null,
	};
	const options = buildMailPersonTimelineQueryOptions(
		"team@example.com",
		"person-1",
		async () => page,
	);
	await assert.rejects(
		options.queryFn({
			pageParam: {
				cursor: "next",
				boundary: page.status === "ready" ? page.items[0]! : null,
				seenIds: [JSON.stringify(["message-1", "from"])],
			},
			signal: new AbortController().signal,
		}),
		/inconsistent/i,
	);
});
