import assert from "node:assert/strict";
import test from "node:test";
import {
	consumeComposeEditorFileTransfer,
	consumeComposeFileTransfer,
	transferContainsFiles,
} from "./compose-file-transfer.ts";

function fakeFile(name: string): File {
	return { name, size: 1, type: "text/plain" } as File;
}

test("file paste/drop is consumed exactly once and forwards only ordinary File objects", () => {
	let prevented = 0;
	let stopped = 0;
	const received: File[][] = [];
	const consumed = consumeComposeFileTransfer(
		{
			clipboardData: { files: [fakeFile("a.txt"), fakeFile("b.txt")] },
			preventDefault: () => prevented++,
			stopPropagation: () => stopped++,
		},
		(files) => received.push(files),
	);

	assert.equal(consumed, true);
	assert.equal(prevented, 1);
	assert.equal(stopped, 1);
	assert.deepEqual(received[0]?.map((file) => file.name), ["a.txt", "b.txt"]);
});

test("editor transfers consume once, embed images, and keep non-images ordinary", () => {
	let prevented = 0;
	let stopped = 0;
	const inline: string[][] = [];
	const result = consumeComposeEditorFileTransfer(
		{
			dataTransfer: {
				files: [
					new File(["ok"], "chart.png", { type: "image/png" }),
					new File(["pdf"], "brief.pdf", { type: "application/pdf" }),
				],
			},
			preventDefault: () => prevented++,
			stopPropagation: () => stopped++,
		},
		{
			addInlineImages: (files) => {
				inline.push(files.map((file) => file.name));
				return [{ contentId: "chart@mail-portal.local", alt: "chart.png" }];
			},
		},
	);

	assert.equal(result.consumed, true);
	assert.deepEqual(result.inlineInsertions, [
		{ contentId: "chart@mail-portal.local", alt: "chart.png" },
	]);
	assert.deepEqual(inline, [["chart.png", "brief.pdf"]]);
	assert.equal(prevented, 1);
	assert.equal(stopped, 1);
});

test("plain text or HTML paste remains native", () => {
	let prevented = false;
	let stopped = false;
	let called = false;
	const consumed = consumeComposeFileTransfer(
		{
			clipboardData: { files: [] },
			preventDefault: () => { prevented = true; },
			stopPropagation: () => { stopped = true; },
		},
		() => { called = true; },
	);

	assert.equal(consumed, false);
	assert.equal(prevented, false);
	assert.equal(stopped, false);
	assert.equal(called, false);
});

test("drag affordance recognizes Files before the browser exposes a populated FileList", () => {
	assert.equal(transferContainsFiles({ files: [], types: ["Files"] }), true);
	assert.equal(transferContainsFiles({ files: [], types: ["text/plain"] }), false);
});
