import assert from "node:assert/strict";
import test from "node:test";
import { initialSignatureFormState, signatureFormReducer } from "./signature-settings-form.ts";

test("signature hydration is mailbox keyed and never overwrites local typing", () => {
	let state = signatureFormReducer(initialSignatureFormState("one@example.com"), {
		type: "hydrate", mailboxId: "one@example.com", signature: { enabled: true, text: "Server one" },
	});
	state = signatureFormReducer(state, {
		type: "edit_text",
		mailboxId: "one@example.com",
		text: "My unfinished signature",
	});
	assert.equal(signatureFormReducer(state, {
		type: "hydrate", mailboxId: "one@example.com", signature: { enabled: false, text: "Late server value" },
	}).text, "My unfinished signature");
	state = signatureFormReducer(state, { type: "mailbox_changed", mailboxId: "two@example.com" });
	assert.deepEqual(signatureFormReducer(state, {
		type: "hydrate", mailboxId: "one@example.com", signature: { enabled: true, text: "Late mailbox one" },
	}), state);
	state = signatureFormReducer(state, {
		type: "hydrate", mailboxId: "two@example.com", signature: { enabled: false, text: "Server two" },
	});
	assert.deepEqual({ mailboxId: state.mailboxId, enabled: state.enabled, text: state.text, dirty: state.dirty }, {
		mailboxId: "two@example.com", enabled: false, text: "Server two", dirty: false,
	});
});

test("signature save status is independent and preserves failed edits", () => {
	let state = signatureFormReducer(initialSignatureFormState("team@example.com"), {
		type: "edit_text",
		mailboxId: "team@example.com",
		text: "Draft",
	});
	const revision = state.revision;
	state = signatureFormReducer(state, {
		type: "save_started",
		mailboxId: "team@example.com",
		token: 1,
		revision,
	});
	assert.equal(state.status, "saving");
	state = signatureFormReducer(state, {
		type: "save_failed",
		mailboxId: "team@example.com",
		token: 1,
		revision,
		error: "Could not save",
	});
	assert.equal(state.text, "Draft");
	assert.equal(state.dirty, true);
	assert.equal(state.error, "Could not save");
	state = signatureFormReducer(state, {
		type: "save_started",
		mailboxId: "team@example.com",
		token: 2,
		revision,
	});
	state = signatureFormReducer(state, {
		type: "save_succeeded",
		mailboxId: "team@example.com",
		token: 2,
		revision,
		signature: { enabled: true, text: "Draft" },
	});
	assert.equal(state.status, "saved");
	assert.equal(state.dirty, false);
});

test("a save response confirms only its captured mailbox revision and preserves newer edits", () => {
	let state = signatureFormReducer(initialSignatureFormState("team@example.com"), {
		type: "hydrate",
		mailboxId: "team@example.com",
		signature: { enabled: false, text: "Server" },
	});
	state = signatureFormReducer(state, {
		type: "edit_text",
		mailboxId: "team@example.com",
		text: "Submitted",
	});
	const submittedRevision = state.revision;
	state = signatureFormReducer(state, {
		type: "save_started",
		mailboxId: "team@example.com",
		token: 7,
		revision: submittedRevision,
	});
	state = signatureFormReducer(state, {
		type: "edit_text",
		mailboxId: "team@example.com",
		text: "Typed while saving",
	});
	state = signatureFormReducer(state, {
		type: "save_succeeded",
		mailboxId: "team@example.com",
		token: 7,
		revision: submittedRevision,
		signature: { enabled: false, text: "Submitted" },
	});

	assert.equal(state.text, "Typed while saving");
	assert.equal(state.dirty, true);
	assert.equal(state.status, "idle");
	assert.deepEqual(state.confirmed, { enabled: false, text: "Submitted" });

	state = signatureFormReducer(state, {
		type: "mailbox_changed",
		mailboxId: "other@example.com",
	});
	assert.deepEqual(
		signatureFormReducer(state, {
			type: "save_succeeded",
			mailboxId: "team@example.com",
			token: 7,
			revision: submittedRevision,
			signature: { enabled: true, text: "Late response" },
		}),
		state,
	);
});
