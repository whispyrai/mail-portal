import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("same-tick admission and every upload completion use the synchronous attachment ref", () => {
	const hook = read("../hooks/useAttachments.ts");
	assert.match(hook, /planComposeAttachmentAdmission/);
	assert.match(
		hook,
		/attachmentsRef\.current = nextAttachments[\s\S]*?setAttachments\(nextAttachments\)[\s\S]*?uploadOne/,
	);
	assert.match(hook, /attempts\.begin\(localId\)/);
	assert.match(hook, /attempts\.isCurrent\(localId, token\)/);
	assert.match(hook, /removeAttachment[\s\S]*?\.abort\(localId\)/);
	assert.match(hook, /retryAttachment[\s\S]*?\.abort\(localId\)/);
	assert.match(hook, /reset[\s\S]*?abortAll/);
	assert.match(hook, /useEffect\(\(\) => \(\) =>[\s\S]*?abortAll/);
});

test("editor and outer compose consume file transfers without double bubbling while text stays native", () => {
	const editor = read("./RichTextEditor.tsx");
	const compose = read("./ComposeEmail.tsx");
	const attachments = read("./ComposeAttachments.tsx");
	assert.match(editor, /handlePaste:[\s\S]*?consumeEditorFiles/);
	assert.match(editor, /handleDrop:[\s\S]*?consumeEditorFiles/);
	assert.match(editor, /consumeComposeEditorFileTransfer/);
	assert.match(editor, /onFiles/);
	assert.match(compose, /onPaste=\{handleOuterPaste\}/);
	assert.match(compose, /onDrop=\{handleOuterDrop\}/);
	assert.match(compose, /Drop files to attach/);
	assert.match(compose, /RichTextEditor[\s\S]*?onFiles=/);
	assert.match(compose, /fileTransfersDisabled = isSending \|\| isResolvingClose/);
	assert.match(compose, /fileTransfersDisabled \? \(\) => \{\} : acceptTransferredFiles/);
	assert.match(attachments, /type="file"[\s\S]*?disabled=\{disabled\}/);
	assert.match(attachments, /onChange=\{\(e\) => \{[\s\S]*?if \(disabled\)/);
	assert.match(editor, /onChange=\{\(event\) => \{[\s\S]*?if \(fileTransfersDisabledRef\.current\)/);
	assert.doesNotMatch(editor, /data:|blob:/);
});

test("upload service forwards AbortSignal and new files remain ordinary attachments", () => {
	const api = read("../services/api.ts");
	const hook = read("../hooks/useAttachments.ts");
	assert.match(api, /uploadAttachment:[\s\S]*?signal\?: AbortSignal[\s\S]*?signal,/);
	assert.match(hook, /api\.uploadAttachment\(mailboxId, localId, file, signal\)/);
	assert.match(hook, /addFiles[\s\S]*?admitFiles\(files, \(\) => "attachment"\)/);
});

test("recovery exposes interrupted uploads for deliberate Retry without auto-restarting", () => {
	const hook = read("../hooks/useAttachments.ts");
	const attachments = read("./ComposeAttachments.tsx");
	assert.match(hook, /recoverComposeAttachments/);
	assert.match(
		hook,
		/const restore = useCallback[\s\S]*?abortAll\(\)[\s\S]*?commitAttachments\(recoverComposeAttachments\(value\)\)/,
	);
	const restoreBranch = hook.match(
		/const restore = useCallback\(([\s\S]*?)\n\t\}, \[commitAttachments\]\);/,
	)?.[1];
	assert.ok(restoreBranch);
	assert.doesNotMatch(restoreBranch, /uploadOne/);
	assert.match(
		hook,
		/retryAdmission[\s\S]*?attachmentsRef\.current\.filter\([\s\S]*?candidate\.localId !== localId[\s\S]*?void uploadOne\(localId, attachment\.file\)/,
	);
	assert.match(attachments, /hasIssue && a\.file/);
	assert.match(attachments, />\s*Retry\s*</);
	assert.match(attachments, />\s*Remove\s*</);
});
