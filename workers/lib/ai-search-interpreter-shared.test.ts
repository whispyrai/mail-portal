import assert from "node:assert/strict";
import test from "node:test";
import {
	parseAiSearchFilters,
	parseAiSearchInterpreterRequest,
	parseAiSearchInterpreterResponse,
	serializeAiSearchFilters,
} from "../../shared/ai-search-interpreter.ts";

const filters = {
	terms: ["proposal"],
	phrases: ["renewal terms"],
	from: ["sam@example.com"],
	to: [],
	subject: ["Q3 plan"],
	filename: ["price list.pdf"],
	folders: ["inbox"],
	isRead: false,
	isStarred: true,
	hasAttachment: true,
	after: "2026-07-01",
	before: "2026-08-01",
};

test("normalizes strict intent and canonical IANA timezone input", () => {
	assert.deepEqual(
		parseAiSearchInterpreterRequest({
			intent: "  unread\n proposals from Sam  ",
			timezone: "Africa/Cairo",
		}),
		{
			intent: "unread proposals from Sam",
			timezone: "Africa/Cairo",
		},
	);
	assert.throws(() =>
		parseAiSearchInterpreterRequest({
			intent: "mail",
			timezone: "Africa/Cairo",
			extra: true,
		}),
	);
	assert.throws(() =>
		parseAiSearchInterpreterRequest({ intent: "mail", timezone: "Not/AZone" }),
	);
	assert.throws(() =>
		parseAiSearchInterpreterRequest({
			intent: "invoice\u202Efdp.exe",
			timezone: "Africa/Cairo",
		}),
	);
});

test("serializes a closed filter object into canonical Search v2 grammar", () => {
	assert.equal(
		serializeAiSearchFilters(filters),
		'proposal "renewal terms" from:sam@example.com subject:"Q3 plan" filename:"price list.pdf" in:inbox is:unread is:starred has:attachment after:2026-07-01 before:2026-08-01',
	);
	assert.deepEqual(parseAiSearchFilters(filters), filters);
});

test("rejects empty, contradictory, noncanonical, and unrepresentable filters", () => {
	assert.throws(() => serializeAiSearchFilters({ ...filters, terms: [], phrases: [], from: [], subject: [], filename: [], folders: [], isRead: null, isStarred: null, hasAttachment: false, after: null, before: null }));
	assert.throws(() => parseAiSearchFilters({ ...filters, after: "2026-08-01", before: "2026-07-01" }));
	assert.throws(() => parseAiSearchFilters({ ...filters, terms: [" padded "] }));
	assert.throws(() => parseAiSearchFilters({ ...filters, from: ["sam", "sam"] }));
	assert.throws(() => parseAiSearchFilters({ ...filters, terms: ["invoice\u202Efdp.exe"] }));
	assert.throws(() => serializeAiSearchFilters({ ...filters, terms: ["status:update"] }));
	assert.throws(() => parseAiSearchFilters({ ...filters, hidden: true }));
});

test("round-trips quoted filter values and operator-looking exact phrases", () => {
	assert.equal(
		serializeAiSearchFilters({
			...filters,
			terms: [],
			phrases: ['status: "ready"'],
			from: ['Sam "Sales"'],
			subject: [],
			filename: [],
			folders: [],
			isRead: null,
			isStarred: null,
			hasAttachment: false,
			after: null,
			before: null,
		}),
		'"status: \\"ready\\"" from:"Sam \\"Sales\\""',
	);
});

test("accepts only internally consistent reviewed responses and fixed non-ready states", () => {
	const query = serializeAiSearchFilters(filters);
	assert.deepEqual(
		parseAiSearchInterpreterResponse({
			state: "generated",
			query,
			labelId: "label-priority",
			filters,
			requiresReview: true,
		}),
		{
			state: "generated",
			query,
			labelId: "label-priority",
			filters,
			requiresReview: true,
		},
	);
	assert.deepEqual(parseAiSearchInterpreterResponse({ state: "ambiguous" }), {
		state: "ambiguous",
	});
	assert.throws(() =>
		parseAiSearchInterpreterResponse({
			state: "cached",
			query: `${query} extra`,
			labelId: null,
			filters,
			requiresReview: true,
		}),
	);
	assert.throws(() =>
		parseAiSearchInterpreterResponse({ state: "unsupported", reason: "model prose" }),
	);
	assert.throws(() =>
		parseAiSearchInterpreterResponse({
			state: "generated",
			query,
			labelId: "label\u0000priority",
			filters,
			requiresReview: true,
		}),
	);
});

test("allows an empty canonical query only for an explicit reviewed label", () => {
	const emptyFilters = {
		terms: [],
		phrases: [],
		from: [],
		to: [],
		subject: [],
		filename: [],
		folders: [],
		isRead: null,
		isStarred: null,
		hasAttachment: false,
		after: null,
		before: null,
	};
	assert.equal(serializeAiSearchFilters(emptyFilters, { allowEmpty: true }), "");
	assert.deepEqual(
		parseAiSearchInterpreterResponse({
			state: "generated",
			query: "",
			labelId: "label-priority",
			filters: emptyFilters,
			requiresReview: true,
		}),
		{
			state: "generated",
			query: "",
			labelId: "label-priority",
			filters: emptyFilters,
			requiresReview: true,
		},
	);
	assert.throws(() =>
		parseAiSearchInterpreterResponse({
			state: "generated",
			query: "",
			labelId: null,
			filters: emptyFilters,
			requiresReview: true,
		}),
	);
});
