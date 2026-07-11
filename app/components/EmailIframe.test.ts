import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("./EmailIframe.tsx", import.meta.url),
	"utf8",
);

test("remote email images require explicit per-message consent", () => {
	assert.match(source, /messageId:\s*string/);
	assert.match(source, /remoteImagesForMessageId === messageId/);
	assert.doesNotMatch(source, /remoteImagesForBody === body/);
	assert.match(source, /image\.removeAttribute\("src"\)/);
	assert.match(source, /Remote images are blocked to protect your privacy/);
	assert.match(source, /loadRemoteImages \? " https:" : ""/);
});

test("every email renderer passes explicit message identity", () => {
	for (const relative of [
		"./email-panel/SingleMessageView.tsx",
		"./email-panel/ThreadMessage.tsx",
	]) {
		const renderer = readFileSync(new URL(relative, import.meta.url), "utf8");
		assert.match(renderer, /<EmailIframe[\s\S]*?messageId=\{email\.id\}/);
	}
});
