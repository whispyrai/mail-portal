import assert from "node:assert/strict";
import test from "node:test";

import { StatefulSecretRedactor } from "./stateful-secret-redactor.mjs";

function redactChunks(chunks, secrets, options) {
	const redactor = new StatefulSecretRedactor(secrets, options);
	return chunks.map((chunk) => redactor.write(chunk)).join("") + redactor.flush();
}

test("exact secrets are redacted at every possible chunk boundary", () => {
	const secret = "exact-secret-value";
	const source = `before:${secret}:after`;
	for (let boundary = 0; boundary <= source.length; boundary += 1) {
		const result = redactChunks(
			[source.slice(0, boundary), source.slice(boundary)],
			[secret],
		);
		assert.equal(result, "before:[REDACTED]:after", `boundary ${boundary}`);
		assert.doesNotMatch(result, new RegExp(secret));
	}
});

test("Bearer credentials are redacted at every possible chunk boundary", () => {
	const credential = "opaque-provider-credential";
	const source = `before Bearer ${credential}\nafter`;
	for (let boundary = 0; boundary <= source.length; boundary += 1) {
		const result = redactChunks(
			[source.slice(0, boundary), source.slice(boundary)],
			[],
		);
		assert.equal(
			result,
			"before Bearer [REDACTED]\nafter",
			`boundary ${boundary}`,
		);
		assert.doesNotMatch(result, new RegExp(credential));
	}
});

test("short and long secrets remain exact and bounded", () => {
	const longSecret = "L".repeat(32 * 1024);
	const result = redactChunks(
		["prefix ~", longSecret.slice(0, 17), longSecret.slice(17), " suffix"],
		["~", longSecret],
	);
	assert.equal(result, "prefix [REDACTED][REDACTED] suffix");
	assert.doesNotMatch(result, /LLLL/);
});

test("an over-bound secret suppresses the stream instead of leaking", () => {
	const secret = "s".repeat(65);
	const result = redactChunks(
		["useful output ", secret.slice(0, 40), secret.slice(40)],
		[secret],
		{ maxCarry: 64 },
	);
	assert.equal(
		result,
		"[OUTPUT SUPPRESSED: a configured secret exceeds the redaction buffer]",
	);
	assert.doesNotMatch(result, /ssss/);
});

test("a long delimiter-free Bearer token stays bounded and redacted", () => {
	const credential = "t".repeat(400);
	const result = redactChunks(
		[`Bearer ${credential.slice(0, 100)}`, credential.slice(100), "\ndone"],
		[],
		{ maxCarry: 64 },
	);
	assert.equal(result, "Bearer [REDACTED]\ndone");
	assert.doesNotMatch(result, /tttt/);
});

test("independent stream instances cannot splice their carry state together", () => {
	const stdout = new StatefulSecretRedactor(["stdout-secret"]);
	const stderr = new StatefulSecretRedactor(["stderr-secret"]);
	const safeStdout =
		stdout.write("stdout-") + stdout.write("secret") + stdout.flush();
	const safeStderr =
		stderr.write("stderr-") + stderr.write("secret") + stderr.flush();
	assert.equal(safeStdout, "[REDACTED]");
	assert.equal(safeStderr, "[REDACTED]");
});

test("flush safely releases non-secret carry and redacts final credentials", () => {
	assert.equal(redactChunks(["ordinary be"], []), "ordinary be");
	assert.equal(
		redactChunks(["last Bearer final-credential"], []),
		"last Bearer [REDACTED]",
	);
});
