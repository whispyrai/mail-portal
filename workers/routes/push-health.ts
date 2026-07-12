import { Hono, type Context } from "hono";
import {
	validatePushHealthResponse,
	PushHealthContractError,
	type PushHealthResponse,
} from "../../shared/push-health.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface PushHealthRouteDependencies {
	read(c: AppContext, userId: string): Promise<PushHealthResponse>;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

export function createPushHealthRoutes(dependencies: PushHealthRouteDependencies) {
	const routes = new Hono<MailboxContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/push-health", async (c) => {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		const read = await dependencies.read(c, session.sub).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		if (!(await dependencies.revalidateAccess(c))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		if (!read.ok) {
			console.error("[push-health] read failed", {
				errorName: read.error instanceof Error ? read.error.name : "UnknownError",
			});
			return c.json({ error: "Push notification health is unavailable" }, 502);
		}
		try {
			return c.json(validatePushHealthResponse(read.value));
		} catch (error) {
			if (error instanceof PushHealthContractError) {
				return c.json({ error: "Push notification health is unavailable" }, 502);
			}
			throw error;
		}
	});
	return routes;
}

export const pushHealthRoutes = createPushHealthRoutes({
	read: (c, userId) => c.var.mailboxStub.getPushHealth(userId),
	revalidateAccess: hasLiveMailboxContentAccess,
});
