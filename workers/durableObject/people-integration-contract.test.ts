import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const durableObject = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const inboundStore = readFileSync(new URL("../lib/store-email.ts", import.meta.url), "utf8");
const importStore = readFileSync(new URL("../lib/import/import-email.ts", import.meta.url), "utf8");

test("People projection runs inside authoritative inbound and accepted-outbound transactions", () => {
	assert.match(
		durableObject,
		/async createEmail[\s\S]*?transactionSync\(\(\) => \{[\s\S]*?createMailPeopleProjector\([\s\S]*?\.projectMessage\(email\.id\)[\s\S]*?\n\t\t\}\);/,
	);
	assert.match(
		durableObject,
		/#moveAcceptedOutboundToSent[\s\S]*?transactionSync\(\(\) => \{[\s\S]*?folder_id: Folders\.SENT[\s\S]*?createMailPeopleProjector\([\s\S]*?\.projectMessage\(emailId\)[\s\S]*?\n\t\t\}\);/,
	);
});

test("authoritative parsing stores a sanitized sender name and imports identify their mailbox", () => {
	assert.match(inboundStore, /sender_name: normalizeObservedSenderName\(parsed\.from\?\.name\)/);
	assert.match(importStore, /recipientMemoryOrigin: RecipientMemoryOrigins\.ADMIN_IMPORT[\s\S]*?mailboxAddress: mailboxId/);
});

test("People Durable Object RPC seams revalidate canonical mailbox, identity, and query contracts", () => {
	assert.match(
		durableObject,
		/async listMailPeople[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateNormalizedMailPeopleListQuery\(query\)/,
	);
	assert.match(
		durableObject,
		/async getMailPerson[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateMailPersonId\(personId\)/,
	);
	assert.match(
		durableObject,
		/async listMailPersonTimeline[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateMailPersonId\(personId\)[\s\S]*?validateNormalizedMailPersonTimelineQuery\(query, id\)/,
	);
});
