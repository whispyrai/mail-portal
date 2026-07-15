import { MailboxDO } from "../durableObject/index.ts";
import type { Env } from "../types.ts";

export class AutomationDryRunTestMailboxDO extends MailboxDO {
	automationDryRunStateForTest() {
		return {
			tests: [...this.ctx.storage.sql.exec(
				`SELECT id, actor_id AS actorId, rule_version AS ruleVersion
				 FROM automation_rule_tests ORDER BY id`,
			)],
		};
	}
}

type AutomationTestStub = DurableObjectStub<AutomationDryRunTestMailboxDO> & {
	automationDryRunStateForTest(): Promise<{
		tests: Array<Record<string, unknown>>;
	}>;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as AutomationTestStub;
		const body = request.method === "POST" ? await request.json() : null;
		let result: unknown;
		if (url.pathname === "/create") {
			result = await stub.createAutomationRuleDraft(body as never);
		} else if (url.pathname === "/update") {
			result = await stub.updateAutomationRuleDraft(body as never);
		} else if (url.pathname === "/dry-run") {
			result = await stub.dryRunAutomationRule(body as never);
		} else if (url.pathname === "/state") {
			result = await stub.automationDryRunStateForTest();
		} else {
			return new Response("Not found", { status: 404 });
		}
		return Response.json(result);
	},
};
