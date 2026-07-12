import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const list = read("../routes/email-list.tsx");
const toolbar = read("./BatchTriageToolbar.tsx");
const review = read("./InboxTriageReview.tsx");

test("Inbox suggestions stay behind a user-triggered lazy boundary", () => {
	assert.match(list, /lazy\(\(\) => import\("~\/components\/InboxTriageReview"\)\)/);
	assert.doesNotMatch(list, /import InboxTriageReview from/);
	assert.match(list, /triageReviewLoaded && mailboxId/);
	assert.match(list, /<LazyLoadBoundary[\s\S]*?<Suspense[\s\S]*?<InboxTriageReview/);
	assert.match(list, /function InboxTriageReviewLoadError[\s\S]*?<Dialog\.Root open/);
	assert.match(
		list,
		/onClose=\{\(\) => \{[\s\S]*?setTriageReviewOpen\(false\);[\s\S]*?setTriageReviewLoaded\(false\);/,
	);
	assert.equal(
		list.match(/setTriageReviewLoaded\(false\);/g)?.length,
		3,
		"folder changes plus both lazy fallback close paths must unmount review",
	);
	assert.match(list, /folder === Folders\.INBOX/);
	assert.match(list, />\s*Review suggestions\s*</);
	assert.match(toolbar, /selectedCount === 0 && idleControl/);
});

test("review is cited, explicit, homogeneous, and separate from manual selection", () => {
	assert.match(review, /Nothing changes until you apply a reviewed action\./);
	assert.match(review, /action="archive"/);
	assert.match(review, /action="mark_read"/);
	assert.match(review, /Apply \{selectedArchiveCount\} archive suggestion/);
	assert.match(review, /Mark \{selectedReadCount\} conversation/);
	assert.match(review, /createInboxTriageReviewSelection/);
	assert.match(review, /onDismiss=\{dismiss\}/);
	assert.match(review, /Source \{index \+ 1\}/);
	assert.doesNotMatch(review, /"trash"|"mark_unread"|confidence/i);
});

test("evidence opens without the ordinary row-click read mutation", () => {
	assert.match(
		list,
		/onOpenEvidence=\{\(messageId\) => \{[\s\S]*?selectEmail\(messageId\);[\s\S]*?\}\}/,
	);
	const evidenceHandler = list.match(
		/onOpenEvidence=\{\(messageId\) => \{([\s\S]*?)\}\}/,
	)?.[1];
	assert.ok(evidenceHandler);
	assert.doesNotMatch(evidenceHandler, /handleRowClick|markThreadRead|updateEmail/);
});

test("dialog exposes stale, partial failure, budget, shared, and responsive states", () => {
	assert.match(review, /Inbox changed while you were reviewing\. No suggestion was applied\./);
	assert.match(review, /Inbox updated after your reviewed action\./);
	assert.match(review, /Refresh suggestions before applying another action\./);
	assert.match(review, /!needsRefreshAfterApply/);
	assert.match(review, /This conversation was not updated\. Refresh suggestions or retry this group\./);
	assert.match(review, /paused by the team’s budget controls/);
	assert.match(review, /affect this mailbox for everyone with access/);
	assert.match(review, /useMailboxes\(\)/);
	assert.match(review, /mailbox\.type === "SHARED"/);
	assert.doesNotMatch(review, /hello@|contact@|includes\([^)]*shared/i);
	assert.match(review, /max-h-\[calc\(100dvh-1rem\)\]/);
	assert.match(review, /w-\[calc\(100vw-1rem\)\]/);
	assert.match(review, /max-w-\[700px\]/);
	assert.match(review, /aria-live="polite"/);
	assert.match(review, /min-h-11/);
	assert.match(review, /if \(!next && applyingAction\) return/);
});
