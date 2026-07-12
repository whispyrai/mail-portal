import type { Context } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { actorFromSession } from "../lib/activity.ts";
import { AutomationRuleError } from "../lib/automation-rules/index.ts";

type AppContext = Context<MailboxContext>;

export async function handleDeleteFolder(c: AppContext) {
	let result;
	try {
		const names = await c.var.mailboxStub.getAutomationTargetUsage({
			folderId: c.req.param("id")!,
		});
		if (names.length > 0) {
			return c.json({
				error: `Target is used by Automation ${names.length === 1 ? "Rule" : "Rules"}: ${names.join(", ")}`,
				code: "RULE_TARGET_IN_USE",
			}, 409);
		}
		result = await c.var.mailboxStub.deleteFolder(
			c.req.param("id")!,
			actorFromSession(c.get("session")),
		);
	} catch (error) {
		if (
			(error instanceof AutomationRuleError && error.code === "RULE_TARGET_IN_USE") ||
			(error instanceof Error && error.name === "AutomationRuleError:RULE_TARGET_IN_USE")
		) {
			return c.json({ error: error.message, code: "RULE_TARGET_IN_USE" }, 409);
		}
		throw error;
	}
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
