import assert from "node:assert/strict";
import test from "node:test";
import { saveBlobAsDownload } from "./attachment-download.ts";

test("controlled downloads click a temporary anchor and always revoke the object URL", async () => {
	const events: string[] = [];
	await saveBlobAsDownload(new Blob(["file"], { type: "text/html" }), "report.pdf", {
		createObjectURL: (blob) => {
			events.push(`type:${blob.type}`);
			return "blob:download-1";
		},
		revokeObjectURL: (url) => events.push(`revoke:${url}`),
		click: (url, filename) => events.push(`click:${url}:${filename}`),
		waitForNavigation: async () => { events.push("navigation-task"); },
	});

	assert.deepEqual(events, [
		"type:application/octet-stream",
		"click:blob:download-1:report.pdf",
		"navigation-task",
		"revoke:blob:download-1",
	]);
});

test("controlled downloads revoke even when the browser click fails", async () => {
	const revoked: string[] = [];
	await assert.rejects(
		saveBlobAsDownload(new Blob(), "bad.bin", {
			createObjectURL: () => "blob:download-2",
			revokeObjectURL: (url) => revoked.push(url),
			click: () => { throw new Error("click failed"); },
			waitForNavigation: async () => undefined,
		}),
		/click failed/,
	);
	assert.deepEqual(revoked, ["blob:download-2"]);
});

test("default revocation waits beyond the current microtask for browser navigation", async () => {
	const events: string[] = [];
	const saving = saveBlobAsDownload(new Blob(), "safari.pdf", {
		createObjectURL: () => "blob:download-3",
		revokeObjectURL: () => events.push("revoke"),
		click: () => events.push("click"),
	});
	assert.deepEqual(events, ["click"]);
	await Promise.resolve();
	assert.deepEqual(events, ["click"]);
	await saving;
	assert.deepEqual(events, ["click", "revoke"]);
});
