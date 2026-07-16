import { Hono, type Context } from "hono";
import { z } from "zod";
import type { SessionClaims } from "../lib/auth.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";
import type { Env } from "../types.ts";

type AdminOutboundRecoveryEnv = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

const RecoveryBody = z.object({
	operationKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
	expectedGeneration: z.number().int().nonnegative(),
	action: z.enum(["reconcile_from_ledger", "retry_projection"]),
});

const RecoveryListQuery = z.object({
	after: z.string().trim().min(1).max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

const DraftCleanupRecoveryBody = z.object({
	expectedGeneration: z.number().int().nonnegative(),
	destinationKeys: z.array(z.string().trim().min(1).max(1024)).min(1).max(10),
});

const OpaqueCleanupRecoveryBody = z.object({
	operationKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
	expectedGeneration: z.number().int().nonnegative(),
});

export const adminOutboundRecoveryApp = new Hono<AdminOutboundRecoveryEnv>();

adminOutboundRecoveryApp.get(
	"/recover-outbound/:mailboxId",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") {
			return c.json({ error: "Forbidden" }, 403);
		}
		const mailboxId = normalizeMailAddress(
			decodeURIComponent(c.req.param("mailboxId")),
		);
		const parsed = RecoveryListQuery.safeParse(c.req.query());
		if (!mailboxId || !parsed.success) {
			return c.json({ error: "Invalid recovery query" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		return c.json(
			await mailbox.listParkedOutboundAcceptanceRecoveries(
				parsed.data.after,
				parsed.data.limit,
			),
		);
	},
);

adminOutboundRecoveryApp.post(
	"/recover-outbound/:mailboxId/:deliveryId",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") {
			return c.json({ error: "Forbidden" }, 403);
		}
		const mailboxId = normalizeMailAddress(
			decodeURIComponent(c.req.param("mailboxId")),
		);
		const deliveryId = c.req.param("deliveryId").trim();
		const parsed = RecoveryBody.safeParse(await c.req.json().catch(() => null));
		if (!mailboxId || !deliveryId || !parsed.success) {
			return c.json({ error: "Invalid recovery request" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const result = await mailbox.recoverParkedOutboundAcceptance(
			deliveryId,
			parsed.data,
			{ kind: "user", id: session.sub },
		);
		switch (result.status) {
			case "not_found":
				return c.json({ error: "Outbound recovery record not found" }, 404);
			case "not_parked":
				return c.json({ error: "Outbound recovery is not parked" }, 409);
			case "generation_conflict":
				return c.json(
					{ error: "Outbound recovery generation changed", generation: result.generation },
					409,
				);
			case "evidence_conflict":
				return c.json({ error: "Provider acceptance evidence is missing or invalid" }, 409);
			default:
				return c.json({
					status: result.status,
					generation: result.generation,
					...(result.recoveryPending ? { recoveryPending: true as const } : {}),
				});
		}
	},
);

adminOutboundRecoveryApp.get(
	"/recover-attachment-cleanup/:mailboxId",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") return c.json({ error: "Forbidden" }, 403);
		const mailboxId = normalizeMailAddress(decodeURIComponent(c.req.param("mailboxId")));
		const parsed = RecoveryListQuery.safeParse(c.req.query());
		if (!mailboxId || !parsed.success) return c.json({ error: "Invalid recovery query" }, 400);
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		return c.json(await mailbox.listParkedAttachmentCleanupJobs(parsed.data.limit));
	},
);

adminOutboundRecoveryApp.post(
	"/recover-attachment-cleanup/:mailboxId/:recoveryRef",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") return c.json({ error: "Forbidden" }, 403);
		const mailboxId = normalizeMailAddress(decodeURIComponent(c.req.param("mailboxId")));
		const recoveryRef = c.req.param("recoveryRef").trim();
		const parsed = OpaqueCleanupRecoveryBody.safeParse(await c.req.json().catch(() => null));
		if (!mailboxId || !recoveryRef || !parsed.success) {
			return c.json({ error: "Invalid cleanup recovery request" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const result = await mailbox.repairParkedAttachmentCleanupJob(
			recoveryRef,
			parsed.data,
			{ kind: "user", id: session.sub },
		);
		return cleanupRecoveryResponse(c, result);
	},
);

adminOutboundRecoveryApp.get(
	"/recover-r2-deletion/:mailboxId",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") return c.json({ error: "Forbidden" }, 403);
		const mailboxId = normalizeMailAddress(decodeURIComponent(c.req.param("mailboxId")));
		const parsed = RecoveryListQuery.safeParse(c.req.query());
		if (!mailboxId || !parsed.success) return c.json({ error: "Invalid recovery query" }, 400);
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		return c.json(
			await mailbox.listParkedR2DeletionRecoveries(parsed.data.after, parsed.data.limit),
		);
	},
);

adminOutboundRecoveryApp.post(
	"/recover-r2-deletion/:mailboxId/:recoveryRef",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") return c.json({ error: "Forbidden" }, 403);
		const mailboxId = normalizeMailAddress(decodeURIComponent(c.req.param("mailboxId")));
		const recoveryRef = c.req.param("recoveryRef").trim();
		const parsed = OpaqueCleanupRecoveryBody.safeParse(await c.req.json().catch(() => null));
		if (!mailboxId || !recoveryRef || !parsed.success) {
			return c.json({ error: "Invalid cleanup recovery request" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const result = await mailbox.repairParkedR2Deletion(
			recoveryRef,
			parsed.data,
			{ kind: "user", id: session.sub },
		);
		return cleanupRecoveryResponse(c, result);
	},
);

function cleanupRecoveryResponse(
	c: Context<AdminOutboundRecoveryEnv>,
	result: {
		status: string;
		generation?: number;
	},
) {
	switch (result.status) {
		case "not_found":
			return c.json({ error: "Cleanup recovery record not found" }, 404);
		case "not_parked":
			return c.json({ error: "Cleanup recovery is not parked" }, 409);
		case "generation_conflict":
			return c.json({ error: "Cleanup recovery generation changed", generation: result.generation }, 409);
		default:
			return c.json(result);
	}
}

adminOutboundRecoveryApp.get(
	"/recover-draft-cleanup/:mailboxId",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") {
			return c.json({ error: "Forbidden" }, 403);
		}
		const mailboxId = normalizeMailAddress(
			decodeURIComponent(c.req.param("mailboxId")),
		);
		const parsed = RecoveryListQuery.safeParse(c.req.query());
		if (!mailboxId || !parsed.success) {
			return c.json({ error: "Invalid recovery query" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const result = await mailbox.listParkedDraftSaveCleanupIntents(
			parsed.data.after,
			parsed.data.limit,
		);
		return c.json({
			...result,
			items: result.items.map((item) => ({
				...item,
				evidence: {
					r2Prefix: `attachments/${item.draftId}/`,
					requiredMetadata: {
						promotionOwner: item.claimToken,
					},
				},
			})),
		});
	},
);

adminOutboundRecoveryApp.post(
	"/recover-draft-cleanup/:mailboxId/:claimToken",
	async (c) => {
		const session = c.get("session");
		if (!session || session.role !== "ADMIN") {
			return c.json({ error: "Forbidden" }, 403);
		}
		const mailboxId = normalizeMailAddress(
			decodeURIComponent(c.req.param("mailboxId")),
		);
		const claimToken = c.req.param("claimToken").trim();
		const parsed = DraftCleanupRecoveryBody.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!mailboxId || !claimToken || !parsed.success) {
			return c.json({ error: "Invalid cleanup recovery request" }, 400);
		}
		const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const result = await mailbox.repairParkedDraftSaveCleanupIntent(
			claimToken,
			parsed.data,
			{ kind: "user", id: session.sub },
		);
		switch (result.status) {
			case "not_found":
				return c.json({ error: "Draft cleanup recovery record not found" }, 404);
			case "not_parked":
				return c.json({ error: "Draft cleanup recovery is not parked" }, 409);
			case "generation_conflict":
				return c.json(
					{ error: "Draft cleanup recovery generation changed", generation: result.generation },
					409,
				);
			case "invalid_plan":
				return c.json({ error: "Draft cleanup recovery plan is invalid" }, 400);
			default:
				return c.json(result);
		}
	},
);
