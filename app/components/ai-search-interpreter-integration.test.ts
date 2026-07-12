import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const header = read("./Header.tsx");
const workspace = read("./AiSearchWorkspace.tsx");
const route = read("../routes/search-results.tsx");
const query = read("../queries/search.ts");
const api = read("../services/api.ts");

test("Header opens AI builder state without committing result parameters", () => {
	assert.match(header, /AI search/);
	assert.match(header, /state: \{ aiSearchDraft: searchQuery\.trim\(\) \}/);
	assert.doesNotMatch(header, /next\.set\("draft"/);
	assert.match(
		header,
		/location\.pathname\.includes\("\/search"\) \? urlQuery \|\| navigationDraft : ""/,
	);
	assert.match(header, /\[mailboxId, urlQuery, navigationDraft, location\.pathname\]/);
});

test("inline workspace requires explicit Interpret, review, and Run search", () => {
	assert.match(workspace, /aria-label="Interpret an AI mail search"/);
	assert.match(workspace, /onSubmit=\{\(event\) =>/);
	assert.match(workspace, /void interpret\(\)/);
	assert.match(workspace, /Review ordinary search filters/);
	assert.match(workspace, /Run search/);
	assert.match(workspace, /onRun\(validation\.parsed\.query, reviewLabelId\)/);
	assert.match(workspace, /no search has run/i);
	assert.match(workspace, /Multiple values inside From, To, Subject, Filename, or Folder match any shown value \(OR\)/);
	assert.match(workspace, /value === reviewedIntent \? "ready" : "intent_stale"/);
	assert.match(workspace, /ambiguous:[\s\S]*unsupported:[\s\S]*budget_paused:[\s\S]*stale:/);
	assert.match(workspace, /aria-live="polite"/);
	assert.match(workspace, /tabIndex=\{-1\}/);
	assert.match(workspace, /requestAnimationFrame\(\(\) => reviewHeadingRef\.current\?\.focus\(\)\)/);
	assert.match(workspace, /className="min-h-11"/);
	assert.match(workspace, /disabled=\{!canRun\}/);
	assert.match(workspace, /labelCatalogState !== "ready"/);
	assert.match(workspace, /state === "ready" &&\s*labelCatalogState === "ready"/);
	assert.match(workspace, /Mailbox filters are unavailable/);
	assert.match(workspace, /!validation\.ok && \(/);
	assert.doesNotMatch(workspace, /useEffect\([\s\S]{0,180}interpret\(\)/);
});

test("Search route commits only reviewed q and label and closes stale panel on entry", () => {
	assert.match(route, /<AiSearchWorkspace/);
	assert.match(route, /initialIntent=\{draftIntent\}/);
	assert.match(route, /mailboxId && !hasCommittedSearch && \(/);
	assert.doesNotMatch(route, /searchParams\.get\("draft"\)/);
	assert.match(route, /const runReviewedSearch = \(query: string, nextLabelId: string \| null\)/);
	assert.match(route, /const next = new URLSearchParams\(\)/);
	assert.match(route, /next\.set\("q", query\)/);
	assert.match(route, /next\.set\("label_id", nextLabelId\)/);
	assert.match(route, /setSearchParams\(next\)/);
	assert.match(route, /useEffect\(\(\) => \{\s*closePanel\(\);/);
	assert.match(route, /!hadCommittedSearchRef\.current && hasCommittedSearch/);
	assert.match(route, /resultsHeadingRef\.current\?\.focus\(\)/);
});

test("committed result search forwards TanStack cancellation", () => {
	assert.match(query, /queryFn: async \(\{ signal \}\)/);
	assert.match(query, /api\.searchEmails\(mailboxId!, params, \{ signal \}\)/);
	assert.match(
		api,
		/searchEmails:[\s\S]*?opts\?: \{ signal\?: AbortSignal \}[\s\S]*?signal: opts\?\.signal/,
	);
});
