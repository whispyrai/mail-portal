import type { Context } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { actorFromSession } from "../lib/activity.ts";

type AppContext = Context<MailboxContext>;

export async function handleDeleteFolder(c: AppContext) {
	const result = await c.var.mailboxStub.deleteFolder(
		c.req.param("id")!,
		actorFromSession(c.get("session")),
	);
	if (result === "deleted") return c.body(null, 204);
	if (result === "not_empty") {
		return c.json(
			{ error: "Move or delete all emails before deleting this folder" },
			409,
		);
	}
	if (result === "protected") {
		return c.json({ error: "System folders cannot be deleted" }, 403);
	}
	return c.json({ error: "Folder not found" }, 404);
}
