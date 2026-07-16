import assert from "node:assert/strict";
import test from "node:test";

import { outboundDeliveryAction } from "./outbound-delivery-actions.ts";

test("queued delivery offers persistent cancellation", () => {
	assert.deepEqual(outboundDeliveryAction("queued"), {
		kind: "cancel",
		label: "Cancel send",
		requiresDuplicateRiskConfirmation: false,
	});
});

test("automatic retry remains cancellable before the next provider attempt", () => {
	assert.deepEqual(outboundDeliveryAction("retrying"), {
		kind: "cancel",
		label: "Cancel send",
		requiresDuplicateRiskConfirmation: false,
	});
});

test("failed cancellation recovery offers a persistent completion action", () => {
	assert.deepEqual(outboundDeliveryAction("cancelled", true), {
		kind: "cancel",
		label: "Finish cancellation",
		requiresDuplicateRiskConfirmation: false,
	});
});

test("failed and unknown delivery offer explicit retry semantics", () => {
	assert.deepEqual(outboundDeliveryAction("failed"), {
		kind: "retry",
		label: "Retry send",
		requiresDuplicateRiskConfirmation: false,
	});
	assert.deepEqual(outboundDeliveryAction("unknown"), {
		kind: "retry",
		label: "Retry with duplicate risk",
		requiresDuplicateRiskConfirmation: true,
	});
});

test("non-actionable delivery states do not offer unsafe controls", () => {
	for (const status of [
		"sending",
		"sent",
		"bounced",
		"cancelled",
	] as const) {
		assert.equal(outboundDeliveryAction(status), null);
	}
});

test("storage-integrity failures expose no unsafe retry action", () => {
	assert.equal(
		outboundDeliveryAction(
			"unknown",
			false,
			"outbound_delivery_record_invalid",
		),
		null,
	);
});

test("deterministic attachment failures require rebuilding the message", () => {
	for (const code of [
		"attachment_integrity_unverifiable",
		"attachment_metadata_mismatch",
		"attachment_size_mismatch",
		"attachment_content_mismatch",
		"attachment_missing",
	]) {
		assert.equal(outboundDeliveryAction("failed", false, undefined, code), null);
	}
});
