import { Hono, type Context } from "hono";
import {
	validateMailboxMessageLocation,
} from "../../shared/mailbox-message-location.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface MailboxMessageLocationDependencies {
	read(c: AppContext, emailId: string): Promise<unknown>;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

const productionDependencies: MailboxMessageLocationDependencies = {
	read: (c, emailId) => c.var.mailboxStub.getEmailLocation(emailId),
	revalidateAccess: hasLiveMailboxContentAccess,
};

export function createMailboxMessageLocationRoutes(
	dependencies: MailboxMessageLocationDependencies = productionDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/location", async (c) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		const emailId = c.req.param("emailId");
		if (!emailId) return c.json({ error: "Message id is required" }, 400);
		const location = await dependencies.read(c, emailId);
		if (!(await dependencies.revalidateAccess(c))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		if (!location) return c.json({ error: "Message not found" }, 404);
		try {
			return c.json(validateMailboxMessageLocation(location, emailId));
		} catch {
			return c.json({ error: "Message location is unavailable" }, 502);
		}
	});
	return routes;
}

export const mailboxMessageLocationRoutes = createMailboxMessageLocationRoutes();
