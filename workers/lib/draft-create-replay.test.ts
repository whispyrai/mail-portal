import assert from "node:assert/strict";
import test from "node:test";
import { classifyDraftCreateReplay } from "./draft-create-replay.ts";

test("an exact lost-response retry replays only the unchanged version-one commit", () => {
	assert.deepEqual(
		classifyDraftCreateReplay(
			{ id: "draft-1", fingerprint: "same", draftVersion: 1 },
			"same",
		),
		{ status: "replay", draftId: "draft-1" },
	);
});

test("an exact first-create retry conflicts after another session advances the draft", () => {
	assert.deepEqual(
		classifyDraftCreateReplay(
			{ id: "draft-1", fingerprint: "same", draftVersion: 2 },
			"same",
		),
		{
			status: "superseded",
			draftId: "draft-1",
			currentVersion: 2,
		},
	);
});

test("reusing a create key for different content always conflicts", () => {
	assert.deepEqual(
		classifyDraftCreateReplay(
			{ id: "draft-1", fingerprint: "original", draftVersion: 1 },
			"different",
		),
		{
			status: "conflict",
			draftId: "draft-1",
			currentVersion: 1,
		},
	);
});
