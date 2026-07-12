import assert from "node:assert/strict";
import test from "node:test";
import { ComposeInlinePreviewUrls } from "./compose-inline-preview-urls.ts";

function fakeFile(name: string): File {
	return new File(["chart"], name, { type: "image/png" });
}

test("preview registry owns fresh object URLs and switches reopened drafts to authenticated URLs", () => {
	const created: string[] = [];
	const revoked: string[] = [];
	const previews = new ComposeInlinePreviewUrls({
		createObjectURL: (file) => {
			const url = `object-${file.name}-${created.length + 1}`;
			created.push(url);
			return url;
		},
		revokeObjectURL: (url) => revoked.push(url),
	});
	const file = fakeFile("chart.png");
	const fresh = {
		localId: "local-1",
		filename: file.name,
		mimetype: file.type,
		status: "uploading",
		disposition: "inline",
		contentId: "CHART@mail-portal.local",
		file,
	};

	assert.deepEqual(previews.reconcile([fresh], "mailbox/1"), {
		"chart@mail-portal.local": "object-chart.png-1",
	});
	assert.deepEqual(previews.reconcile([fresh], "mailbox/1"), {
		"chart@mail-portal.local": "object-chart.png-1",
	});
	assert.equal(created.length, 1);

	assert.deepEqual(
		previews.reconcile(
			[{
				...fresh,
				file: undefined,
				status: "ready",
				existing: { emailId: "draft 1", attachmentId: "part/1" },
			}],
			"mailbox/1",
		),
		{
			"chart@mail-portal.local":
				"/api/v1/mailboxes/mailbox%2F1/emails/draft%201/attachments/part%2F1",
		},
	);
	assert.deepEqual(revoked, ["object-chart.png-1"]);

	previews.releaseAll();
	assert.deepEqual(previews.reconcile([fresh], "mailbox/1"), {
		"chart@mail-portal.local": "object-chart.png-2",
	});
	previews.release("local-1");
	assert.deepEqual(revoked, ["object-chart.png-1", "object-chart.png-2"]);
});
