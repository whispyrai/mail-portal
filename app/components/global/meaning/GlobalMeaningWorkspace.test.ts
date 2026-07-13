import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const workspace = read("./GlobalMeaningWorkspace.tsx");
const resultRow = read("./MeaningResultRow.tsx");
const status = read("./MeaningStatusPanel.tsx");
const form = read("./MeaningSearchForm.tsx");
const route = read("../../../routes/global-meaning.tsx");
const shell = read("../GlobalShell.tsx");
const routes = read("../../../routes.ts");
const service = read("../../../services/semantic-search.ts");
const session = read("../../../lib/semantic-search-session.ts");

test("Meaning is a feature-gated first-class global evidence destination", () => {
	assert.match(routes, /route\("meaning", "routes\/global-meaning\.tsx"\)/);
	assert.match(shell, /semanticSearchEnabled[\s\S]*\/meaning/);
	assert.match(route, /semanticSearchEnabled/);
	assert.match(route, /throw redirect\("\/today"\)/);
	assert.match(workspace, /Cross-Mailbox evidence/);
	assert.match(workspace, /not an AI-written answer/);
});

test("Meaning exposes every truthful readiness, recovery, and zero-evidence state", () => {
	for (const copy of [
		"Results may be incomplete",
		"This is not a no-results conclusion",
		"still preparing",
		"unavailable right now",
		"You are offline",
		"Mailbox access changed",
		"No active-history evidence matched this meaning",
	]) assert.match(`${workspace}\n${status}`, new RegExp(copy));
	assert.match(status, /Mailbox readiness/);
	assert.match(workspace, /Top \$\{SEMANTIC_SEARCH_LIMITS\.resultLimit\} evidence matches/);
	assert.match(workspace, /No evidence matched in the Mailboxes searched so far/);
	assert.match(workspace, /No evidence is available because none of your Mailboxes could be searched/);
	assert.match(workspace, /animate-pulse/);
	assert.match(status, /aria-live="polite"/);
});

test("Meaning evidence remains compound, attributable, read-only, and free of model internals", () => {
	assert.match(workspace, /semanticSearchResultIdentity\(result\.mailboxId, result\.messageId\)/);
	assert.match(resultRow, /result\.mailboxAddress/);
	assert.match(resultRow, /result\.folderId/);
	assert.match(resultRow, /result\.counterparty/);
	assert.match(resultRow, /result\.excerpt/);
	assert.match(resultRow, /Show full excerpt/);
	assert.match(resultRow, /aria-controls=\{excerptId\}/);
	assert.doesNotMatch(resultRow, /line-clamp/);
	assert.match(resultRow, /\/open\/\$\{encodeURIComponent\(result\.messageId\)\}/);
	assert.doesNotMatch(`${workspace}\n${resultRow}\n${route}`, /markRead|markUnread|toggleUnread|score\}|vectorId|modelName/);
});

test("Meaning keeps sensitive query and evidence state out of URLs and persistent storage", () => {
	assert.match(service, /fetch\("\/api\/v1\/semantic-search"/);
	assert.match(service, /method: "POST"/);
	assert.match(service, /cache: "no-store"/);
	assert.match(form, /stays out of the URL and browser history/);
	assert.match(route, /useSyncExternalStore/);
	assert.match(route, /getSemanticSearchServerSnapshot/);
	assert.match(route, /reconcileMailboxChangeFeedOnce/);
	assert.match(session, /BroadcastChannel/);
	assert.doesNotMatch(`${route}\n${session}`, /localStorage\.setItem|sessionStorage|useSearchParams|history\.state/);
});

test("Meaning cannot commit evidence across a change-feed or superseded-request race", () => {
	const attempt = route.indexOf("for (let attempt = 0; attempt < 2; attempt += 1)");
	const baseline = route.indexOf("await resetSemanticMailboxBaselines", attempt);
	const search = route.indexOf("const candidate = await searchSemanticEvidence", baseline);
	const reconcile = route.indexOf("reconcileMailboxChangeFeedOnce({", search);
	const write = route.indexOf("writeSemanticSearchSession({", search);
	assert.ok(baseline >= 0 && search > baseline && reconcile > search && write > reconcile);
	assert.match(route, /changePages\.some\(semanticMailboxChangesAffectEvidence\)/);
	assert.match(route, /await api\.getCurrentActor\(\{ signal: controller\.signal \}\)\)\.email;[\s\S]*requestRef\.current\?\.sequence !== sequence/);
	assert.match(route, /revokedMailboxIds[\s\S]*exitRevokedMailbox/);
	assert.match(route, /error\.status === 403[\s\S]*exitRevokedMailbox/);
	assert.match(route, /const restoreSequence = requestSequence\.current/);
	assert.match(route, /requestSequence\.current !== restoreSequence/);
	assert.match(route, /readSemanticSearchSession\(\)\?\.createdAt !== candidate\.createdAt/);
	assert.match(route, /acceptedBaselineMailboxIds = baselineMailboxIds/);
	assert.match(route, /previouslyAccessibleMailboxIds[\s\S]*exitRevokedMailbox/);
	assert.match(route, /MEANING_OPERATION_TIMEOUT_MS = 30_000/);
	assert.match(route, /operationTimedOut = true;[\s\S]*controller\.abort\(\)/);
	assert.match(route, /api\.listMailboxes\(\{ signal: controller\.signal \}\)/);
	assert.match(route, /signal: controller\.signal,[\s\S]*isCurrent/);
	assert.match(route, /if \(cancelled \|\| requestSequence\.current !== restoreSequence\) return;[\s\S]*clearSemanticSearchSession\(\)/);
});

test("Meaning remains mobile-safe and keyboard reachable without horizontal dependence", () => {
	assert.match(form, /sm:grid-cols/);
	assert.match(form, /min-h-12/);
	assert.match(resultRow, /min-h-11/);
	assert.match(workspace, /min-w-0/);
	assert.match(workspace, /tabIndex=\{-1\}/);
	assert.match(route, /requestAnimationFrame\(\(\) =>[\s\S]*resultsHeadingRef\.current\?\.focus\(\)/);
	assert.doesNotMatch(`${workspace}\n${resultRow}\n${status}`, /overflow-x-auto|whitespace-nowrap/);
});
