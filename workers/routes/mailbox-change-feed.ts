import { Hono, type Context } from "hono";
import {
	MailboxChangeQueryError,
	normalizeMailboxChangeQuery,
	type MailboxChangePage,
	type NormalizedMailboxChangeQuery,
} from "../../shared/mailbox-change-feed.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface MailboxChangeFeedOperations {
	list(options: NormalizedMailboxChangeQuery): Promise<MailboxChangePage>;
}

export interface MailboxChangeFeedRouteDependencies {
	operations(c: AppContext): MailboxChangeFeedOperations;
	revalidateAccess(c: AppContext): Promise<boolean>;
}

export function createMailboxChangeFeedRoutes(
	dependencies: MailboxChangeFeedRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/changes", async (c) => {
		let options: NormalizedMailboxChangeQuery;
		try {
			options = normalizeMailboxChangeQuery(new URL(c.req.url).searchParams);
		} catch (error) {
			if (error instanceof MailboxChangeQueryError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
		const read = await dependencies.operations(c).list(options).then(
			(page) => ({ status: "success" as const, page }),
			(error: unknown) => ({ status: "failed" as const, error }),
		);
		if (!(await dependencies.revalidateAccess(c))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		if (read.status === "failed") {
			if (read.error instanceof MailboxChangeQueryError) {
				return c.json({ error: read.error.message, code: read.error.code }, 400);
			}
			throw read.error;
		}
		return c.json(read.page);
	});
	return routes;
}

export const mailboxChangeFeedRoutes = createMailboxChangeFeedRoutes({
	operations: (c) => ({
		list: (options) => c.var.mailboxStub.listMailboxChanges(options),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
