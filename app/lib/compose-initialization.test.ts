import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialComposeFields } from "./compose-initialization.ts";

const original = {
	id: "message-1",
	folder_id: "inbox",
	message_id: "<message-1@example.com>",
	thread_id: "thread-1",
	sender: "Sender <sender@example.com>",
	recipient: "team@example.com, colleague@example.com",
	cc: "copy@example.com",
	bcc: null,
	subject: "Quarterly <update>",
	body: "<p>Hello <strong>team</strong></p>",
	date: "2026-07-11T09:00:00.000Z",
	read: false,
	starred: false,
	attachments: [],
};

test("draft content remains authoritative over signatures and mode defaults", () => {
	const fields = buildInitialComposeFields({
		composeOptions: {
			mode: "new",
			draftEmail: {
				...original,
				recipient: "draft@example.com",
				cc: "copy@example.com",
				bcc: "blind@example.com",
				subject: "Existing draft",
				body: "<p>Exact draft body</p>",
			},
		},
		signature: { enabled: true, text: "Should not be inserted" },
	});

	assert.deepEqual(fields, {
		to: "draft@example.com",
		cc: "copy@example.com",
		bcc: "blind@example.com",
		showCcBcc: true,
		subject: "Existing draft",
		body: "<p>Exact draft body</p>",
	});
});

test("reply-all excludes the mailbox and inserts one marked signature", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply-all", originalEmail: original },
		mailboxEmail: "team@example.com",
		signature: { enabled: true, text: "Team\nSupport" },
	});

	assert.equal(fields.to, "Sender <sender@example.com>, colleague@example.com");
	assert.equal(fields.cc, "copy@example.com");
	assert.equal(fields.subject, "Re: Quarterly <update>");
	assert.match(fields.body, /data-mail-signature="v1"/);
	assert.equal(fields.body.match(/data-mail-signature="v1"/g)?.length, 1);
});

test("forward escapes original metadata and keeps the signature before the forwarded tail", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "forward", originalEmail: original },
		signature: { enabled: true, text: "Regards" },
	});

	assert.equal(fields.subject, "Fwd: Quarterly <update>");
	assert.ok(fields.body.indexOf('data-mail-signature="v1"') < fields.body.indexOf('data-mail-forwarded-message="v1"'));
	assert.match(fields.body, /Quarterly &lt;update&gt;/);
	assert.doesNotMatch(fields.body, /<strong>team<\/strong>/);
});
