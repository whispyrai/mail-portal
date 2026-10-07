import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./RecipientCombobox.tsx", import.meta.url), "utf8");

test("recipient combobox exposes the complete accessible listbox contract", () => {
	for (const contract of [
		/role="combobox"/,
		/aria-autocomplete="list"/,
		/aria-controls=/,
		/aria-expanded=/,
		/aria-activedescendant=/,
		/role="listbox"/,
		/role="option"/,
		/aria-selected=/,
		/aria-live="polite"/,
		/htmlFor=\{id\}/,
		/autoFocus=\{autoFocus\}/,
		/aria-required=\{required \|\| undefined\}/,
		/min-h-11/,
	]) assert.match(source, contract);
	assert.doesNotMatch(source, /autoComplete="off"/);
	// Recipients live in chips, so a native `required` on the empty text input
	// would block sending a message that already has recipients.
	assert.doesNotMatch(source, /\srequired=\{required\}/);
});

test("recipient combobox handles keyboard, mouse, async, and clearing states", () => {
	assert.match(source, /applyRecipientComboboxKeyEvent/);
	assert.match(source, /onMouseDown/);
	assert.match(source, /onClick/);
	assert.match(source, /isFetching/);
	assert.match(source, /isError/);
	assert.match(source, /No matching recipients/);
	assert.match(source, /setAnnouncement/);
	assert.match(source, /mailboxId, field/);
	assert.match(source, /token\.length > 0 \|\| suggestions\.length > 0/);
	assert.doesNotMatch(source, /displayName|fullName|contactName/);
});

test("each finished address is a removable, editable chip showing what is sent", () => {
	assert.match(source, /role="list" aria-label=\{`\$\{label\} recipients`\}/);
	assert.match(source, /role="listitem"/);
	assert.match(source, /aria-label=\{`Remove \$\{address\}`\}/);
	assert.match(source, /onClick=\{\(\) => editChip\(index\)\}/);
	assert.match(source, /onClick=\{\(\) => removeChip\(index\)\}/);
	// Invalid text stays visible as a chip that says what is wrong with it.
	assert.match(source, /is not a valid email address/);
	assert.match(source, /aria-invalid=\{invalidChips\.length > 0 \|\| undefined\}/);
});

test("Enter, separators, paste and leaving the field all commit the address", () => {
	// Cmd/Ctrl+Enter is handled before suggestions: it commits exactly what
	// was typed, synchronously, and lets the send shortcut run.
	assert.match(
		source,
		/if \(event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)\) \{\s*if \(draft\.trim\(\)\) addRecipients\(draft, true\);\s*return;\s*\}\s*const action = applyRecipientComboboxKeyEvent\(/,
	);
	assert.match(source, /if \(flush\) flushSync\(apply\)/);
	// Plain Enter never submits the form.
	assert.match(source, /case "Enter":\s*\/\/[^\n]*\n\s*event\.preventDefault\(\);/);
	assert.match(source, /splitFinishedRecipients\(text\)/);
	assert.match(source, /onPaste=\{handlePaste\}/);
	// Pasting over a selection replaces it.
	assert.match(
		source,
		/addRecipients\(`\$\{draft\.slice\(0, start\)\}\$\{pasted\}\$\{draft\.slice\(end\)\}`\)/,
	);
	assert.match(source, /onBlur=\{\(\) => \{\s*if \(draft\.trim\(\)\) addRecipients\(draft\);/);
	// Backspace marks the last chip before removing it.
	assert.match(source, /setSelectedChip\(chips\.length - 1\)/);
});
