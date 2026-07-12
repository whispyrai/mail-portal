import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Files is a first-class mailbox route and sidebar destination", async () => {
	const [routes, sidebar] = await Promise.all([
		readFile(new URL("routes.ts", root), "utf8"),
		readFile(new URL("components/Sidebar.tsx", root), "utf8"),
	]);
	assert.match(routes, /route\("attachments", "routes\/attachments\.tsx"\)/);
	assert.match(sidebar, /\/attachments`}/);
	assert.match(sidebar, /label="Files"/);
});

test("workbench observes its real canvas, honors list width, and preserves mobile focus", async () => {
	const source = await readFile(
		new URL("components/attachments/AttachmentWorkbench.tsx", root),
		"utf8",
	);
	assert.match(source, /new ResizeObserver/);
	assert.match(source, /supportsSplitView\(containerWidth\)/);
	assert.match(source, /clampListPaneWidth\(listPaneWidth, containerWidth\)/);
	assert.match(source, /focusOriginRef/);
	assert.match(source, /requestAnimationFrame/);
	assert.match(source, /paramsWithSelectedAttachment/);
	assert.match(source, /filterCanvasWidth/);
	assert.doesNotMatch(source, /lg:grid-cols/);
	assert.match(source, /attachmentQuery.isError && attachmentQuery.items.length === 0/);
	assert.match(source, /attachmentQuery.isFetchNextPageError/);
	assert.match(source, /selectedDetail.isError && selectedAttachment/);
	assert.doesNotMatch(source, /mark.*read|updateEmail/i);
});

test("preview remains lazy, safe, and offers 44px download and message actions", async () => {
	const source = await readFile(
		new URL("components/attachments/AttachmentPreview.tsx", root),
		"utf8",
	);
	assert.match(source, /previewTypeForAttachment/);
	assert.match(source, /createObjectUrlLease/);
	assert.match(source, /role="status"/);
	assert.match(source, /role="alert"/);
	assert.match(source, /min-h-11/);
	assert.match(source, /Open message/);
	assert.match(source, /Download only/);
	assert.ok(source.indexOf("bytes.isError || decodeFailed") < source.indexOf("bytes.isPending || !objectUrl"));
	assert.doesNotMatch(source, /href=\{downloadUrl\}/);
	assert.match(source, /useAttachmentDownload/);
	assert.match(source, /previewResource\?\.attachmentId === attachment.id/);
	assert.match(source, /motion-reduce:animate-none/);
	assert.match(source, /sandbox="allow-scripts"/);
});
