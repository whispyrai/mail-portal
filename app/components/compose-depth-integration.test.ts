import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(new URL("./ComposeEmail.tsx", import.meta.url), "utf8");
const form = readFileSync(new URL("../hooks/useComposeForm.ts", import.meta.url), "utf8");

test("compose shortcuts submit the form or call the existing save action without bypassing dialogs", () => {
	assert.match(compose, /planComposeShortcut/);
	assert.match(compose, /composeFormRef\.current\?\.requestSubmit\(\)/);
	assert.match(compose, /data-compose-shortcut-surface="primary"/);
	assert.match(compose, /data-compose-shortcut-surface="ai-panel"/);
	assert.match(compose, /event\.defaultPrevented/);
	assert.match(compose, /composeFormRef\.current\?\.contains\(target\)/);
	assert.match(compose, /closest\('\[data-compose-shortcut-surface="ai-panel"\]'/);
	assert.match(compose, /action === "save"[\s\S]*?handleSaveDraft/);
	assert.match(
		compose,
		/hasBlockingState:[\s\S]*?closePrompt[\s\S]*?showCustomSchedule[\s\S]*?isMissingAttachmentWarningOpen/,
	);
	assert.match(compose, /origin: "ai-prompt"[\s\S]*?"ai-generate"/);
	assert.match(compose, /aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
	assert.match(compose, /aria-keyshortcuts="Meta\+S Control\+S"/);
	assert.match(compose, /title="Send \(⌘\/Ctrl\+Enter\)"/);
	assert.match(compose, /title="Save draft \(⌘\/Ctrl\+S\)"/);
});

test("missing attachment confirmation revalidates one fingerprint through the same perform-send path", () => {
	assert.match(form, /shouldWarnMissingAttachment/);
	assert.match(form, /composeMissingAttachmentFingerprint/);
	assert.match(
		form,
		/splitEmailList\(latestSnapshot\.to\)[\s\S]*?evaluateComposeAttachments[\s\S]*?shouldWarnMissingAttachment/,
	);
	assert.match(form, /pendingMissingAttachment/);
	assert.match(
		form,
		/confirmMissingAttachment[\s\S]*?requestSend\(pending\.scheduledFor, pending\.fingerprint\)/,
	);
	assert.match(
		form,
		/const performSend[\s\S]*?const requestSend[\s\S]*?await performSend/,
	);
	assert.equal((form.match(/const enqueueConfirmedDraft/g) ?? []).length, 1);
	assert.match(compose, />\s*Send anyway\s*</);
	assert.match(compose, />\s*Back\s*</);
	assert.match(compose, /Send without an attachment\?/);
});
