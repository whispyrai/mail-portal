import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { replaceAiAuthoredContent } from "../lib/compose-signature.ts";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("new mail keeps its iterative assistant while stored replies use the same lazy surface", () => {
	const compose = read("./ComposeEmail.tsx");
	const assistant = read("./ComposeAiAssistant.tsx");
	const queries = read("../queries/emails.ts");
	const api = read("../services/api.ts");

	assert.match(
		compose,
		/composeOptions\.mode === "new" && !composeOptions\.draftEmail/,
	);
	assert.match(
		compose,
		/!composeOptions\.draftEmail[\s\S]*?composeOptions\.originalEmail\?\.id[\s\S]*?composeOptions\.mode === "reply"[\s\S]*?composeOptions\.mode === "reply-all"/,
	);
	assert.match(compose, /isAiComposeEligible = isNewCompose \|\| isReplyCompose/);
	assert.match(compose, /lazy\(\(\) => import\("\.\/ComposeAiAssistant"\)\)/);
	assert.match(compose, /composeMode=\{composeOptions\.mode\}/);
	assert.match(compose, /sourceEmailId=\{composeOptions\.originalEmail\?\.id\}/);
	assert.match(compose, /applyAiBody=\{applyAiBody\}/);
	assert.doesNotMatch(compose, /useAiDraftCompose/);
	assert.match(assistant, /extractAiAuthoredContent\(body\)/);
	assert.match(assistant, /validateAiComposeDraftRequest\(request\)/);
	assert.doesNotMatch(assistant, /authoredBody\.slice/);
	assert.match(assistant, /preserveSignature: hasComposeSignature\(body\)/);
	assert.match(assistant, /\/<img\\b\/i\.test\(authoredBody\)/);
	assert.match(
		assistant,
		/editableSnapshotRef\.current\.subject !== requestedSnapshot\.subject/,
	);
	assert.match(assistant, /Nothing was replaced/);
	assert.match(assistant, /hasDraftContext \? "Refine" : "Generate"/);
	assert.match(assistant, /\["Polish",/);
	assert.match(assistant, /\["Shorter",/);
	assert.match(assistant, /\["More formal",/);
	assert.match(assistant, /\["Friendlier",/);
	assert.match(
		assistant,
		/if \(!originMailboxId \|\| !nextPrompt\) return/,
	);
	assert.match(assistant, /if \(requestPendingRef\.current\) return/);
	assert.match(assistant, /requestPendingRef\.current = true/);
	assert.match(assistant, /finally \{\s*requestPendingRef\.current = false/);
	assert.match(
		assistant,
		/else if \(requestPendingRef\.current \|\| aiCompose\.isPending\)/,
	);
	assert.match(assistant, /disabled=\{isPending\}/);
	assert.match(
		assistant,
		/if \(typeof draft\.body === "string"\) applyAiBody\(draft\.body\)/,
	);
	assert.doesNotMatch(assistant, /onClose\(\);\s*\} catch/);

	assert.match(queries, /AiComposeDraftRequest/);
	assert.match(api, /AiComposeDraftRequest/);
	assert.match(api, /post<\{ subject\?: string; body: string \}>/);
});

test("reply refinement is pinned, abortable, and can apply only a replacement body", () => {
	const compose = read("./ComposeEmail.tsx");
	const assistant = read("./ComposeAiAssistant.tsx");
	const form = read("../hooks/useComposeForm.ts");
	const service = read("../services/reply-refinement.ts");
	const query = read("../queries/reply-refinement.ts");
	const controller = read("../lib/reply-refinement-controller.ts");

	assert.match(assistant, /useReplyRefinement\(\)/);
	assert.match(assistant, /parseReplyRefinementRequest\(request\)/);
	assert.match(
		assistant,
		/const request = \{\s*mode: replyMode,\s*prompt: nextPrompt,\s*currentBody: hasAuthoredBody \? authoredBody : undefined,\s*preserveSignature: hasComposeSignature\(body\) \|\| undefined,\s*\}/,
	);
	assert.match(assistant, /signal: activeRequest\.controller\.signal/);
	assert.match(assistant, /requestToken: activeRequest\.requestToken/);
	assert.match(
		assistant,
		/replyRequestsRef\.current\.isCurrent\(activeRequest, currentSnapshot\)/,
	);
	assert.match(assistant, /replyRequestsRef\.current\.cancel\(\)/);
	assert.match(assistant, /applyAiBody\(response\.result\.body\)/);
	assert.match(
		assistant,
		/applyAiBody\(response\.result\.body\);\s*setReplyNotice\("review_required"\)/,
	);
	assert.match(
		assistant,
		/AI can make factual mistakes\. You must review every fact and[\s\S]*?commitment before sending\./,
	);
	assert.match(service, /value\.result\.requiresHumanReview === true/);
	assert.match(service, /hasAiAuthoredContent\(value\.result\.body\)/);
	const replyImplementation = assistant.slice(
		assistant.indexOf("const generateReply"),
		assistant.indexOf("const generate ="),
	);
	assert.doesNotMatch(replyImplementation, /setSubject|setTo|setCc|setBcc|attachments|scheduledFor/);

	assert.match(
		form,
		/const applyAiBody = useCallback\([\s\S]*?replaceAiAuthoredContent\(snapshotRef\.current\.body, nextAiBody\)[\s\S]*?\}, \[\]\)/,
	);
	const assistantInvocation = compose.slice(
		compose.indexOf("<ComposeAiAssistant"),
		compose.indexOf("</Suspense>"),
	);
	assert.doesNotMatch(
		assistantInvocation,
		/setTo=|setCc=|setBcc=|attachments=|scheduledFor=|setScheduledFor=/,
	);
	assert.match(service, /emails\/\$\{encodeURIComponent\(sourceEmailId\)\}\/reply-refinement/);
	assert.match(query, /retry: false/);
	for (const field of ["mailboxId", "sourceEmailId", "mode", "subject", "body"]) {
		assert.match(controller, new RegExp(`request\\.${field} === snapshot\\.${field}`));
	}
	assert.match(controller, /if \(active\) return null/);
	assert.match(controller, /active\?\.controller\.abort\(\)/);
});

test("forward and draft editing remain excluded from AI reply refinement", () => {
	const compose = read("./ComposeEmail.tsx");

	assert.match(compose, /!composeOptions\.draftEmail/);
	assert.doesNotMatch(
		compose.slice(
			compose.indexOf("const isReplyCompose"),
			compose.indexOf("const isAiComposeEligible"),
		),
		/"forward"/,
	);
});

test("reply body replacement preserves signature and every non-body compose field", () => {
	const signature = '<div data-mail-signature="v1">Hesham<br>Team</div>';
	const original = {
		to: "client@example.com",
		cc: "team@example.com",
		bcc: "audit@example.com",
		subject: "Re: Launch",
		body: `<p>Old reply.</p>${signature}`,
		attachments: [{ id: "attachment-1", filename: "plan.pdf" }],
		scheduledFor: "2026-07-13T08:00:00.000Z",
		sourceEmailId: "message-1",
		mode: "reply-all" as const,
	};
	const updated = {
		...original,
		body: replaceAiAuthoredContent(
			original.body,
			'<p>Clearer reply.</p><div data-mail-signature="v1">Untrusted</div>',
		),
	};

	assert.equal(updated.body, `<p>Clearer reply.</p>${signature}`);
	assert.deepEqual(
		{ ...updated, body: original.body },
		original,
	);
});
