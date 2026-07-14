import { Hono } from "hono";
import { z } from "zod";
import type { SessionClaims } from "../lib/auth.ts";
import {
	MailboxAccessError,
	mailboxAccess,
	type MailboxManagementRow,
	type MailboxMember,
	type SharedMailboxManagementAccess,
} from "../lib/mailbox-access.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";
import { requireAgentConnectionReconciliation } from "../lib/agent-connection-revocation-outbox.ts";
import type { Env } from "../types.ts";

export type SharedMailboxAdminContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

export type SharedMailboxAdminDependencies = {
	access: (env: Env) => SharedMailboxManagementAccess;
	mailboxMetadataExists: (env: Env, address: string) => Promise<boolean>;
	revokeMemberSideEffects?: (
		env: Env,
		mailboxId: string,
		userId: string,
	) => Promise<void>;
};

const RegisterSharedMailboxBody = z.object({
	address: z.string(),
});

const AddSharedMailboxMemberBody = z.object({
	userId: z.string().min(1),
});

function mailboxMetadata(row: MailboxManagementRow) {
	return {
		id: row.id,
		address: row.address,
		type: row.type,
		isActive: row.is_active === 1,
		ownerUserId: row.owner_user_id,
		memberCount: row.member_count,
	};
}

function registeredMailboxMetadata(
	row: Awaited<ReturnType<SharedMailboxManagementAccess["registerSharedMailbox"]>>,
) {
	return {
		id: row.id,
		address: row.address,
		type: row.type,
		isActive: row.is_active === 1,
		ownerUserId: row.owner_user_id,
	};
}

function memberMetadata(member: MailboxMember) {
	return {
		id: member.id,
		email: member.email,
		role: member.role,
		isActive: member.is_active === 1,
	};
}

const productionDependencies: SharedMailboxAdminDependencies = {
	access: mailboxAccess,
	async mailboxMetadataExists(env, address) {
		return Boolean(await env.BUCKET.head(`mailboxes/${address}.json`));
	},
	async revokeMemberSideEffects(env, mailboxId, userId) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const [agentResult, pushResult] = await Promise.allSettled([
			requireAgentConnectionReconciliation(env, {
				mailboxId,
				userId,
				scope: "ACTOR",
			}),
			stub.removePushSubscriptionsForUser(userId),
		]);
		if (pushResult.status === "rejected") {
			console.error("[shared-mailbox] push cleanup failed after revocation", {
				mailboxId,
				userId,
				errorName:
					pushResult.reason instanceof Error
						? pushResult.reason.name
						: "UnknownError",
			});
		}
		if (agentResult.status === "rejected") throw agentResult.reason;
	},
};

export function createSharedMailboxAdminApp(
	dependencies: SharedMailboxAdminDependencies = productionDependencies,
) {
	const app = new Hono<SharedMailboxAdminContext>();

	app.onError((error, c) => {
		if (error instanceof MailboxAccessError) {
			if (error.code === "FORBIDDEN") {
				return c.json({ error: error.message }, 403);
			}
			if (error.code === "NOT_FOUND") {
				return c.json({ error: error.message }, 404);
			}
			return c.json({ error: error.message }, 409);
		}
		throw error;
	});

	app.use("*", async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		await next();
	});

	app.get("/mailboxes", async (c) => {
		const session = c.get("session")!;
		const access = dependencies.access(c.env);
		const read = await access.listManagedMailboxes(session.sub).then(
			(rows) => ({ status: "success" as const, rows }),
			(error: unknown) => ({ status: "failed" as const, error }),
		);
		await access.requireMailboxAdministrator(session.sub);
		if (read.status === "failed") throw read.error;
		return c.json({ mailboxes: read.rows.map(mailboxMetadata) });
	});

	app.post("/shared-mailboxes", async (c) => {
		const parsed = RegisterSharedMailboxBody.safeParse(await c.req.json());
		const address = parsed.success
			? normalizeMailAddress(parsed.data.address)
			: null;
		if (!address) {
			return c.json({ error: "A valid mailbox address is required" }, 400);
		}
		const session = c.get("session")!;
		const access = dependencies.access(c.env);
		await access.requireMailboxAdministrator(session.sub);
		if (!(await dependencies.mailboxMetadataExists(c.env, address))) {
			return c.json({ error: "Mailbox metadata was not found" }, 404);
		}

		const mailbox = await access.registerSharedMailbox(session.sub, address);
		return c.json(registeredMailboxMetadata(mailbox), 201);
	});

	app.get("/shared-mailboxes/:mailboxId/members", async (c) => {
		const session = c.get("session")!;
		const access = dependencies.access(c.env);
		const read = await access
			.listSharedMailboxMembers(session.sub, c.req.param("mailboxId")!)
			.then(
				(members) => ({ status: "success" as const, members }),
				(error: unknown) => ({ status: "failed" as const, error }),
			);
		await access.requireMailboxAdministrator(session.sub);
		if (read.status === "failed") throw read.error;
		return c.json({ members: read.members.map(memberMetadata) });
	});

	app.post("/shared-mailboxes/:mailboxId/members", async (c) => {
		const parsed = AddSharedMailboxMemberBody.safeParse(await c.req.json());
		if (!parsed.success) {
			return c.json({ error: "A valid userId is required" }, 400);
		}
		const session = c.get("session")!;
		const member = await dependencies
			.access(c.env)
			.addSharedMailboxMember(
				session.sub,
				c.req.param("mailboxId")!,
				parsed.data.userId,
			);
		return c.json(memberMetadata(member), 201);
	});

	app.delete("/shared-mailboxes/:mailboxId/members/:userId", async (c) => {
		const session = c.get("session")!;
		const mailboxId = c.req.param("mailboxId")!;
		const userId = c.req.param("userId")!;
		await dependencies
			.access(c.env)
			.removeSharedMailboxMember(
				session.sub,
				mailboxId,
				userId,
			);
		await dependencies
			.revokeMemberSideEffects?.(c.env, mailboxId, userId);
		return c.body(null, 204);
	});

	return app;
}

export const sharedMailboxAdminApp = createSharedMailboxAdminApp();
