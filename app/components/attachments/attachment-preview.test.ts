import assert from "node:assert/strict";
import test from "node:test";
import {
	createObjectUrlLease,
	previewTypeForAttachment,
} from "./attachment-preview.ts";

test("only strict raster image and PDF MIME/extension pairs can preview", () => {
	assert.equal(previewTypeForAttachment("scan.PDF", "application/pdf"), "pdf");
	assert.equal(previewTypeForAttachment("photo.jpeg", "image/jpeg"), "image");
	assert.equal(previewTypeForAttachment("photo.png", "image/png; charset=binary"), "image");
	assert.equal(previewTypeForAttachment("animation.gif", "image/gif"), "image");
	assert.equal(previewTypeForAttachment("vector.svg", "image/svg+xml"), null);
	assert.equal(previewTypeForAttachment("page.html", "text/html"), null);
	assert.equal(previewTypeForAttachment("photo.jpg", "image/png"), null);
	assert.equal(previewTypeForAttachment("report.pdf", "application/octet-stream"), null);
});

test("an object URL lease revokes exactly once", () => {
	const revoked: string[] = [];
	const lease = createObjectUrlLease(new Blob(["preview"]), {
		createObjectURL: () => "blob:preview-1",
		revokeObjectURL: (url) => revoked.push(url),
	});

	assert.equal(lease.url, "blob:preview-1");
	lease.revoke();
	lease.revoke();
	assert.deepEqual(revoked, ["blob:preview-1"]);
});
