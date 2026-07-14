import assert from "node:assert/strict";
import test from "node:test";
import {
	composeDraftFingerprint,
	composeDraftLifecycle,
	composeDraftSaveKey,
	composeDraftIsEmpty,
	composeDraftTransition,
	planComposeClose,
	shouldCaptureProgrammaticComposeChange,
	type ComposeDraftLifecycle,
} from "./compose-draft-lifecycle.ts";

test("Draft save keys survive exact recovery and isolate content revisions", async () => {
	const baseline = await composeDraftSaveKey({
		composeKey: "compose-1",
		draftId: "draft-1",
		draftVersion: 3,
		fingerprint: "content-1",
	});
	assert.match(baseline, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	assert.equal(
		await composeDraftSaveKey({
			composeKey: "compose-1",
			draftId: "draft-1",
			draftVersion: 3,
			fingerprint: "content-1",
		}),
		baseline,
	);
	assert.equal(
		await composeDraftSaveKey({
			composeKey: "a-new-browser-runtime",
			draftId: "draft-1",
			draftVersion: 3,
			fingerprint: "content-1",
		}),
		baseline,
	);
	assert.notEqual(
		await composeDraftSaveKey({
			composeKey: "compose-1",
			draftId: "draft-1",
			draftVersion: 3,
			fingerprint: "content-2",
		}),
		baseline,
	);
});

test("late signature insertion is captured unless it is untouched identity-less scaffold", () => {
	assert.equal(
		shouldCaptureProgrammaticComposeChange({
			hasDraftIdentity: false,
			phase: "saved",
			hasUnobservedUserChange: false,
		}),
		false,
	);
	for (const input of [
		{ hasDraftIdentity: true, phase: "saved" as const, hasUnobservedUserChange: false },
		{ hasDraftIdentity: false, phase: "pending" as const, hasUnobservedUserChange: false },
		{ hasDraftIdentity: false, phase: "saving" as const, hasUnobservedUserChange: false },
		{ hasDraftIdentity: false, phase: "failed" as const, hasUnobservedUserChange: false },
		{ hasDraftIdentity: false, phase: "saved" as const, hasUnobservedUserChange: true },
	]) {
		assert.equal(shouldCaptureProgrammaticComposeChange(input), true);
	}
});

test("late signature revision follows clean, in-flight, and failed saves to durable v2", () => {
	let cleanV1: ComposeDraftLifecycle = {
		localRevision: 1,
		savedRevision: 1,
		phase: "saved",
		activeSave: null,
		error: null,
	};
	cleanV1 = composeDraftTransition(cleanV1, { type: "edited" });
	assert.equal(cleanV1.phase, "pending");
	assert.equal(
		planComposeClose({
			isDirty: true,
			isSaving: false,
			hasPersistedDraft: true,
			isEmpty: false,
		}),
		"ask",
	);
	let savingV2 = composeDraftTransition(cleanV1, {
		type: "save-started",
		token: 2,
		revision: 2,
	});
	savingV2 = composeDraftTransition(savingV2, {
		type: "save-succeeded",
		token: 2,
		revision: 2,
	});
	assert.deepEqual(savingV2, {
		localRevision: 2,
		savedRevision: 2,
		phase: "saved",
		activeSave: null,
		error: null,
	});

	let inFlight: ComposeDraftLifecycle = {
		localRevision: 1,
		savedRevision: 0,
		phase: "saving",
		activeSave: { token: 1, revision: 1 },
		error: null,
	};
	inFlight = composeDraftTransition(inFlight, { type: "edited" });
	inFlight = composeDraftTransition(inFlight, {
		type: "save-succeeded",
		token: 1,
		revision: 1,
	});
	assert.equal(inFlight.phase, "pending");
	assert.equal(inFlight.localRevision, 2);
	assert.equal(inFlight.savedRevision, 1);

	const failed = composeDraftTransition(
		{
			localRevision: 1,
			savedRevision: 0,
			phase: "failed",
			activeSave: null,
			error: "offline",
		},
		{ type: "edited" },
	);
	assert.equal(failed.phase, "pending");
	assert.equal(failed.localRevision, 2);
	assert.equal(failed.error, null);
});

test("draft fingerprints track user-visible attachment state without storage identity churn", () => {
	const input = {
		to: "team@example.com",
		cc: "",
		bcc: "",
		subject: "Proposal",
		body: "<p>Ready</p>",
		attachments: [
			{
				filename: "proposal.pdf",
				mimetype: "application/pdf",
				size: 42,
				status: "ready",
				disposition: "attachment",
			},
		],
	};
	const promoted = {
		...input,
		attachments: input.attachments.map((attachment) => ({
			...attachment,
			existing: { emailId: "draft-1", attachmentId: "stored-1" },
		})),
	};

	assert.equal(composeDraftFingerprint(input), composeDraftFingerprint(promoted));
	assert.notEqual(
		composeDraftFingerprint(input),
		composeDraftFingerprint({
			...input,
			attachments: input.attachments.map((attachment) => ({
				...attachment,
				status: "error",
			})),
		}),
	);
});

test("only a truly blank new compose is empty", () => {
	assert.equal(
		composeDraftIsEmpty({
			to: " ",
			cc: "",
			bcc: "",
			subject: "",
			body: "<p><br></p>",
			attachments: [],
		}),
		true,
	);
	assert.equal(
		composeDraftIsEmpty({
			to: "",
			cc: "",
			bcc: "",
			subject: "",
			body: "<p>Keep this</p>",
			attachments: [],
		}),
		false,
	);
	assert.equal(
		composeDraftIsEmpty({
			to: "",
			cc: "",
			bcc: "",
			subject: "",
			body: '<p><img src="data:image/png;base64,abc"></p>',
			attachments: [],
		}),
		false,
	);
});

test("a save completion covers only the revision it captured", () => {
	let state = composeDraftLifecycle();
	state = composeDraftTransition(state, { type: "edited" });
	state = composeDraftTransition(state, {
		type: "save-started",
		token: 1,
		revision: 1,
	});
	state = composeDraftTransition(state, { type: "edited" });
	state = composeDraftTransition(state, {
		type: "save-succeeded",
		token: 1,
		revision: 1,
	});

	assert.deepEqual(state, {
		localRevision: 2,
		savedRevision: 1,
		phase: "pending",
		activeSave: null,
		error: null,
	});
});

test("a stale completion cannot replace the active save state", () => {
	const state = composeDraftTransition(
		{
			localRevision: 3,
			savedRevision: 1,
			phase: "saving",
			activeSave: { token: 9, revision: 3 },
			error: null,
		},
		{ type: "save-succeeded", token: 8, revision: 2 },
	);

	assert.deepEqual(state, {
		localRevision: 3,
		savedRevision: 1,
		phase: "saving",
		activeSave: { token: 9, revision: 3 },
		error: null,
	});
});

test("close policy preserves dirty drafts and closes clean surfaces immediately", () => {
	assert.equal(
		planComposeClose({
			isDirty: false,
			isSaving: false,
			hasPersistedDraft: false,
			isEmpty: true,
		}),
		"close-now",
	);
	assert.equal(
		planComposeClose({
			isDirty: false,
			isSaving: false,
			hasPersistedDraft: false,
			hasUnpersistedInitialDraft: true,
			isEmpty: false,
		}),
		"save-then-close",
	);
	assert.equal(
		planComposeClose({
			isDirty: true,
			isSaving: false,
			hasPersistedDraft: false,
			isEmpty: false,
		}),
		"save-then-close",
	);
	assert.equal(
		planComposeClose({
			isDirty: true,
			isSaving: false,
			hasPersistedDraft: true,
			isEmpty: false,
		}),
		"ask",
	);
	assert.equal(
		planComposeClose({
			isDirty: false,
			isSaving: true,
			hasPersistedDraft: false,
			isEmpty: false,
		}),
		"save-then-close",
	);
});
