import assert from "node:assert/strict";
import test from "node:test";
import { Folders } from "../../shared/folders.ts";
import {
	semanticMailboxNamespace,
	semanticMessageChunks,
	semanticMessageEligible,
	semanticSourceFingerprint,
	semanticVectorId,
	type SemanticMessageSource,
} from "./semantic-search.ts";

function source(overrides: Partial<SemanticMessageSource> = {}): SemanticMessageSource {
	return {
		id: "message-1",
		folderId: Folders.INBOX,
		subject: "Supplier contract",
		sender: "sam@example.com",
		recipient: "hello@example.com",
		cc: "",
		bcc: "",
		date: "2026-07-13T08:00:00.000Z",
		body: "The revised agreement will be signed on Tuesday afternoon.",
		semanticVersion: 7,
		...overrides,
	};
}

test("semantic eligibility includes active history and custom folders only", () => {
	for (const folder of [Folders.INBOX, Folders.SENT, Folders.SNOOZED, Folders.ARCHIVE, "clients"]) {
		assert.equal(semanticMessageEligible(folder), true, folder);
	}
	for (const folder of [Folders.DRAFT, Folders.OUTBOX, Folders.TRASH, Folders.SPAM, "_cancelled_outbound", ""]) {
		assert.equal(semanticMessageEligible(folder), false, folder);
	}
});

test("semantic chunking is bounded, deterministic, and excludes ineligible mail", () => {
	const first = semanticMessageChunks(source({ body: "word ".repeat(2_000) }));
	const second = semanticMessageChunks(source({ body: "word ".repeat(2_000) }));
	assert.deepEqual(first, second);
	assert.ok(first.length > 1 && first.length <= 20);
	assert.ok(first.every((chunk) => chunk.excerpt.length <= 1_200));
	assert.deepEqual(semanticMessageChunks(source({ folderId: Folders.TRASH })), []);
});

test("semantic chunking keeps authored plain text and excludes HTML or quoted history", () => {
	const [chunk] = semanticMessageChunks(source({
		body: `<style>.secret { color: red }</style><p>Authored answer.</p>
			<blockquote><p>Quoted private history.</p></blockquote>`,
	}));
	assert.match(chunk?.excerpt ?? "", /Authored answer/);
	assert.doesNotMatch(chunk?.excerpt ?? "", /style|secret|blockquote|Quoted private history/);
});

test("semantic identities are opaque, scoped, and source-versioned", async () => {
	const token = "0123456789abcdef0123456789abcdef";
	assert.equal(semanticVectorId(token, 1), `sm1_${token}_01`);
	assert.throws(() => semanticVectorId("message-1", 0));
	const wiser = await semanticMailboxNamespace("wiser", "hello@example.com");
	const whispyr = await semanticMailboxNamespace("whispyr", "hello@example.com");
	assert.notEqual(wiser, whispyr);
	assert.ok(wiser.length <= 64);
	const original = await semanticSourceFingerprint(source());
	const moved = await semanticSourceFingerprint(source({ folderId: Folders.ARCHIVE }));
	const changed = await semanticSourceFingerprint(source({ body: "Different" }));
	assert.equal(original, moved);
	assert.notEqual(original, changed);
});
