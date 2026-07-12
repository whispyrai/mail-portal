import assert from "node:assert/strict";
import test from "node:test";
import type { RecipientSuggestion } from "../../shared/recipient-suggestions.ts";
import {
	applyRecipientComboboxKeyEvent,
	activeRecipientSegment,
	filterRecipientSuggestions,
	nextRecipientComboboxAction,
	replaceActiveRecipientSegment,
	replaceActiveRecipientSegmentWithCursor,
	replyAllRecipientFields,
	splitRecipientValues,
} from "./recipient-input.ts";

test("Escape consumed by an open popup cannot dismiss its parent dialog", () => {
	const calls: string[] = [];
	const openAction = applyRecipientComboboxKeyEvent(
		{
			key: "Escape",
			preventDefault: () => calls.push("preventDefault"),
			stopPropagation: () => calls.push("stopPropagation"),
		},
		-1,
		0,
		true,
	);
	assert.deepEqual(openAction, { kind: "close" });
	assert.deepEqual(calls, ["preventDefault", "stopPropagation"]);

	calls.length = 0;
	const closedAction = applyRecipientComboboxKeyEvent(
		{
			key: "Escape",
			preventDefault: () => calls.push("preventDefault"),
			stopPropagation: () => calls.push("stopPropagation"),
		},
		-1,
		0,
		false,
	);
	assert.deepEqual(closedAction, { kind: "ignored" });
	assert.deepEqual(calls, []);
});

test("cold Reply-All excludes the pinned origin mailbox before mailbox settings hydrate", () => {
	assert.deepEqual(
		replyAllRecipientFields({
			sender: "sender@example.com",
			to: "Team <team@example.com>, other@example.com",
			cc: "TEAM@example.com, copy@example.com, sender@example.com",
			mailboxAddress: "team@example.com",
		}),
		{
			to: "sender@example.com, other@example.com",
			cc: "copy@example.com",
			showCcBcc: true,
		},
	);
});

test("active recipient segment follows the caret without losing free-form values", () => {
	const value = "First Person <first@example.com>,  ali, final@example.com";
	assert.deepEqual(activeRecipientSegment(value, value.indexOf("ali") + 2), {
		start: 33,
		end: 38,
		raw: "  ali",
		token: "ali",
	});
	assert.equal(
		replaceActiveRecipientSegment(value, value.indexOf("ali") + 2, "alice@example.com"),
		"First Person <first@example.com>, alice@example.com, final@example.com",
	);
	assert.deepEqual(
		replaceActiveRecipientSegmentWithCursor(
			value,
			value.indexOf("ali") + 2,
			"alice@example.com",
		),
		{
			value: "First Person <first@example.com>, alice@example.com, final@example.com",
			cursor: 51,
		},
	);
	assert.deepEqual(splitRecipientValues(" first@example.com, , Second@Example.com "), [
		"first@example.com",
		"Second@Example.com",
	]);
});

test("suggestions exclude mailbox self and duplicates across every recipient field", () => {
	const suggestions: RecipientSuggestion[] = [
		{ address: "Team@example.com", sentCount: 3, receivedCount: 0, lastSentAt: null, lastReceivedAt: null },
		{ address: "already@example.com", sentCount: 2, receivedCount: 0, lastSentAt: null, lastReceivedAt: null },
		{ address: "copy@example.com", sentCount: 1, receivedCount: 0, lastSentAt: null, lastReceivedAt: null },
		{ address: "new@example.com", sentCount: 1, receivedCount: 0, lastSentAt: null, lastReceivedAt: null },
	];
	assert.deepEqual(
		filterRecipientSuggestions(suggestions, {
			mailboxAddress: "team@example.com",
			to: "Someone <already@example.com>",
			cc: "Copy@Example.com",
			bcc: "",
		}),
		[suggestions[3]],
	);
});

test("keyboard actions navigate, accept with Enter or Tab, close, and preserve arbitrary typing", () => {
	assert.deepEqual(nextRecipientComboboxAction("ArrowDown", -1, 3), { kind: "move", index: 0 });
	assert.deepEqual(nextRecipientComboboxAction("ArrowUp", 0, 3), { kind: "move", index: 2 });
	assert.deepEqual(nextRecipientComboboxAction("Enter", 1, 3), { kind: "accept", index: 1 });
	assert.deepEqual(nextRecipientComboboxAction("Tab", 1, 3), { kind: "accept", index: 1 });
	assert.deepEqual(nextRecipientComboboxAction("Escape", 1, 3), { kind: "close" });
	assert.deepEqual(nextRecipientComboboxAction("Escape", -1, 0, true), { kind: "close" });
	assert.deepEqual(nextRecipientComboboxAction("Escape", -1, 0, false), { kind: "ignored" });
	assert.deepEqual(nextRecipientComboboxAction("Enter", -1, 3), { kind: "ignored" });
	assert.deepEqual(nextRecipientComboboxAction("x", 1, 3), { kind: "ignored" });
});
