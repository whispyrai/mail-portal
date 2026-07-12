import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("Ask this conversation is bounded, abortable, and pinned to the selected mail", () => {
	const question = read("./ConversationQuestion.tsx");
	const query = read("../queries/conversation-answer.ts");
	const service = read("../services/conversation-answer.ts");

	assert.match(question, /const QUESTION_LIMIT = 500/);
	assert.match(question, /createConversationQuestionRequestController/);
	assert.match(question, /requestsRef\.current\.cancel\(\)/);
	assert.match(question, /selectionRef\.current = \{ mailboxId, emailId \}/);
	assert.match(question, /isCurrentConversationAnswerRequest/);
	assert.match(question, /requestToken/);
	assert.match(query, /retry: false/);
	assert.match(service, /encodeURIComponent\(mailboxId\)/);
	assert.match(service, /encodeURIComponent\(emailId\)/);
	assert.match(service, /signal/);
});

test("Ask this conversation exposes every terminal state and exact cited sources", () => {
	const question = read("./ConversationQuestion.tsx");
	const card = read("./ConversationIntelligenceCard.tsx");

	assert.match(question, /Ask this conversation/);
	assert.match(question, /Looking through this conversation/);
	assert.match(question, /budget controls/);
	assert.match(question, /conversation changed/);
	assert.match(question, /does not contain enough evidence/);
	assert.match(question, /Question:/);
	assert.match(question, /Relevant quoted evidence/);
	assert.match(question, /<blockquote/);
	assert.doesNotMatch(question, /dangerouslySetInnerHTML/);
	assert.match(question, /role="alert"/);
	assert.match(question, /role="status"/);
	assert.match(question, /data-intelligence-message-id/);
	assert.match(question, /onFocusMessage\(messageId\)/);
	assert.match(question, /scrollIntoView/);
	assert.match(question, /target\?\.focus/);
	assert.match(
		card,
		/<ConversationQuestion[\s\S]*?key=\{`\$\{mailboxId\}:\$\{emailId\}`\}[\s\S]*?mailboxId=\{mailboxId\}[\s\S]*?emailId=\{emailId\}/,
	);
});

test("conversation questions remain read-only and never invoke mailbox actions", () => {
	const question = read("./ConversationQuestion.tsx");
	const service = read("../services/conversation-answer.ts");
	for (const source of [question, service]) {
		assert.doesNotMatch(
			source,
			/useSend|useMove|useDelete|useSchedule|useUpdateEmail|startCompose|mark.*read/i,
		);
	}
	assert.doesNotMatch(question, /Automatically send|Apply action/);
});
