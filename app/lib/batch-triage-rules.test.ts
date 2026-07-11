import assert from "node:assert/strict";
import test from "node:test";
import { Folders } from "../../shared/folders.ts";
import {
	isBatchTriageActionAllowed,
	type BatchTriageAction,
} from "../../shared/batch-triage.ts";

test("batch action availability preserves folder lifecycle rules", () => {
	const allowed = (folderId: string) =>
		(["mark_read", "mark_unread", "archive", "trash"] as BatchTriageAction[])
			.filter((action) => isBatchTriageActionAllowed(action, folderId));

	assert.deepEqual(allowed(Folders.INBOX), [
		"mark_read",
		"mark_unread",
		"archive",
		"trash",
	]);
	assert.deepEqual(allowed(Folders.ARCHIVE), ["mark_read", "mark_unread", "trash"]);
	assert.deepEqual(allowed(Folders.SENT), ["trash"]);
	assert.deepEqual(allowed(Folders.TRASH), ["mark_read", "mark_unread"]);
	assert.deepEqual(allowed(Folders.OUTBOX), []);
	assert.deepEqual(allowed(Folders.DRAFT), []);
});
