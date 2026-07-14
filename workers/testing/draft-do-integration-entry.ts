import type { ActivityActor } from "../lib/activity.ts";
import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class DraftTestMailboxDO extends MailboxDO {
	draftStateForTest() {
		const emails = [...this.ctx.storage.sql.exec(
			`SELECT id, draft_version AS draftVersion, draft_create_key AS createKey
			 FROM emails
			 WHERE draft_create_key IS NOT NULL
			 ORDER BY id`,
		)];
		const activities = [...this.ctx.storage.sql.exec(
			`SELECT action, entity_id AS entityId
			 FROM activity_events
			 WHERE action IN ('draft_created', 'draft_updated')
			 ORDER BY occurred_at, id`,
		)];
		const operations = [...this.ctx.storage.sql.exec(
			`SELECT create_key AS createKey, draft_id AS draftId,
			        draft_version AS draftVersion, state
			 FROM draft_create_operations
			 ORDER BY create_key`,
		)];
		return { emails, activities, operations };
	}
}

type DraftTestStub = DurableObjectStub<DraftTestMailboxDO> & {
	draftStateForTest(): Promise<{
		emails: Array<Record<string, unknown>>;
		activities: Array<Record<string, unknown>>;
		operations: Array<Record<string, unknown>>;
	}>;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as DraftTestStub;
		if (url.pathname === "/state") {
			return Response.json(await stub.draftStateForTest());
		}
		if (url.pathname === "/upsert") {
			const body = await request.json() as {
				input: Parameters<MailboxDO["upsertDraft"]>[0];
				actor: ActivityActor;
			};
			return Response.json(await stub.upsertDraft(body.input, [], body.actor));
		}
		if (url.pathname === "/discard") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.discardDraft(body.draftId, body.draftVersion, body.actor),
			);
		}
		if (url.pathname === "/consume") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.consumeDraftVersion(body.draftId, body.draftVersion, body.actor),
			);
		}
		if (url.pathname === "/delete") {
			const body = await request.json() as { draftId: string };
			const deleted = await stub.deleteEmail(body.draftId);
			return Response.json({ status: deleted ? "deleted" : "missing" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
