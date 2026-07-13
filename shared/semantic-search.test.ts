import assert from "node:assert/strict";
import test from "node:test";
import {
	parseSemanticSearchRequest,
	parseSemanticSearchResponse,
} from "./semantic-search.ts";

const result = {
	mailboxId: "mailbox-1",
	mailboxAddress: "hello@example.com",
	messageId: "message-1",
	score: 0.91,
	subject: "Contract timing",
	counterparty: "sam@example.com",
	date: "2026-07-13T08:00:00.000Z",
	folderId: "inbox",
	excerpt: "The signed contract will arrive on Tuesday.",
	excerptKind: "authored_mail" as const,
};

test("semantic request is exact, normalized, and UTF-8 bounded", () => {
	assert.deepEqual(parseSemanticSearchRequest({ query: "  signed contract  " }), {
		query: "signed contract",
	});
	assert.throws(() => parseSemanticSearchRequest({ query: "x", mailboxIds: ["private"] }));
	assert.throws(() => parseSemanticSearchRequest({ query: "م".repeat(501) }));
});

test("semantic response validates compound identity and completeness truth", () => {
	const complete = {
		state: "complete",
		accessChanged: false,
		results: [result],
		mailboxes: [{
			mailboxId: "mailbox-1",
			mailboxAddress: "hello@example.com",
			state: "complete",
		}],
	};
	assert.deepEqual(parseSemanticSearchResponse(complete), complete);
	assert.throws(() => parseSemanticSearchResponse({
		...complete,
		results: [result, result],
	}));
	assert.throws(() => parseSemanticSearchResponse({
		...complete,
		state: "building",
		mailboxes: [{ ...complete.mailboxes[0], state: "building" }],
	}));
	assert.throws(() => parseSemanticSearchResponse({
		state: "building",
		results: [result],
		mailboxes: [{ ...complete.mailboxes[0], state: "building" }],
	}));
	assert.throws(() => parseSemanticSearchResponse({
		state: "partial",
		results: [result],
		mailboxes: [
			{ ...complete.mailboxes[0], state: "building" },
			{ mailboxId: "mailbox-2", mailboxAddress: "two@example.com", state: "complete" },
		],
	}));
	assert.throws(() => parseSemanticSearchResponse({
		...complete,
		results: [{ ...result, mailboxAddress: "wrong@example.com" }],
	}));
	assert.throws(() => parseSemanticSearchResponse({ ...complete, state: "unavailable" }));
});
