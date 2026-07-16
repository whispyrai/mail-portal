import assert from "node:assert/strict";
import test from "node:test";
import {
	InvalidDeliveryTransitionError,
	canCancelDelivery,
	classifySesOutcome,
	computeAvailableAt,
	shouldRetainSourceDraft,
	transitionDelivery,
} from "./outbound-delivery-contract.ts";

test("a delivery is queued before any provider call and sent only after SES acceptance", () => {
	assert.equal(transitionDelivery("queued", "start_sending"), "sending");
	assert.equal(transitionDelivery("sending", "provider_accepted"), "sent");
});

test("local integrity failure can terminalize work before provider dispatch", () => {
	assert.equal(transitionDelivery("queued", "definitive_failure"), "failed");
	assert.equal(transitionDelivery("retrying", "definitive_failure"), "failed");
});

test("a lost worker lease is unknown, never an automatic retry", () => {
	assert.equal(transitionDelivery("sending", "lease_expired"), "unknown");
	assert.deepEqual(
		classifySesOutcome({ kind: "transport_ambiguous", detail: "timeout" }),
		{
			kind: "unknown",
			automaticRetry: false,
			code: "transport_ambiguous",
		},
	);
});

test("a malformed success response is unknown because SES may have accepted it", () => {
	assert.deepEqual(classifySesOutcome({ kind: "invalid_success_response" }), {
			kind: "unknown",
			automaticRetry: false,
			code: "invalid_success_response",
	});
});

test("only proven throttling rejection retries while server errors remain ambiguous", () => {
	assert.equal(
		classifySesOutcome({ kind: "http_error", status: 429 }).automaticRetry,
		true,
	);
	for (const status of [408, 500, 502, 503, 504]) {
		assert.deepEqual(classifySesOutcome({ kind: "http_error", status }), {
			kind: "unknown",
			automaticRetry: false,
			code: `ses_http_${status}_acceptance_unknown`,
		});
	}
	assert.equal(
		classifySesOutcome({ kind: "http_error", status: 400 }).automaticRetry,
		false,
	);
	assert.equal(
		classifySesOutcome({ kind: "http_error", status: 600 }).automaticRetry,
		false,
	);
});

test("scheduled retries and later provider bounces are explicit states", () => {
	assert.equal(transitionDelivery("sending", "schedule_retry"), "retrying");
	assert.equal(transitionDelivery("retrying", "retry_ready"), "queued");
	assert.equal(transitionDelivery("sent", "provider_bounced"), "bounced");
});

test("Send Later and the undo delay both gate dispatch", () => {
	assert.equal(
		computeAvailableAt("2026-07-11T10:00:10.000Z"),
		"2026-07-11T10:00:10.000Z",
	);
	assert.equal(
		computeAvailableAt("2026-07-11T10:00:10.000Z", "2026-07-11T15:00:00.000Z"),
		"2026-07-11T15:00:00.000Z",
	);
	assert.equal(
		computeAvailableAt("2026-07-11T10:00:10.000Z", "2026-07-11T09:00:00.000Z"),
		"2026-07-11T10:00:10.000Z",
	);
});

test("unclaimed queued or retrying mail can be cancelled", () => {
	assert.equal(canCancelDelivery("queued"), true);
	assert.equal(canCancelDelivery("retrying"), true);
	for (const status of [
		"sending",
		"sent",
		"bounced",
		"failed",
		"unknown",
		"cancelled",
	] as const) {
		assert.equal(canCancelDelivery(status), false);
	}
	assert.equal(transitionDelivery("queued", "cancel"), "cancelled");
});

test("source draft survives until SES acceptance is confirmed", () => {
	for (const status of [
		"queued",
		"sending",
		"retrying",
		"failed",
		"unknown",
		"cancelled",
	] as const) {
		assert.equal(shouldRetainSourceDraft(status), true);
	}
	assert.equal(shouldRetainSourceDraft("sent"), false);
	assert.equal(shouldRetainSourceDraft("bounced"), false);
});

test("unknown delivery requires an explicit force-retry transition", () => {
	assert.equal(transitionDelivery("unknown", "force_retry_unknown"), "queued");
	assert.throws(
		() => transitionDelivery("unknown", "retry_failed"),
		InvalidDeliveryTransitionError,
	);
});

test("confirmed sent delivery is terminal", () => {
	assert.throws(
		() => transitionDelivery("sent", "schedule_retry"),
		InvalidDeliveryTransitionError,
	);
	assert.throws(
		() => transitionDelivery("sent", "cancel"),
		InvalidDeliveryTransitionError,
	);
});
