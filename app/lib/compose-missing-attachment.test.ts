import assert from "node:assert/strict";
import test from "node:test";
import {
	composeMissingAttachmentFingerprint,
	shouldWarnMissingAttachment,
} from "./compose-missing-attachment.ts";

const noAttachments: Array<{
	status: string;
	disposition?: "attachment" | "inline";
}> = [];

test("missing-attachment intent is strong, bounded, and excludes non-authored content", () => {
	for (const text of [
		"Please find attached the proposal.",
		"I've attached the signed agreement.",
		"See the attachment for the breakdown.",
		"Attached is the invoice.",
	]) {
		assert.equal(
			shouldWarnMissingAttachment({ subject: "", bodyHtml: `<p>${text}</p>`, attachments: noAttachments }),
			true,
			text,
		);
	}
	for (const text of [
		"I updated the file yesterday.",
		"Please review the document.",
		"We should attach importance to this.",
		"The attachment policy changed.",
	]) {
		assert.equal(
			shouldWarnMissingAttachment({ subject: "", bodyHtml: `<p>${text}</p>`, attachments: noAttachments }),
			false,
			text,
		);
	}

	const ignored = [
		'<div data-mail-signature="v1">Please find attached</div>',
		'<div data-mail-forwarded-message="v1">I\'ve attached the report</div>',
		"<blockquote>See the attachment</blockquote>",
	];
	for (const bodyHtml of ignored) {
		assert.equal(
			shouldWarnMissingAttachment({ subject: "", bodyHtml, attachments: noAttachments }),
			false,
		);
	}
	assert.equal(
		shouldWarnMissingAttachment({
			subject: `${"x".repeat(500)}Please find attached`,
			bodyHtml: `<p>${"x".repeat(20_000)}Please find attached</p>`,
			attachments: noAttachments,
		}),
		false,
	);
});

test("only a ready ordinary attachment suppresses the warning", () => {
	const input = { subject: "Please find attached", bodyHtml: "", attachments: noAttachments };
	assert.equal(shouldWarnMissingAttachment(input), true);
	assert.equal(shouldWarnMissingAttachment({
		...input,
		attachments: [{ status: "ready", disposition: "inline" }],
	}), true);
	assert.equal(shouldWarnMissingAttachment({
		...input,
		attachments: [{ status: "uploading", disposition: "attachment" }],
	}), true);
	assert.equal(shouldWarnMissingAttachment({
		...input,
		attachments: [{ status: "ready", disposition: "attachment" }],
	}), false);
});

test("common active attachment language warns without matching policy or idiom discussions", () => {
	for (const text of [
		"I am attaching the report.",
		"We are attaching the signed agreement.",
		"I have included the invoice.",
		"We've included the revised deck.",
	]) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml: `<p>${text}</p>`,
				attachments: noAttachments,
			}),
			true,
			text,
		);
	}
	for (const text of [
		"See the attachment policy for details.",
		"Please review the attachment settings.",
		"I have attached importance to this issue.",
		"We attached ourselves to the project.",
	]) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml: `<p>${text}</p>`,
				attachments: noAttachments,
			}),
			false,
			text,
		);
	}
});

test("quote exclusion is structural even when its closing tag crosses the visible-text boundary", () => {
	const bodyHtml = `<blockquote><p>Please find attached</p>${"quoted ".repeat(3_000)}</blockquote><p>No attachment claim here.</p>`;
	assert.equal(
		shouldWarnMissingAttachment({
			subject: "",
			bodyHtml,
			attachments: noAttachments,
		}),
		false,
	);
});

test("signature and forwarded content stay excluded across raw HTML boundaries", () => {
	const bodies = [
		`<div data-mail-signature="v1"><p>I am attaching the report.</p>${"signature ".repeat(2_500)}</div><p>No claim.</p>`,
		`<p>No claim.</p><div data-mail-forwarded-message="v1">${"forwarded ".repeat(2_500)}<p>I have included the invoice.</p></div>`,
	];
	for (const bodyHtml of bodies) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml,
				attachments: noAttachments,
			}),
			false,
		);
	}
});

test("marker-like text inside another attribute value is still authored content", () => {
	for (const bodyHtml of [
		`<div title='data-mail-signature="v1"'><p>Please find attached</p></div>`,
		`<div aria-label='data-mail-forwarded-message="v1"'><p>Please find attached</p></div>`,
		`<div data-note='data-mail-quoted="v1"'><p>Please find attached</p></div>`,
	]) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml,
				attachments: noAttachments,
			}),
			true,
		);
	}

	for (const bodyHtml of [
		`<div class="copy" DATA-MAIL-SIGNATURE = 'V1'>Please find attached</div>`,
		`<div data-kind="quote" data-mail-forwarded-message='v1'>Please find attached</div>`,
		`<div aria-label="quote" data-mail-quoted = "v1">Please find attached</div>`,
	]) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml,
				attachments: noAttachments,
			}),
			false,
		);
	}
});

test("bounded entity normalization recognizes common encoded apostrophes", () => {
	for (const entity of [
		"&#39;",
		"&#x27;",
		"&#8217;",
		"&#x2019;",
		"&apos;",
		"&rsquo;",
	]) {
		assert.equal(
			shouldWarnMissingAttachment({
				subject: "",
				bodyHtml: `<p>I${entity}ve attached the report.</p>`,
				attachments: noAttachments,
			}),
			true,
			entity,
		);
	}
});

test("the body limit counts visible authored text rather than formatting markup", () => {
	const formattingOnly = "<span></span>".repeat(2_000);
	assert.ok(formattingOnly.length > 20_000);
	assert.equal(
		shouldWarnMissingAttachment({
			subject: "",
			bodyHtml: `${formattingOnly}<p>I am attaching the report.</p>`,
			attachments: noAttachments,
		}),
		true,
	);
});

test("pending confirmation fingerprint changes with every exact send input", () => {
	const input = {
		to: "person@example.com",
		cc: "",
		bcc: "",
		subject: "Please find attached",
		bodyHtml: "<p>Review this.</p>",
		scheduledFor: null,
		attachments: [{
			filename: "inline.png",
			status: "ready",
			disposition: "inline" as const,
			uploadId: "upload-1",
		}],
	};
	const fingerprint = composeMissingAttachmentFingerprint(input);
	assert.equal(composeMissingAttachmentFingerprint({ ...input }), fingerprint);
	assert.notEqual(
		composeMissingAttachmentFingerprint({ ...input, subject: `${input.subject}!` }),
		fingerprint,
	);
	assert.notEqual(
		composeMissingAttachmentFingerprint({ ...input, scheduledFor: "2026-07-13T12:00:00.000Z" }),
		fingerprint,
	);
	assert.notEqual(
		composeMissingAttachmentFingerprint({
			...input,
			attachments: [{ ...input.attachments[0], status: "error" }],
		}),
		fingerprint,
	);
});
