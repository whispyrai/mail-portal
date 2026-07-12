import assert from "node:assert/strict";
import test from "node:test";
import { InlineImagePreviewRegistry } from "./inline-image-preview-registry.ts";

test("preview registry updates mapped CIDs case-insensitively without touching editor content", () => {
	const registry = new InlineImagePreviewRegistry();
	let notifications = 0;
	const unsubscribe = registry.subscribe(() => notifications++);

	registry.replace({ "CHART@MAIL-PORTAL.LOCAL": "trusted-preview-1" });
	assert.equal(registry.get("chart@mail-portal.local"), "trusted-preview-1");
	assert.equal(notifications, 1);

	registry.replace({ "chart@mail-portal.local": "trusted-preview-1" });
	assert.equal(notifications, 1);
	registry.replace({ "chart@mail-portal.local": "trusted-preview-2" });
	assert.equal(registry.get("CHART@MAIL-PORTAL.LOCAL"), "trusted-preview-2");
	assert.equal(notifications, 2);

	unsubscribe();
	registry.replace({});
	assert.equal(notifications, 2);
});
