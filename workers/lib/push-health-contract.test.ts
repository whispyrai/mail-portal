import assert from "node:assert/strict";
import test from "node:test";
import {
	PushHealthContractError,
	validatePushHealthResponse,
} from "../../shared/push-health.ts";

const ready = {
	state: "healthy",
	pendingCount: 0,
	refreshedAt: "2026-07-12T10:00:00.000Z",
	devices: [{
		id: "device-1",
		label: "Chrome on Mac",
		registeredAt: "2026-07-12T09:00:00.000Z",
		lastAttemptAt: "2026-07-12T09:30:00.000Z",
		lastAcceptedAt: "2026-07-12T09:30:00.000Z",
		health: "accepted",
		consecutiveFailures: 0,
	}],
};

test("strict push health contract accepts only canonical actor-private output", () => {
	assert.deepEqual(validatePushHealthResponse(ready), ready);
	for (const invalid of [
		{ ...ready, refreshedAt: "2026-07-12 10:00:00" },
		{ ...ready, pendingCount: 1 },
		{ ...ready, unexpected: true },
		{ ...ready, devices: [{ ...ready.devices[0], label: "Unsafe\u202elabel" }] },
		{ ...ready, devices: [{ ...ready.devices[0], registeredAt: null }] },
	]) {
		assert.throws(() => validatePushHealthResponse(invalid), PushHealthContractError);
	}
});

test("push health contract enforces deterministic newest-first device order", () => {
	const older = { ...ready.devices[0], id: "device-2", registeredAt: "2026-07-11T09:00:00.000Z" };
	assert.throws(() => validatePushHealthResponse({
		...ready,
		devices: [older, ready.devices[0]],
	}), PushHealthContractError);
});
