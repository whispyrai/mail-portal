import assert from "node:assert/strict";
import test from "node:test";
import {
	attachmentWorkbenchStateFromParams,
	paramsWithAttachmentFilter,
	paramsWithSelectedAttachment,
} from "./attachment-workbench-state.ts";

test("reads only normalized attachment filters and selection from the URL", () => {
	const state = attachmentWorkbenchStateFromParams(new URLSearchParams({
		q: "  quarterly report  ",
		kind: "pdf",
		folder: "custom/finance",
		selected: "attachment-2",
	}));

	assert.deepEqual(state, {
		q: "quarterly report",
		kind: "pdf",
		invalidKind: null,
		folder: "custom/finance",
		selected: "attachment-2",
	});

	const invalid = attachmentWorkbenchStateFromParams(
		new URLSearchParams("kind=executable&q=%20%20"),
	);
	assert.equal(invalid.kind, "");
	assert.equal(invalid.invalidKind, "executable");

	const hostile = attachmentWorkbenchStateFromParams(
		new URLSearchParams({ kind: `\u202e${"x".repeat(200)}` }),
	);
	assert.equal(hostile.invalidKind?.includes("\u202e"), false);
	assert.ok((hostile.invalidKind?.length ?? 0) <= 61);
});

test("applying a filter preserves unrelated history state and clears selection", () => {
	const next = paramsWithAttachmentFilter(
		new URLSearchParams("q=old&kind=image&selected=file-1&from=back"),
		{ q: "  board deck ", kind: "presentation", folder: "sent" },
	);

	assert.equal(next.toString(), "q=board+deck&kind=presentation&from=back&folder=sent");
});

test("selection is URL-owned and can be cleared without losing collection filters", () => {
	const current = new URLSearchParams("q=invoice&kind=pdf&folder=inbox");
	const selected = paramsWithSelectedAttachment(current, "file/1");
	assert.equal(selected.get("selected"), "file/1");

	const cleared = paramsWithSelectedAttachment(selected, null);
	assert.equal(cleared.toString(), "q=invoice&kind=pdf&folder=inbox");
});
