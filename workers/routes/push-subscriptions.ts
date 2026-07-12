import { Hono, type Context } from "hono";
import { PushSubscriptionSchema } from "../lib/schemas.ts";
import { buildDeviceLabel } from "../lib/push/deviceLabel.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface PushSubscriptionOperations {
	upsert(input: {
		userId: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		deviceLabel: string;
	}): Promise<{ id: string; deviceLabel: string; generation: number }>;
	remove(id: string, userId: string, generation?: number): Promise<boolean>;
}

export interface PushSubscriptionRouteDependencies {
	operations(c: AppContext): PushSubscriptionOperations;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

export function createPushSubscriptionRoutes(
	dependencies: PushSubscriptionRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.post("/api/v1/mailboxes/:mailboxId/push-subscriptions", async (c) => {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		const parsed = PushSubscriptionSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ error: "Invalid push subscription" }, 400);
		const userAgent = c.req.header("user-agent") ?? null;
		const result = await dependencies.operations(c).upsert({
			userId: session.sub,
			endpoint: parsed.data.endpoint,
			p256dh: parsed.data.keys.p256dh,
			auth: parsed.data.keys.auth,
			userAgent,
			deviceLabel: buildDeviceLabel(userAgent),
		});
		if (!(await dependencies.revalidateAccess(c))) {
			await dependencies.operations(c).remove(
				result.id,
				session.sub,
				result.generation,
			);
			return c.json({ error: "Forbidden" }, 403);
		}
		return c.json(result, 201);
	});

	routes.delete("/api/v1/mailboxes/:mailboxId/push-subscriptions/:id", async (c) => {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		const subscriptionId = c.req.param("id");
		if (!subscriptionId) return c.json({ error: "Subscription id is required" }, 400);
		const removed = await dependencies.operations(c).remove(subscriptionId, session.sub);
		if (!(await dependencies.revalidateAccess(c))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		return removed ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
	});
	return routes;
}

export const pushSubscriptionRoutes = createPushSubscriptionRoutes({
	operations: (c) => ({
		upsert: (input) => c.var.mailboxStub.upsertPushSubscription(input),
		remove: (id, userId, generation) =>
			c.var.mailboxStub.deletePushSubscription(id, userId, generation),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
