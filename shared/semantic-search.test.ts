import assert from "node:assert/strict";
import test from "node:test";
import {
	parseSemanticSearchRequest,
	parseSemanticSearchResponse,
	truncateSemanticSearchText,
} from "./semantic-search.ts";

const result = {
	mailboxId: "mailbox-1",
	mailboxAddress: "hello@example.com",
	messageId: "message-1",
	source: "message" as const,
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
	const attachment = {
		...result,
		source: "attachment" as const,
		attachmentId: "attachment-1",
		attachmentFilename: "agreement.md",
		excerptKind: "extracted_attachment" as const,
	};
	assert.deepEqual(parseSemanticSearchResponse({
		...complete,
		results: [result, attachment],
	}), { ...complete, results: [result, attachment] });
	assert.throws(() => parseSemanticSearchResponse({
		...complete,
		results: [{ ...attachment, attachmentId: undefined }],
	}));
	assert.throws(() => parseSemanticSearchResponse({
		...complete,
		results: [{ ...result, attachmentId: "forbidden" }],
	}));
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
	for (const malformed of [
		{
			...complete,
			results: [{ ...attachment, attachmentId: "\uD800" }],
		},
		{
			...complete,
			results: [{ ...result, messageId: "\uD800" }],
		},
		{
			...complete,
			results: [{ ...result, mailboxId: "\uD800" }],
			mailboxes: [{ ...complete.mailboxes[0], mailboxId: "\uD800" }],
		},
	]) assert.throws(() => parseSemanticSearchResponse(malformed));
});

test("semantic text bounds preserve complete Unicode scalars", () => {
	assert.equal(truncateSemanticSearchText(`${"a".repeat(254)}😀tail`, 255), "a".repeat(254));
	assert.equal(truncateSemanticSearchText("a\uD83Db", 3), "a�b");
	assert.throws(() => truncateSemanticSearchText("text", 0));
});
