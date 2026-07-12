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
		/required=\{required\}/,
		/min-h-11/,
	]) assert.match(source, contract);
	assert.doesNotMatch(source, /autoComplete="off"/);
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
	assert.doesNotMatch(source, /displayName|fullName|contactName/);
});
