import assert from "node:assert/strict";
import test from "node:test";
import api from "./api.ts";

const summary = {
	id: "person-1",
	address: "ada@example.com",
	domain: "example.com",
	displayName: "Ada Lovelace",
	nameProvenance: "live",
	firstInteractionAt: "2026-06-01T10:00:00.000Z",
	lastInteractionAt: "2026-07-12T10:00:00.000Z",
	lastInboundAt: "2026-07-12T10:00:00.000Z",
	lastOutboundAt: "2026-07-11T10:00:00.000Z",
	receivedCount: 4,
	sentCount: 3,
	conversationCount: 2,
	attachmentCount: 1,
	importedMessageCount: 0,
	latestDirection: "received",
} as const;

test("People list, detail, and timeline stay mailbox-scoped and URL encoded", async () => {
	const requested: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => {
		const url = String(input);
		requested.push(url);
		let body: unknown = { status: "ready", people: [summary], nextCursor: null };
		if (url.includes("/timeline")) {
			body = {
				status: "ready",
				personId: "person/1",
				items: [{
					messageId: "message-1",
					conversationId: "conversation-1",
					date: "2026-07-12T10:00:00.000Z",
					direction: "received",
					role: "from",
					subject: "Project update",
					folder: { id: "inbox", name: "Inbox" },
					origin: "live_inbound",
					attachments: [],
				}],
				nextCursor: null,
			};
		} else if (url.endsWith("/person%2F1")) {
			body = {
				status: "ready",
				person: {
					...summary,
					id: "person/1",
					conversations: [{
						conversationId: "conversation-1",
						representativeMessageId: "message-1",
						representativeFolderId: "inbox",
						subject: "Project update",
						latestAt: "2026-07-12T10:00:00.000Z",
						latestDirection: "received",
						messageCount: 1,
						unreadCount: 0,
						attachmentCount: 0,
					}],
				},
			};
		}
		return Promise.resolve(new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
	};

	try {
		await api.listMailPeople("team/one@example.com", {
			limit: 25,
			q: "Ada",
			sort: "frequent",
		});
		await api.getMailPerson("team/one@example.com", "person/1");
		await api.listMailPersonTimeline("team/one@example.com", "person/1", {
			limit: 25,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(requested, [
		"/api/v1/mailboxes/team%2Fone%40example.com/people?limit=25&q=Ada&sort=frequent",
		"/api/v1/mailboxes/team%2Fone%40example.com/people/person%2F1",
		"/api/v1/mailboxes/team%2Fone%40example.com/people/person%2F1/timeline?limit=25",
	]);
});

test("People APIs reject a response outside the requested Person scope", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
		status: "ready",
		personId: "person-2",
		items: [],
		nextCursor: null,
	}), {
		status: 200,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.listMailPersonTimeline("team@example.com", "person-1", { limit: 25 }),
			/invalid|Person/i,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("People building responses remain content-free and abortable", async () => {
	let requestSignal: AbortSignal | null = null;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_input, init) => {
		requestSignal = init?.signal as AbortSignal;
		return new Promise<Response>((_resolve, reject) => {
			requestSignal?.addEventListener("abort", () => {
				reject(new DOMException("Aborted", "AbortError"));
			}, { once: true });
		});
	};
	const controller = new AbortController();
	const request = api.listMailPeople("team@example.com", {
		limit: 25,
		sort: "recent",
	}, { signal: controller.signal });
	controller.abort();
	await assert.rejects(request, /abort/i);
	globalThis.fetch = originalFetch;

	assert.equal(requestSignal?.aborted, true);
});
