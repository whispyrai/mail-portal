import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("draft save and send share the fail-closed attachment policy instead of filtering refs", () => {
	const form = read("../hooks/useComposeForm.ts");
	const delivery = read("../lib/compose-delivery.ts");

	assert.match(form, /evaluateComposeAttachments\(attachments, body\)/);
	assert.match(
		form,
		/const savedAttachmentPolicy = evaluateComposeAttachments[\s\S]*?if \(!savedAttachmentPolicy\.ok\)[\s\S]*?attachments: savedAttachmentPolicy\.refs/,
	);
	assert.match(
		delivery,
		/const attachmentPolicy = evaluateComposeAttachments[\s\S]*?if \(!attachmentPolicy\.ok\)[\s\S]*?message: attachmentPolicy\.error[\s\S]*?attachmentRefs: attachmentPolicy\.refs/,
	);
	assert.match(form, /const plan = planComposeSend/);
	assert.doesNotMatch(form, /attachmentsToRefs/);
});

test("reopened drafts retain inline existing references and upload failures can be retried", () => {
	const hook = read("../hooks/useAttachments.ts");

	assert.doesNotMatch(hook, /getNonInlineAttachments/);
	assert.match(hook, /disposition:\s*a\.disposition === "inline" \? "inline" : "attachment"/);
	assert.match(hook, /contentId:\s*a\.content_id/);
	assert.match(hook, /existing:\s*\{ emailId, attachmentId: a\.id \}/);
	assert.match(hook, /const retryAttachment = useCallback/);
	assert.match(hook, /void uploadOne\(localId, attachment\.file\)/);
});

test("the compose UI blocks both actions and gives failed attachments clear Retry and Remove controls", () => {
	const attachments = read("./ComposeAttachments.tsx");
	const compose = read("./ComposeEmail.tsx");

	assert.match(attachments, /onRetry/);
	assert.match(attachments, />\s*Retry\s*</);
	assert.match(attachments, />\s*Remove\s*</);
	assert.doesNotMatch(attachments, /attachment\.disposition !== "inline"/);
	assert.match(attachments, /bodyReferencesInlineAttachment/);
	assert.match(attachments, /Embedded in message/);
	assert.match(attachments, /Unused inline part/);
	assert.match(attachments, /window\.confirm/);
	assert.match(compose, /hasAttachmentIssue/);
	assert.match(compose, /bodyHtml=\{body\}/);
	assert.match(compose, /onRetry=\{retryAttachment\}/);
	assert.ok((compose.match(/hasAttachmentIssue/g) ?? []).length >= 4);
});

test("message-panel Send Draft uses the complete fail-closed stored attachment policy", () => {
	const panel = read("./EmailPanel.tsx");

	assert.match(
		panel,
		/evaluateStoredDraftAttachments\(\s*draft\.id,\s*draft\.attachments,\s*draft\.body \?\? "",?\s*\)/,
	);
	assert.match(
		panel,
		/if \(!attachmentPolicy\.ok\) throw new Error\(attachmentPolicy\.error\);[\s\S]*?attachments: attachmentPolicy\.refs/,
	);
	assert.match(panel, /catch \(err\)[\s\S]*?variant: "error"/);
	assert.doesNotMatch(
		panel,
		/getNonInlineAttachments\(target\.attachments\)/,
	);
});
