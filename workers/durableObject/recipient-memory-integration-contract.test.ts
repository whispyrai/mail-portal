import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const inboundStore = readFileSync(
	new URL("../lib/store-email.ts", import.meta.url),
	"utf8",
);
const inboundRoute = readFileSync(new URL("../inbound-email.ts", import.meta.url), "utf8");
const importStore = readFileSync(
	new URL("../lib/import/import-email.ts", import.meta.url),
	"utf8",
);

test("recipient learning is wired inside authoritative inbound and accepted-outbound transactions", () => {
	assert.match(
		source,
		/async createEmail[\s\S]*?transactionSync\(\(\) => \{[\s\S]*?recordRecipientInteractions[\s\S]*?\n\t\t\}\);/,
	);
	assert.match(
		source,
		/#moveAcceptedOutboundToSent[\s\S]*?transactionSync\(\(\) => \{[\s\S]*?folder_id: Folders\.SENT[\s\S]*?recordRecipientInteractions/,
	);
	assert.match(inboundStore, /options\.mailboxAddress/);
	assert.match(
		source,
		/recipient_memory_origin:\s*[A-Za-z.]+ACCEPTED_OUTBOUND/,
	);
});

test("accepted outbound memory uses every immutable recipient class", () => {
	assert.match(
		source,
		/addresses: \[\.\.\.snapshot\.to, \.\.\.snapshot\.cc, \.\.\.snapshot\.bcc\]/,
	);
});

test("live inbound and admin imports persist explicit recipient-memory provenance", () => {
	assert.match(inboundRoute, /recipientMemoryOrigin: [A-Za-z.]+LIVE_INBOUND/);
	assert.match(importStore, /recipientMemoryOrigin: [A-Za-z.]+ADMIN_IMPORT/);
	assert.match(inboundStore, /recipient_memory_origin: options\.recipientMemoryOrigin/);
});
