import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const panel = read("./EmailPanel.tsx");
const toolbar = read("./email-panel/EmailPanelToolbar.tsx");
const threadMessage = read("./email-panel/ThreadMessage.tsx");
const compose = read("./ComposeEmail.tsx");
const list = read("../routes/email-list.tsx");

test("Reply, Reply all and Forward are labelled where people look for them", () => {
	for (const label of ["Reply", "Reply all", "Forward"]) {
		assert.match(toolbar, new RegExp(`<span className="max-sm:sr-only">${label}</span>`));
	}
	assert.match(toolbar, /ArrowBendDoubleUpLeftIcon/);
	assert.doesNotMatch(toolbar, /ChatCircleIcon/);
	// The end of the conversation offers the same three, as large buttons.
	assert.match(
		panel,
		/showsReplyActions && conversationLoaded && !isInlineComposing && \([\s\S]*?Reply\s*<\/Button>[\s\S]*?Reply all\s*<\/Button>[\s\S]*?Forward\s*<\/Button>/,
	);
});

test("Reply all appears only when someone besides the sender would get it", () => {
	assert.match(panel, /onReplyAll=\{latestHasOthers \? \(\) => replyTo\(latest, true\) : undefined\}/);
	assert.match(toolbar, /\{onReplyAll && \(/);
	assert.match(panel, /\{latestHasOthers && \(/);
});

test("replies wait for the conversation, never for a message body", () => {
	assert.match(panel, /const conversationLoaded = !email\.thread_id \|\| threadRepliesFetched;/);
	assert.match(panel, /canReply=\{conversationLoaded\}/);
	assert.match(panel, /showsReplyActions && conversationLoaded && !isInlineComposing/);
	assert.match(toolbar, /disabled=\{!canReply\}/);
	assert.doesNotMatch(toolbar, /replyUnavailableReason/);
});

test("a populated Cc or Bcc field is never hidden", () => {
	assert.match(compose, /const showCc = openedCc \|\| Boolean\(cc\.trim\(\)\);/);
	assert.match(compose, /const showBcc = openedBcc \|\| Boolean\(bcc\.trim\(\)\);/);
});

test("each message can be answered on its own and shows everyone it went to", () => {
	assert.match(threadMessage, /aria-label="Reply to this message"/);
	assert.match(threadMessage, /aria-label="More actions for this message"/);
	assert.match(threadMessage, /<dt>To:<\/dt>/);
	assert.match(threadMessage, /<dt>Cc:<\/dt>/);
	assert.match(threadMessage, /isSelf && email\.bcc/);
});

test("a plain reply offers to bring the rest of the conversation in", () => {
	assert.match(compose, /Reply all instead/);
	assert.match(compose, /won’t get this reply/);
});

test("keyboard replies resolve their target in the open conversation", () => {
	assert.match(
		list,
		/case "reply":\s*case "reply-all":\s*case "forward":[\s\S]*?requestThreadAction\(\{ emailId: target\.id, action: command \}\)/,
	);
	assert.match(panel, /pendingThreadAction\.emailId !== emailId/);
	assert.match(panel, /email\.thread_id && !threadRepliesFetched/);
});

test("Enter in Subject moves to the message instead of sending it", () => {
	assert.match(
		compose,
		/event\.key !== "Enter"[\s\S]*?event\.nativeEvent\.isComposing[\s\S]*?event\.preventDefault\(\);\s*focusBody\(\);/,
	);
});

const composeForm = read("../hooks/useComposeForm.ts");

test("a forward's draft is not linked to the forwarded message", () => {
	assert.match(composeForm, /const answers = composeOptions\.mode !== "forward";/);
	assert.match(composeForm, /in_reply_to: answers\s*\?/);
	assert.match(composeForm, /thread_id: answers\s*\?/);
});

test("sending a reply draft from Drafts keeps it a reply even before its thread loads", () => {
	assert.match(
		panel,
		/const result = draft\.in_reply_to\s*\? await replyMut\s*\.mutateAsync\(\{ mailboxId, emailId: draft\.in_reply_to, email: emailData \}\)/,
	);
	assert.match(panel, /error instanceof ApiError && error\.status === 404\) return sendAsNew\(\)/);
	assert.match(panel, /text: draft\.body \? htmlToPlainText\(draft\.body\) : ""/);
});

test("a forward carries the original's files as removable attachments", () => {
	assert.match(composeForm, /getNonInlineAttachments\(forwardedOriginal\.attachments\)/);
	assert.match(composeForm, /hydrateFromDraft\(forwardedOriginal\.id, seededAttachments\)/);
	// Counted in the starting fingerprint, so opening Forward is not an edit.
	assert.match(composeForm, /attachments: seededAttachments\.map\(/);
});
