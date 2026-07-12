import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("People is a first-class mailbox route and sidebar destination", async () => {
	const [routes, sidebar] = await Promise.all([
		readFile(new URL("routes.ts", root), "utf8"),
		readFile(new URL("components/Sidebar.tsx", root), "utf8"),
	]);
	assert.match(routes, /route\("people", "routes\/people\.tsx"\)/);
	assert.match(sidebar, /\/people`}/);
	assert.match(sidebar, /label="People"/);
});

test("People adapts from list-detail to one-pane navigation with complete recovery states", async () => {
	const workspace = await readFile(
		new URL("components/people/PeopleWorkspace.tsx", root),
		"utf8",
	);
	assert.match(workspace, /new ResizeObserver/);
	assert.match(workspace, /supportsSplitView\(containerWidth\)/);
	assert.match(workspace, /clampListPaneWidth\(listPaneWidth, containerWidth\)/);
	assert.match(workspace, /focusOriginRef/);
	assert.match(workspace, /requestAnimationFrame/);
	assert.match(workspace, /paramsWithSelectedPerson/);
	assert.match(workspace, /Building relationship history/);
	assert.match(workspace, /No relationship history yet/);
	assert.match(workspace, /People could not load/);
	assert.match(workspace, /Try again/);
	assert.match(workspace, /min-h-11/);
	assert.match(workspace, /invalidUrlState/);
	assert.match(workspace, /const \[revokedByFeature, setRevokedByFeature\] = useState\(false\)/);
	assert.match(workspace, /exitForRevokedAccess = useCallback\(\([\s\S]*?revokedMailboxId = mailboxId,[\s\S]*?active = true,[\s\S]*?setRevokedByFeature\(true\)/);
	assert.match(workspace, /if \(!active \|\| revokedMailboxId !== mailboxId\) \{[\s\S]*?mailboxId: revokedMailboxId,[\s\S]*?return;/);
	assert.match(workspace, /const accessRevoked = revokedByFeature \|\|/);
	assert.match(
		workspace,
		/if \(accessRevoked\) \{[\s\S]*?return \([\s\S]*?Mailbox access changed[\s\S]*?\);[\s\S]*?\}[\s\S]*?return \([\s\S]*?<div ref=\{canvasRef\}/,
		"a list 403 must replace cached list and selected-detail content before navigation effects run",
	);
});

test("relationship actions use observed facts and exact non-mutating mail links", async () => {
	const [detail, compose] = await Promise.all([
		readFile(new URL("components/people/PersonDetail.tsx", root), "utf8"),
		readFile(new URL("hooks/useComposeForm.ts", root), "utf8"),
	]);
	assert.match(detail, /initialTo: person\.address/);
	assert.match(detail, /navigator\.clipboard\.writeText\(person\.address\)/);
	assert.match(detail, /conversation\.representativeFolderId/);
	assert.match(detail, /conversation\.representativeMessageId/);
	assert.match(detail, /Open related mail/);
	assert.match(detail, /Recent conversations/);
	assert.match(detail, /Recent files/);
	assert.match(detail, /Mail history/);
	assert.match(detail, /Back to people/);
	assert.doesNotMatch(detail, /updateEmail|mark.*read|read:\s*true/i);
	assert.doesNotMatch(detail, /avatar|company|sentiment|relationship strength/i);
	assert.match(
		compose,
		/const initialFields = recovery[\s\S]*?to: recovery\.to[\s\S]*?: buildInitialComposeFields/,
		"runtime recovery must remain authoritative over a People recipient seed",
	);
});

test("People queries are mailbox-keyed and never invalidate paid AI", async () => {
	const [keys, feed] = await Promise.all([
		readFile(new URL("queries/keys.ts", root), "utf8"),
		readFile(new URL("queries/mailbox-change-feed.ts", root), "utf8"),
	]);
	assert.match(keys, /\["people", mailboxId, "list", filters\]/);
	assert.match(keys, /\["people", mailboxId, "detail", personId\]/);
	assert.match(keys, /\["people", mailboxId, "timeline", personId\]/);
	assert.match(feed, /change\.resource === "message"/);
	assert.match(feed, /change\.resource === "attachment"/);
	assert.doesNotMatch(feed, /relationship-brief/);
});
