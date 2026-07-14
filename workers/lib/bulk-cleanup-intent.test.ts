import assert from "node:assert/strict";
import test from "node:test";
import {
	bulkCleanupBacklogCount,
	bulkCleanupNextAt,
	completeBulkCleanupClaim,
	planBulkCleanupClaim,
	retryBulkCleanupClaim,
	type BulkCleanupIntent,
} from "./bulk-cleanup-intent.ts";

function intent(overrides: Partial<BulkCleanupIntent> = {}): BulkCleanupIntent {
	return {
		id: "cleanup-a",
		ownerId: "job-a:recipient-0",
		keys: ["attachments/a"],
		dueAt: 1_000,
		leaseToken: null,
		leaseExpiresAt: null,
		attempts: 0,
		createdAt: 500,
		...overrides,
	};
}

test("cleanup claims the oldest due intent and recovers an expired lease", () => {
	const claim = planBulkCleanupClaim(
		[
			["bulk:cleanup:b", intent({ id: "b", dueAt: 2_000 })],
			[
				"bulk:cleanup:a",
				intent({
					id: "a",
					leaseToken: "expired",
					leaseExpiresAt: 1_500,
				}),
			],
		],
		2_000,
		"lease-new",
		60_000,
	);

	assert.deepEqual(claim, {
		key: "bulk:cleanup:a",
		intent: intent({
			id: "a",
			leaseToken: "lease-new",
			leaseExpiresAt: 62_000,
			attempts: 1,
		}),
	});
});

test("cleanup completion and retry are fenced by the active lease", () => {
	const claimed = intent({
		leaseToken: "lease-current",
		leaseExpiresAt: 61_000,
		attempts: 1,
	});

	assert.equal(completeBulkCleanupClaim(claimed, "lease-stale"), false);
	assert.equal(completeBulkCleanupClaim(claimed, "lease-current"), true);
	assert.equal(
		retryBulkCleanupClaim(claimed, "lease-stale", 5_000, 60_000),
		null,
	);
	assert.deepEqual(
		retryBulkCleanupClaim(claimed, "lease-current", 5_000, 60_000),
		{
			...claimed,
			dueAt: 65_000,
			leaseToken: null,
			leaseExpiresAt: null,
		},
	);
});

test("cleanup maintenance schedules lease recovery and bounds only immediate backlog", () => {
	const intents = [
		intent({ id: "due", dueAt: 1_000 }),
		intent({
			id: "leased",
			dueAt: 500,
			leaseToken: "active",
			leaseExpiresAt: 4_000,
		}),
		intent({ id: "protected", dueAt: 120_000 }),
	];

	assert.equal(bulkCleanupNextAt(intents), 1_000);
	assert.equal(bulkCleanupBacklogCount(intents, 1_000, 60_000), 2);
});
