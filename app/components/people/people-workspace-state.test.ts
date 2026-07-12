import assert from "node:assert/strict";
import test from "node:test";
import {
	paramsWithPeopleFilters,
	paramsWithSelectedPerson,
	peopleWorkspaceStateFromParams,
} from "./people-workspace-state.ts";

test("People URL state owns normalized search, sort, and selected identity", () => {
	const state = peopleWorkspaceStateFromParams(new URLSearchParams(
		"q=%20Jose%CC%81%20&sort=frequent&selected=person%2F1",
	));

	assert.deepEqual(state, {
		q: "José",
		sort: "frequent",
		invalidQuery: null,
		invalidSort: null,
		invalidSelection: null,
		selected: "person/1",
	});
});

test("unsafe or oversized query state is not returned for requests", () => {
	const unsafeQuery = peopleWorkspaceStateFromParams(new URLSearchParams(
		`q=${encodeURIComponent("safe\u202Eunsafe")}`,
	));
	assert.equal(unsafeQuery.q, "");
	assert.match(unsafeQuery.invalidQuery ?? "", /cannot contain control characters/i);

	const oversizedSelection = peopleWorkspaceStateFromParams(new URLSearchParams({
		selected: "p".repeat(321),
	}));
	assert.equal(oversizedSelection.selected, null);
	assert.match(oversizedSelection.invalidSelection ?? "", /invalid/i);
});

test("invalid sort values fail closed without reflecting control characters", () => {
	const state = peopleWorkspaceStateFromParams(new URLSearchParams(
		"sort=%E2%80%AEunknown",
	));

	assert.equal(state.sort, "recent");
	assert.equal(state.invalidSort, "invalid value");
});

test("filter changes clear selection while selection preserves filters", () => {
	const current = new URLSearchParams(
		"q=old&sort=address&selected=person-1&unrelated=kept",
	);
	assert.equal(
		paramsWithPeopleFilters(current, { q: " Ada ", sort: "recent" }).toString(),
		"q=Ada&unrelated=kept",
	);
	assert.equal(
		paramsWithSelectedPerson(current, "person-2").toString(),
		"q=old&sort=address&selected=person-2&unrelated=kept",
	);
});
