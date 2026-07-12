import assert from "node:assert/strict";
import test from "node:test";
import {
	mergeStoredSignature,
	normalizeEffectiveSignature,
	parseSignatureUpdate,
} from "./mailbox-signature-settings.ts";

test("effective signatures normalize line endings and safely read legacy HTML as text", () => {
	assert.deepEqual(
		normalizeEffectiveSignature({
			enabled: true,
			html: "<strong>Hello &amp; welcome</strong><br>Team<script>bad()</script>",
		}),
		{ enabled: true, text: "Hello & welcome\nTeam" },
	);
	assert.deepEqual(
		normalizeEffectiveSignature({ enabled: true, text: "One\r\nTwo\rThree" }),
		{ enabled: true, text: "One\nTwo\nThree" },
	);
});

test("new signature updates are exact, bounded, normalized, and remove legacy HTML", () => {
	assert.deepEqual(parseSignatureUpdate({ enabled: true, text: "One\r\nTwo" }), {
		enabled: true,
		text: "One\nTwo",
	});
	for (const invalid of [
		{ enabled: true, text: "ok", extra: true },
		{ enabled: "true", text: "ok" },
		{ enabled: true, text: "x".repeat(2_001) },
		{ enabled: true },
	]) assert.throws(() => parseSignatureUpdate(invalid), /signature/i);
	assert.deepEqual(
		mergeStoredSignature(
			{ fromName: "Team", signature: { enabled: false, text: "old", html: "<b>old</b>" }, untouched: { yes: true } },
			{ enabled: true, text: "new" },
		),
		{ fromName: "Team", signature: { enabled: true, text: "new" }, untouched: { yes: true } },
	);
});
