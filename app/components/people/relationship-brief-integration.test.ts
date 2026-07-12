import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = new URL("../../", import.meta.url);

test("relationship brief is collapsed and can only reach the model through explicit actions", async () => {
	const [card, query, service, detail] = await Promise.all([
		readFile(new URL("components/people/PersonRelationshipBrief.tsx", app), "utf8"),
		readFile(new URL("queries/relationship-brief.ts", app), "utf8"),
		readFile(new URL("services/relationship-brief.ts", app), "utf8"),
		readFile(new URL("components/people/PersonDetail.tsx", app), "utf8"),
	]);
	assert.match(card, /useState\(false\)/);
	assert.match(card, /Generate relationship brief/);
	assert.match(card, /Refresh/);
	assert.match(card, /request\(false\)/);
	assert.match(card, /request\(true\)/);
	assert.match(query, /queryFn: skipToken/);
	assert.match(query, /useMutation/);
	assert.match(query, /controller\.abort\(\)/);
	assert.match(query, /isAttemptActive/);
	assert.doesNotMatch(query, /refetchInterval/);
	assert.match(service, /method: "POST"/);
	assert.match(service, /JSON\.stringify\(\{ refresh: input\.refresh \}\)/);
	assert.doesNotMatch(service, /method: "GET"/);
	assert.match(detail, /<PersonRelationshipBrief/);
	assert.match(detail, /<PersonRelationshipBrief\s+key=\{personId\}/);
});

test("brief renders only fixed cited sections and never acts on mail", async () => {
	const card = await readFile(
		new URL("components/people/PersonRelationshipBrief.tsx", app),
		"utf8",
	);
	for (const heading of [
		"Recent topics",
		"Open questions",
		"Explicit commitments",
		"Important conversations",
		"Suggested next step",
	]) assert.match(card, new RegExp(heading));
	assert.match(card, /Human review required/);
	assert.match(card, /messageUrl\(mailboxId, citation\.folderId, citation\.messageId\)/);
	assert.match(card, /citation\.subject/);
	assert.match(card, /brief\.requiresHumanReview/);
	assert.doesNotMatch(card, /startCompose|sendEmail|updateEmail|mark.*read|dangerouslySetInnerHTML/i);
});

test("brief has calm unavailable, loading, ready, stale, error, preparing, and budget states", async () => {
	const card = await readFile(
		new URL("components/people/PersonRelationshipBrief.tsx", app),
		"utf8",
	);
	for (const state of [
		"unavailable",
		"preparing",
		"stale",
		"budget_paused",
		"generated",
		"cached",
	]) assert.match(card, new RegExp(state));
	assert.match(card, /Preparing a private brief/);
	assert.match(card, /Mail changed while the brief was being prepared/);
	assert.match(card, /paused by the team’s AI budget controls/);
	assert.match(card, /could not be prepared/);
});
