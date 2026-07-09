// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Notification content (decision B: sender · subject · body snippet) + the
// deep-link clickUrl. Run:
//   node --experimental-strip-types --test workers/lib/push/payload.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPushPayload, htmlToSnippet } from "./payload.ts";

test("htmlToSnippet strips tags, decodes entities, collapses whitespace", () => {
	assert.equal(
		htmlToSnippet("<p>Hello&nbsp;<b>world</b></p>\n\n  again"),
		"Hello world again",
	);
	assert.equal(htmlToSnippet("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
});

test("htmlToSnippet truncates with an ellipsis at the limit", () => {
	const out = htmlToSnippet("abcdefghij", 5);
	assert.equal(out, "abcd…"); // 4 chars + ellipsis
	assert.equal(htmlToSnippet("abcd", 5), "abcd"); // under limit, untouched
});

test("htmlToSnippet handles empty / missing body", () => {
	assert.equal(htmlToSnippet(""), "");
	assert.equal(htmlToSnippet(null), "");
	assert.equal(htmlToSnippet(undefined), "");
});

const base = {
	emailId: "msg-123",
	mailboxId: "hesham@wiserchat.ai",
	fromAddress: "john.doe@acme.com",
	subject: "Contract signed",
	body: "<p>Great news — the contract is signed and attached.</p>",
	icon: "/icon-192.png",
	badge: "/favicon-32.png",
};

test("payload title = sender display name when present", () => {
	const p = buildPushPayload({ ...base, fromName: "John Doe" });
	assert.equal(p.title, "John Doe");
});

test("payload title falls back to the address local-part when no name", () => {
	const p = buildPushPayload({ ...base, fromName: null });
	assert.equal(p.title, "john.doe");
});

test("payload body = subject + snippet (decision B)", () => {
	const p = buildPushPayload({ ...base, fromName: "John Doe" });
	assert.equal(p.body, "Contract signed — Great news — the contract is signed and attached.");
});

test("payload body is just the subject when the email has no body text", () => {
	const p = buildPushPayload({ ...base, body: "" });
	assert.equal(p.body, "Contract signed");
});

test("missing subject → placeholder", () => {
	const p = buildPushPayload({ ...base, subject: "", body: "" });
	assert.equal(p.body, "(no subject)");
});

test("clickUrl deep-links to the message in the inbox (URL-encoded)", () => {
	const p = buildPushPayload(base);
	assert.equal(
		p.clickUrl,
		"/mailbox/hesham%40wiserchat.ai/emails/inbox?email=msg-123",
	);
});

test("icon/badge pass through and data carries the routing ids", () => {
	const p = buildPushPayload(base);
	assert.equal(p.icon, "/icon-192.png");
	assert.equal(p.badge, "/favicon-32.png");
	assert.deepEqual(p.data, { emailId: "msg-123", mailboxId: "hesham@wiserchat.ai" });
});
