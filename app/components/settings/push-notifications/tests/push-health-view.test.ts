import assert from "node:assert/strict";
import test from "node:test";
import type {
	PushDeviceHealth,
	PushHealthResponse,
} from "~/services/push-health.ts";
import {
	pushDeviceHealthPresentation,
	pushHealthPresentation,
} from "../push-health-view.ts";

function health(
	state: PushHealthResponse["state"],
	pendingCount = 0,
): PushHealthResponse {
	return {
		state,
		pendingCount,
		refreshedAt: "2026-07-12T12:00:00.000Z",
		devices: [],
	};
}

function device(state: PushDeviceHealth["health"]): PushDeviceHealth {
	return {
		id: "device-1",
		label: "Safari on iPhone",
		registeredAt: "2026-07-10T09:00:00.000Z",
		lastAttemptAt: "2026-07-12T11:59:00.000Z",
		lastAcceptedAt: state === "accepted" ? "2026-07-12T11:59:00.000Z" : null,
		health: state,
		consecutiveFailures: state === "temporary_issue" ? 1 : 0,
	};
}

test("overall push health copy keeps Inbox truth explicit", () => {
	assert.match(pushHealthPresentation(health("not_configured")).description, /Inbox/);
	assert.match(pushHealthPresentation(health("retrying", 2)).description, /2 notification handoffs/);
	assert.match(pushHealthPresentation(health("degraded")).description, /safe in your Inbox/);
	assert.doesNotMatch(pushHealthPresentation(health("healthy")).title, /delivered/i);
});

test("accepted device copy names push-service acceptance without claiming display", () => {
	const accepted = pushDeviceHealthPresentation(device("accepted"));
	assert.equal(accepted.title, "Accepted by push service");
	assert.match(accepted.description, /display is not confirmed/i);
	assert.equal(accepted.timestamp, "2026-07-12T11:59:00.000Z");
});

test("every non-accepted device state has truthful action context", () => {
	assert.match(pushDeviceHealthPresentation(device("never_attempted")).description, /No notification/);
	assert.match(pushDeviceHealthPresentation(device("temporary_issue")).description, /latest handoff hit a temporary issue/);
	assert.doesNotMatch(pushDeviceHealthPresentation(device("temporary_issue")).description, /retry/i);
	assert.match(pushDeviceHealthPresentation(device("reenable_required")).description, /enable notifications again/);
});
