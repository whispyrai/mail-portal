import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import { adminOutboundRecoveryApp } from "./admin-outbound-recovery.ts";

function appFor(
	role: SessionClaims["role"],
	recover: (...args: unknown[]) => Promise<unknown>,
	list: (...args: unknown[]) => Promise<unknown> = async () => ({
		recoveries: [],
		nextCursor: null,
	}),
	draftCleanup: {
		list?: (...args: unknown[]) => Promise<unknown>;
		repair?: (...args: unknown[]) => Promise<unknown>;
		listAttachment?: (...args: unknown[]) => Promise<unknown>;
		repairAttachment?: (...args: unknown[]) => Promise<unknown>;
		listR2?: (...args: unknown[]) => Promise<unknown>;
		repairR2?: (...args: unknown[]) => Promise<unknown>;
	} = {},
) {
	const app = new Hono<{
		Bindings: Env;
		Variables: { session?: SessionClaims };
	}>();
	app.use("*", async (c, next) => {
		c.set("session", {
			sub: "admin-1",
			email: "admin@example.com",
			role,
			sessionVersion: 1,
		} as SessionClaims);
		await next();
	});
	app.route("/", adminOutboundRecoveryApp);
	return {
		app,
		env: {
			MAILBOX: {
				idFromName: () => "mailbox-id",
				get: () => ({
					recoverParkedOutboundAcceptance: recover,
					listParkedOutboundAcceptanceRecoveries: list,
					listParkedDraftSaveCleanupIntents:
						draftCleanup.list ?? (async () => ({ items: [] })),
					repairParkedDraftSaveCleanupIntent:
						draftCleanup.repair ?? (async () => ({ status: "not_found" })),
					listParkedAttachmentCleanupJobs:
						draftCleanup.listAttachment ?? (async () => ({ items: [] })),
					repairParkedAttachmentCleanupJob:
						draftCleanup.repairAttachment ?? (async () => ({ status: "not_found" })),
					listParkedR2DeletionRecoveries:
						draftCleanup.listR2 ?? (async () => ({ items: [] })),
					repairParkedR2Deletion:
						draftCleanup.repairR2 ?? (async () => ({ status: "not_found" })),
				}),
			},
		} as unknown as Env,
	};
}

test("parked outbound acceptance recovery is discoverable only by administrators", async () => {
	const agent = appFor("AGENT", async () => ({ status: "committed" }));
	const denied = await agent.app.request(
		"http://mail.test/recover-outbound/team%40example.com",
		undefined,
		agent.env,
	);
	assert.equal(denied.status, 403);

	let received: unknown[] = [];
	const admin = appFor(
		"ADMIN",
		async () => ({ status: "committed" }),
		async (...args) => {
			received = args;
			return {
				recoveries: [{
					deliveryId: "delivery-1",
					emailId: "email-1",
					generation: 3,
					attemptCount: 6,
					lastErrorCode: "outbound_projection_retry_exhausted",
					updatedAt: "2026-07-16T01:00:00.000Z",
					evidence: {
						acceptedAttemptCount: 1,
						distinctProviderIdentityCount: 1,
						status: "unique",
					},
				}],
				nextCursor: "delivery-1",
			};
		},
	);
	const response = await admin.app.request(
		"http://mail.test/recover-outbound/team%40example.com?after=delivery-0&limit=25",
		undefined,
		admin.env,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(received, ["delivery-0", 25]);
	assert.equal((await response.json() as { recoveries: unknown[] }).recoveries.length, 1);
});

test("parked draft cleanup exposes bounded owner evidence and audited repair", async () => {
	let repairArgs: unknown[] = [];
	const { app, env } = appFor(
		"ADMIN",
		async () => ({ status: "committed" }),
		undefined,
		{
			list: async () => ({
				items: [{
					claimToken: "claim-1",
					draftId: "draft-1",
					generation: 2,
					attempts: 0,
					lastErrorCode: "draft_save_destination_plan_invalid",
					parkedAt: 1,
				}],
			}),
			repair: async (...args) => {
				repairArgs = args;
				return { status: "repaired", generation: 3 };
			},
		},
	);
	const listed = await app.request(
		"http://mail.test/recover-draft-cleanup/team%40example.com?limit=25",
		undefined,
		env,
	);
	assert.equal(listed.status, 200);
	assert.deepEqual((await listed.json() as { items: unknown[] }).items, [{
		claimToken: "claim-1",
		draftId: "draft-1",
		generation: 2,
		attempts: 0,
		lastErrorCode: "draft_save_destination_plan_invalid",
		parkedAt: 1,
		evidence: {
			r2Prefix: "attachments/draft-1/",
			requiredMetadata: { promotionOwner: "claim-1" },
		},
	}]);

	const repaired = await app.request(
		"http://mail.test/recover-draft-cleanup/team%40example.com/claim-1",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedGeneration: 2,
				destinationKeys: ["attachments/draft-1/attachment-1/file.pdf"],
			}),
		},
		env,
	);
	assert.equal(repaired.status, 200);
	assert.deepEqual(repairArgs, [
		"claim-1",
		{
			expectedGeneration: 2,
			destinationKeys: ["attachments/draft-1/attachment-1/file.pdf"],
		},
		{ kind: "user", id: "admin-1" },
	]);
});

test("opaque cleanup recovery never exposes object keys", async () => {
	let repaired: unknown[] = [];
	const { app, env } = appFor(
		"ADMIN",
		async () => ({ status: "committed" }),
		undefined,
		{
			listR2: async () => ({
				items: [{
					recoveryRef: "opaque-1",
					emailId: "email-1",
					generation: 7,
					attempts: 6,
					lastErrorCode: "R2_DELETION_FAILED",
					parkedAt: "2026-07-16T01:00:00.000Z",
				}],
			}),
			repairR2: async (...args) => {
				repaired = args;
				return { status: "repaired", generation: 8 };
			},
		},
	);
	const listed = await app.request(
		"http://mail.test/recover-r2-deletion/team%40example.com?limit=10",
		undefined,
		env,
	);
	assert.equal(listed.status, 200);
	const body = await listed.json() as { items: Array<Record<string, unknown>> };
	assert.equal("r2Key" in body.items[0]!, false);

	const response = await app.request(
		"http://mail.test/recover-r2-deletion/team%40example.com/opaque-1",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ operationKey: "repair-1", expectedGeneration: 7 }),
		},
		env,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(repaired, [
		"opaque-1",
		{ operationKey: "repair-1", expectedGeneration: 7 },
		{ kind: "user", id: "admin-1" },
	]);
});

test("outbound acceptance recovery requires an administrator", async () => {
	const { app, env } = appFor("AGENT", async () => ({ status: "committed" }));
	const response = await app.request(
		"http://mail.test/recover-outbound/team%40example.com/delivery-1",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationKey: "repair-1",
				expectedGeneration: 1,
				action: "retry_projection",
			}),
		},
		env,
	);
	assert.equal(response.status, 403);
});

test("outbound acceptance recovery passes only bounded operator intent", async () => {
	let received: unknown[] = [];
	const { app, env } = appFor("ADMIN", async (...args) => {
		received = args;
		return { status: "committed", generation: 2, recoveryPending: true };
	});
	const response = await app.request(
		"http://mail.test/recover-outbound/team%40example.com/delivery-1",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationKey: "repair-1",
				expectedGeneration: 1,
				action: "reconcile_from_ledger",
			}),
		},
		env,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "committed",
		generation: 2,
		recoveryPending: true,
	});
	assert.deepEqual(received, [
		"delivery-1",
		{
			operationKey: "repair-1",
			expectedGeneration: 1,
			action: "reconcile_from_ledger",
		},
		{ kind: "user", id: "admin-1" },
	]);
});
