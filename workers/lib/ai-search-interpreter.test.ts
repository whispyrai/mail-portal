import assert from "node:assert/strict";
import test from "node:test";
import { AI_SEARCH_INTERPRETER_LIMITS } from "../../shared/ai-search-interpreter.ts";
import {
	AI_SEARCH_INTERPRETER_AI_CONFIG,
	AiSearchInterpreterValidationError,
	buildAiSearchInterpreterCacheKey,
	buildAiSearchInterpreterModelMessages,
	localDateForTimezone,
	normalizeAiSearchCatalog,
	parseAiSearchInterpreterModelOutput,
	parseCachedAiSearchInterpreterModelOutput,
	snapshotAiSearchCatalog,
} from "./ai-search-interpreter.ts";

const catalog = normalizeAiSearchCatalog({
	folders: [
		{ id: "sent", name: "Sent" },
		{ id: "inbox", name: "Inbox" },
	],
	labels: [{ id: "label-vip", name: "VIP" }],
});

const filters = {
	terms: ["proposal"],
	phrases: ["signed terms"],
	from: ["sam@example.com"],
	to: [],
	subject: [],
	filename: [],
	folders: ["inbox"],
	isRead: false,
	isStarred: null,
	hasAttachment: true,
	after: "2026-07-01",
	before: "2026-08-01",
};

function output(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		status: "ready",
		filters,
		labelId: "label-vip",
		...overrides,
	});
}

test("catalog identity is bounded, sorted, exact, and fingerprinted by names and IDs", async () => {
	assert.deepEqual(catalog, {
		folders: [
			{ id: "inbox", name: "Inbox" },
			{ id: "sent", name: "Sent" },
		],
		labels: [{ id: "label-vip", name: "VIP" }],
	});
	const first = await snapshotAiSearchCatalog(catalog);
	const reordered = await snapshotAiSearchCatalog({
		folders: [...catalog.folders].reverse(),
		labels: catalog.labels,
	});
	const renamed = await snapshotAiSearchCatalog({
		folders: catalog.folders,
		labels: [{ id: "label-vip", name: "Priority" }],
	});
	assert.equal(first.fingerprint, reordered.fingerprint);
	assert.notEqual(first.fingerprint, renamed.fingerprint);
	assert.match(first.fingerprint, /^asic:v1:[a-f0-9]{64}$/);
	assert.throws(() => normalizeAiSearchCatalog({
		folders: [{ id: " inbox ", name: "Inbox" }],
		labels: [],
	}));
	assert.throws(() => normalizeAiSearchCatalog({
		folders: [{ id: 'folder"unsafe', name: "Inbox" }],
		labels: [],
	}));
	assert.throws(() => normalizeAiSearchCatalog({
		folders: [{ id: "inbox", name: "Invoice\u202Efdp.exe" }],
		labels: [],
	}));
	assert.throws(() => normalizeAiSearchCatalog({
		folders: Array.from({ length: 51 }, (_, index) => ({
			id: `folder-${index}`,
			name: `Folder ${index}`,
		})),
		labels: [],
	}));
});

test("model envelope contains only fixed policy, local date, intent, and bounded catalogs", () => {
	const messages = buildAiSearchInterpreterModelMessages({
		intent: "Unread proposals from Sam last week",
		timezone: "Africa/Cairo",
		localDate: "2026-07-12",
		catalog,
	});
	assert.equal(messages.length, 2);
	assert.match(messages[0]!.content, /never search mail, call tools/);
	assert.match(messages[1]!.content, /Unread proposals from Sam last week/);
	assert.match(messages[1]!.content, /2026-07-12/);
	assert.match(messages[1]!.content, /label-vip/);
	assert.doesNotMatch(messages[1]!.content, /messageBody|snippet|attachmentContent/);
	assert.equal(
		localDateForTimezone(Date.parse("2026-07-11T22:30:00.000Z"), "Africa/Cairo"),
		"2026-07-12",
	);
});

test("the largest accepted catalog still fits the complete model envelope", () => {
	const entries = (prefix: string) =>
		Array.from({ length: 25 }, (_, index) => ({
			id: `${prefix}-${String(index).padStart(2, "0")}-${"a".repeat(120)}`.slice(0, 128),
			name: `${index}${"&".repeat(99)}`.slice(0, 100),
		}));
	const maximum = normalizeAiSearchCatalog({
		folders: entries("folder"),
		labels: entries("label"),
	});
	const messages = buildAiSearchInterpreterModelMessages({
		intent: "&".repeat(AI_SEARCH_INTERPRETER_LIMITS.intentChars),
		timezone: "America/Argentina/Buenos_Aires",
		localDate: "2026-07-12",
		catalog: maximum,
	});
	assert.ok(
		new TextEncoder().encode(JSON.stringify(messages)).byteLength <=
			AI_SEARCH_INTERPRETER_LIMITS.modelSerializedBytes,
	);
});

test("ready model output compiles through canonical Search v2 and production planning", () => {
	const parsed = parseAiSearchInterpreterModelOutput(output(), catalog);
	assert.equal(parsed.modelOutput.status, "ready");
	assert.deepEqual(parsed.response, {
		state: "generated",
		query:
			'proposal "signed terms" from:sam@example.com in:inbox is:unread has:attachment after:2026-07-01 before:2026-08-01',
		labelId: "label-vip",
		filters,
		requiresReview: true,
	});
	assert.equal(
		parseCachedAiSearchInterpreterModelOutput(parsed.modelOutput, catalog).response.state,
		"cached",
	);
});

test("model output is closed and rejects unknown catalog IDs, markup, empty, and unplannable filters", () => {
	const invalid = [
		JSON.stringify({ status: "ambiguous", reason: "model prose" }),
		output({ labelId: "missing-label" }),
		output({ filters: { ...filters, folders: ["missing-folder"] } }),
		output({ filters: { ...filters, terms: ["<b>proposal</b>"] } }),
		output({
			labelId: null,
			filters: {
				...filters,
				terms: [],
				phrases: [],
				from: [],
				folders: [],
				isRead: null,
				hasAttachment: false,
				after: null,
				before: null,
			},
		}),
		output({ filters: { ...filters, terms: ["a".repeat(49)] } }),
		`${" ".repeat(8_001)}${output()}`,
		"not-json",
	];
	for (const raw of invalid) {
		assert.throws(
			() => parseAiSearchInterpreterModelOutput(raw, catalog),
			AiSearchInterpreterValidationError,
		);
	}
	assert.deepEqual(
		parseAiSearchInterpreterModelOutput('{"status":"ambiguous"}', catalog).response,
		{ state: "ambiguous" },
	);
	assert.deepEqual(
		parseAiSearchInterpreterModelOutput('{"status":"unsupported"}', catalog).response,
		{ state: "unsupported" },
	);
});

test("label-only is ready but an empty all-mail interpretation fails closed", () => {
	const emptyFilters = {
		terms: [], phrases: [], from: [], to: [], subject: [], filename: [], folders: [],
		isRead: null, isStarred: null, hasAttachment: false, after: null, before: null,
	};
	assert.deepEqual(
		parseAiSearchInterpreterModelOutput(JSON.stringify({
			status: "ready",
			filters: emptyFilters,
			labelId: "label-vip",
		}), catalog).response,
		{
			state: "generated",
			query: "",
			labelId: "label-vip",
			filters: emptyFilters,
			requiresReview: true,
		},
	);
	assert.throws(() => parseAiSearchInterpreterModelOutput(JSON.stringify({
		status: "ready",
		filters: emptyFilters,
		labelId: null,
	}), catalog), AiSearchInterpreterValidationError);
});

test("cache key covers private identity, local date, timezone, model, and catalog freshness", async () => {
	const snapshot = await snapshotAiSearchCatalog(catalog);
	const base = {
		environment: "wiser",
		model: "cheap-model",
		actorUserId: "user-1",
		mailboxId: "team@example.com",
		intent: "Unread proposals",
		timezone: "Africa/Cairo",
		localDate: "2026-07-12",
		catalogFingerprint: snapshot.fingerprint,
	};
	const first = await buildAiSearchInterpreterCacheKey(base);
	assert.match(first, /^aic:v1:search_interpreter:cheap:[a-f0-9]{64}$/);
	for (const changed of [
		{ ...base, actorUserId: "user-2" },
		{ ...base, mailboxId: "other@example.com" },
		{ ...base, timezone: "UTC" },
		{ ...base, localDate: "2026-07-13" },
		{ ...base, catalogFingerprint: "asic:v1:changed" },
		{ ...base, model: "other-model" },
	]) {
		assert.notEqual(await buildAiSearchInterpreterCacheKey(changed), first);
	}
	assert.equal(AI_SEARCH_INTERPRETER_AI_CONFIG.requestedTier, "cheap");
	assert.equal(AI_SEARCH_INTERPRETER_AI_CONFIG.temperature, 0);
});
