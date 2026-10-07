import assert from "node:assert/strict";
import test from "node:test";
import type { RecipientSuggestion } from "../../shared/recipient-suggestions.ts";
import {
	isValidRecipientAddress,
	parseRecipientText,
	sendableRecipients,
} from "../../shared/recipient-addresses.ts";
import {
	applyRecipientComboboxKeyEvent,
	filterRecipientSuggestions,
	mergeRecipients,
	nextRecipientComboboxAction,
	recipientProblem,
	replyRecipientFields,
	splitFinishedRecipients,
	storedHeaderValues,
} from "./recipient-input.ts";

const mailbox = "team@example.com";

function headers(entries: Record<string, string>): string {
	return JSON.stringify(
		Object.entries(entries).map(([key, value]) => ({ key, value })),
	);
}

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

test("typed and pasted text becomes one recipient per address", () => {
	assert.deepEqual(
		parseRecipientText(
			'"Hamilton, Margaret" <margaret@apollo.example>; Ken <ken@bell.example>\nrob@bell.example  mailto:dennis@bell.example',
		),
		[
			"margaret@apollo.example",
			"ken@bell.example",
			"rob@bell.example",
			"dennis@bell.example",
		],
	);
	assert.deepEqual(parseRecipientText(" a@x.com , , b@y.com "), ["a@x.com", "b@y.com"]);
	// A comma inside a comment does not split, and no address beside a
	// bracketed one is ever dropped.
	assert.deepEqual(
		parseRecipientText("Ada (Sales, EMEA) <ada@example.com>, Bob <bob@example.com> carol@example.com"),
		["ada@example.com", "bob@example.com", "carol@example.com"],
	);
	assert.deepEqual(
		parseRecipientText('"Smith \\"Jr\\", Bob" <bob@example.com>'),
		["bob@example.com"],
	);
	// Text with no address is kept so the writer sees it and can fix it, and so
	// is a stray word typed beside an address. A display name given the
	// standard way, quoted or before <address>, is not a recipient.
	assert.deepEqual(parseRecipientText("bob, Grace Hopper"), ["bob", "Grace Hopper"]);
	assert.deepEqual(parseRecipientText("alice bob@x.com"), ["alice", "bob@x.com"]);
	assert.deepEqual(parseRecipientText("Grace Hopper <grace@x.com>"), ["grace@x.com"]);
	assert.deepEqual(parseRecipientText('"Grace Hopper" grace@x.com'), ["grace@x.com"]);
});

test("only text before the last separator is finished", () => {
	assert.deepEqual(splitFinishedRecipients("a@x.com, b@y"), {
		finished: "a@x.com",
		pending: "b@y",
	});
	assert.deepEqual(splitFinishedRecipients('"Hamilton, Marg'), {
		finished: "",
		pending: '"Hamilton, Marg',
	});
	assert.deepEqual(splitFinishedRecipients('"Smith \\"Jr\\", Bob" <b'), {
		finished: "",
		pending: '"Smith \\"Jr\\", Bob" <b',
	});
	assert.deepEqual(splitFinishedRecipients("Ada (Sales, EMEA"), {
		finished: "",
		pending: "Ada (Sales, EMEA",
	});
	assert.deepEqual(splitFinishedRecipients("ada@calculus.example;"), {
		finished: "ada@calculus.example",
		pending: "",
	});
});

test("address checks match what the send API accepts", () => {
	for (const valid of ["a@x.co", "first.last+tag@sub.example.com", "o'neil@example.ie"]) {
		assert.equal(isValidRecipientAddress(valid), true, valid);
	}
	for (const invalid of ["bob", "a@x", "a@@x.com", ".a@x.com", "a..b@x.com", "a@x.com."]) {
		assert.equal(isValidRecipientAddress(invalid), false, invalid);
	}
});

test("a field never holds the same address twice", () => {
	assert.deepEqual(
		mergeRecipients(["Ada@Example.com"], ["ada@example.com", "grace@example.com"]),
		["Ada@Example.com", "grace@example.com"],
	);
});

test("a send carries each address once, in the most visible field", () => {
	assert.deepEqual(
		sendableRecipients({
			to: "a@x.com, b@x.com",
			cc: "B@x.com, c@x.com",
			bcc: "c@x.com, a@x.com, d@x.com",
		}),
		{ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: ["d@x.com"] },
	);
});

test("recipient problems are reported in words the writer can act on", () => {
	assert.equal(recipientProblem({ to: "", cc: "", bcc: "" }), "Add at least one recipient.");
	assert.equal(
		recipientProblem({ to: "", cc: "a@x.com", bcc: "" }),
		"Add at least one recipient in To.",
	);
	assert.equal(
		recipientProblem({ to: "a@x.com, bob", cc: "", bcc: "" }),
		"“bob” is not a valid email address. Fix or remove it before sending.",
	);
	const thirty = (prefix: string) =>
		Array.from({ length: 30 }, (_, index) => `${prefix}${index}@x.com`).join(", ");
	assert.match(
		recipientProblem({ to: thirty("to"), cc: thirty("cc"), bcc: "" }) ?? "",
		/60 recipients[\s\S]*at most 50/,
	);
	assert.equal(recipientProblem({ to: thirty("to"), cc: thirty("to"), bcc: "" }), null);
});

test("Reply answers the sender, or the Reply-To address when one is set", () => {
	const original = {
		sender: "noreply@forms.example",
		recipient: mailbox,
		raw_headers: headers({
			from: "Website Forms <noreply@forms.example>",
			"reply-to": "Customer Person <customer@buyer.example>",
		}),
	};
	assert.deepEqual(
		replyRecipientFields({ original, mailboxAddress: mailbox, all: false }),
		{ to: "customer@buyer.example", cc: "" },
	);
	assert.deepEqual(
		replyRecipientFields({
			original: { ...original, raw_headers: null },
			mailboxAddress: mailbox,
			all: false,
		}),
		{ to: "noreply@forms.example", cc: "" },
	);
});

test("Reply all keeps everyone except the mailbox, Cc staying Cc", () => {
	assert.deepEqual(
		replyRecipientFields({
			original: {
				sender: "grace@partner.example",
				recipient: "ada@calculus.example, TEAM@example.com",
				cc: "linus@kernel.example, team@example.com, grace@partner.example",
			},
			mailboxAddress: mailbox,
			all: true,
		}),
		{
			to: "grace@partner.example, ada@calculus.example",
			cc: "linus@kernel.example",
		},
	);
});

test("Reply all on a message we were only copied on goes to its sender and To", () => {
	assert.deepEqual(
		replyRecipientFields({
			original: {
				sender: "ken@bell.example",
				recipient: "rob@bell.example",
				cc: mailbox,
			},
			mailboxAddress: mailbox,
			all: true,
		}),
		{ to: "ken@bell.example, rob@bell.example", cc: "" },
	);
});

test("answering our own message goes back to the people it went to", () => {
	const sent = {
		sender: mailbox,
		recipient: "ada@calculus.example, grace@partner.example",
		cc: "linus@kernel.example",
	};
	assert.deepEqual(
		replyRecipientFields({ original: sent, mailboxAddress: mailbox, all: false }),
		{ to: "ada@calculus.example, grace@partner.example", cc: "" },
	);
	assert.deepEqual(
		replyRecipientFields({ original: sent, mailboxAddress: mailbox, all: true }),
		{
			to: "ada@calculus.example, grace@partner.example",
			cc: "linus@kernel.example",
		},
	);
	// Our own message sent only by Cc goes back to those people.
	assert.deepEqual(
		replyRecipientFields({
			original: { sender: mailbox, recipient: "", cc: "linus@kernel.example" },
			mailboxAddress: mailbox,
			all: false,
		}),
		{ to: "linus@kernel.example", cc: "" },
	);
	// A note to self still has somewhere to go.
	assert.deepEqual(
		replyRecipientFields({
			original: { sender: mailbox, recipient: mailbox },
			mailboxAddress: mailbox,
			all: true,
		}),
		{ to: mailbox, cc: "" },
	);
});

test("stored headers are read only from received mail's header list", () => {
	assert.deepEqual(
		storedHeaderValues(headers({ "Reply-To": "a@x.com" }), "reply-to"),
		["a@x.com"],
	);
	assert.deepEqual(storedHeaderValues('{"kind":"outbound-snapshot"}', "reply-to"), []);
	assert.deepEqual(storedHeaderValues("not json", "reply-to"), []);
	assert.deepEqual(storedHeaderValues(null, "reply-to"), []);
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
			mailboxAddress: mailbox,
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
