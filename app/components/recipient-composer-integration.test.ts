import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	filterRecipientSuggestions,
	mergeRecipients,
	nextRecipientComboboxAction,
	serializeRecipients,
} from "../lib/recipient-input.ts";
import { parseRecipientText } from "../../shared/recipient-addresses.ts";
import { recipientSuggestionKeys } from "../queries/recipient-suggestions.ts";

const compose = readFileSync(
	new URL("./ComposeEmail.tsx", import.meta.url),
	"utf8",
);
const composeForm = readFileSync(
	new URL("../hooks/useComposeForm.ts", import.meta.url),
	"utf8",
);
const richTextEditor = readFileSync(
	new URL("./RichTextEditor.tsx", import.meta.url),
	"utf8",
);

test("compose mounts the accessible mailbox-scoped recipient combobox for To, Cc, and Bcc", () => {
	assert.match(compose, /import RecipientCombobox from "\.\/RecipientCombobox"/);
	assert.equal((compose.match(/<RecipientCombobox/g) ?? []).length, 3);
	for (const field of ["to", "cc", "bcc"]) {
		assert.match(
			compose,
			new RegExp(
				`<RecipientCombobox[\\s\\S]*?field="${field}"[\\s\\S]*?mailboxId=\\{originMailboxId \\?\\? ""\\}`,
			),
		);
	}
	assert.match(compose, /const recipientValues = useMemo\(\(\) => \(\{ to, cc, bcc \}\)/);
	assert.equal((compose.match(/recipients=\{recipientValues\}/g) ?? []).length, 3);
	assert.match(compose, /field="to"[\s\S]*?autoFocus[\s\S]*?required/);
	// Cc and Bcc open separately and stay open once they hold anyone.
	assert.match(compose, /\{!showCc && \(/);
	assert.match(compose, /\{!showBcc && \(/);
	assert.match(compose, /if \(cc\.trim\(\)\) setOpenedCc\(true\)/);
	assert.match(compose, /if \(bcc\.trim\(\)\) setOpenedBcc\(true\)/);
});

test("initial editor normalization does not steal focus from the To field", () => {
	assert.match(richTextEditor, /const initialValueRef = useRef\(value\)/);
	assert.match(
		richTextEditor,
		/const shouldRestoreEditorFocus = value !== initialValueRef\.current;[\s\S]*?if \(!shouldRestoreEditorFocus\) return;[\s\S]*?editor\.commands\.focus\('start'\)/,
	);
});

test("compose recipient behavior preserves free-form input and isolates mailbox sessions", () => {
	const recipients = {
		to: "First Person <first@example.com>, ali",
		cc: "copy@example.com",
		bcc: "blind@example.com",
	};
	const suggestions = filterRecipientSuggestions(
		[
			{ address: "team-a@example.com", sentCount: 4, receivedCount: 1, lastSentAt: null, lastReceivedAt: null },
			{ address: "copy@example.com", sentCount: 3, receivedCount: 1, lastSentAt: null, lastReceivedAt: null },
			{ address: "alice@example.com", sentCount: 2, receivedCount: 0, lastSentAt: null, lastReceivedAt: null },
		],
		{ ...recipients, mailboxAddress: "team-a@example.com" },
	);
	assert.deepEqual(suggestions.map(({ address }) => address), ["alice@example.com"]);
	// Accepting a suggestion adds it as one more recipient of the field.
	assert.equal(
		serializeRecipients(
			mergeRecipients(parseRecipientText(recipients.to), ["alice@example.com"]),
		),
		"first@example.com, ali, alice@example.com",
	);
	assert.deepEqual(nextRecipientComboboxAction("Tab", 0, 1, true), {
		kind: "accept",
		index: 0,
	});
	assert.deepEqual(nextRecipientComboboxAction("Escape", -1, 0, true), {
		kind: "close",
	});
	assert.deepEqual(nextRecipientComboboxAction("Escape", -1, 0, false), {
		kind: "ignored",
	});
	assert.notDeepEqual(
		recipientSuggestionKeys.list("team-a@example.com", "ali", 10),
		recipientSuggestionKeys.list("team-b@example.com", "ali", 10),
	);
});

test("Reply-All self exclusion uses the pinned origin before mailbox settings hydrate", () => {
	assert.match(
		composeForm,
		/buildInitialComposeFields\(\{[\s\S]*?composeOptions,[\s\S]*?mailboxEmail: composeMailboxId,[\s\S]*?signature: signatureSnapshotRef\.current/,
	);
	assert.doesNotMatch(
		composeForm,
		/mailboxEmail: currentMailbox\?\.email/,
	);
});
