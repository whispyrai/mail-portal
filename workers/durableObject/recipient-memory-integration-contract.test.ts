import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	callIsInsideTransaction,
	parseTypescriptSource,
} from "../testing/typescript-source.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const inboundStore = readFileSync(
	new URL("../lib/store-email.ts", import.meta.url),
	"utf8",
);
const inboundRoute = readFileSync(new URL("../inbound-email.ts", import.meta.url), "utf8");
const inboundQueue = readFileSync(new URL("../inbound-queue.ts", import.meta.url), "utf8");
const liveInboundProjection = readFileSync(
	new URL("../lib/live-inbound-projection.ts", import.meta.url),
	"utf8",
);
const importStore = readFileSync(
	new URL("../lib/import/import-email.ts", import.meta.url),
	"utf8",
);

test("recipient learning is wired inside authoritative inbound and accepted-outbound transactions", () => {
	const parsed = parseTypescriptSource(source, "index.ts");
	assert.equal(
		callIsInsideTransaction(parsed, "createEmail", "recordRecipientInteractions"),
		true,
	);
	assert.equal(
		callIsInsideTransaction(
			parsed,
			"moveAcceptedOutboundToSent",
			"recordRecipientInteractions",
		),
		true,
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
	assert.match(liveInboundProjection, /recipientMemoryOrigin: [A-Za-z.]+LIVE_INBOUND/);
	assert.match(inboundRoute, /liveInboundProjectionOptions\(/);
	assert.match(inboundQueue, /liveInboundProjectionOptions\(/);
	assert.match(importStore, /recipientMemoryOrigin: [A-Za-z.]+ADMIN_IMPORT/);
	assert.match(inboundStore, /recipient_memory_origin: options\.recipientMemoryOrigin/);
});
