import assert from "node:assert/strict";
import test from "node:test";
import { mailTelemetryLogRef, mailTelemetryRef } from "./mail-telemetry.ts";

test("mail telemetry refs are deterministic, domain-separated opaque tokens", async () => {
	assert.equal(
		await mailTelemetryRef("queue", "queue-message-123"),
		"d06683c38d7755ce",
	);
	assert.equal(
		await mailTelemetryRef("ingress", "ingress-123"),
		"441f515039db06d5",
	);
	assert.equal(
		await mailTelemetryRef("attempt", "مرحبا-123"),
		"4e63bb2c733ccbde",
	);
	assert.notEqual(
		await mailTelemetryRef("message", "queue-message-123"),
		await mailTelemetryRef("queue", "queue-message-123"),
	);
	assert.match(
		await mailTelemetryRef("object", "raw/2026/07/16/ingress-123.eml"),
		/^[a-f0-9]{16}$/,
	);
});

test("mail telemetry refs fail closed when hashing is unavailable", async (context) => {
	context.mock.method(crypto.subtle, "digest", async () => {
		throw new Error("simulated digest failure");
	});

	await assert.rejects(
		mailTelemetryRef("queue", "raw-queue-message-id"),
		/simulated digest failure/,
	);
	assert.equal(
		await mailTelemetryLogRef("queue", "raw-queue-message-id"),
		"unavailable",
	);
});
