import type { ActivityActor } from "../lib/activity.ts";
import type { BatchTriageCommand } from "../../shared/batch-triage.ts";
import type { LabelMutationTarget } from "../lib/labels.ts";
import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class MutationTruthMailboxDO extends MailboxDO {
	async seedMutationTruthForTest() {
		const actor = { kind: "user" as const, id: "seed-user" };
		const messages = [
			{ id: "message-1", read: false, starred: false, threadId: "thread-1" },
			{ id: "message-2", read: true, starred: false, threadId: "thread-1" },
			{ id: "message-3", read: false, starred: false, threadId: null },
			{ id: "message-4", read: false, starred: false, threadId: "thread-null" },
			{ id: "message-5", read: false, starred: false, threadId: null },
		];
		for (const [index, message] of messages.entries()) {
			await this.createEmail(
				"inbox",
				{
					id: message.id,
					subject: "Customer question",
					sender: "customer@example.com",
					recipient: "team@example.com",
					date: `2026-07-14T10:0${index}:00.000Z`,
					body: "<p>Hello</p>",
					read: message.read,
					starred: message.starred,
					thread_id: message.threadId,
				},
				[],
				actor,
			);
		}
		this.ctx.storage.sql.exec(
			`UPDATE emails SET starred = NULL WHERE id IN ('message-3', 'message-4')`,
		);
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = NULL WHERE id IN ('message-4', 'message-5')`,
		);
		const label = await this.createLabel("Priority", "red", actor);
		return { labelId: label.id };
	}

	seedActiveOutboundForTest(emailId: string) {
		const now = "2026-07-14T10:10:00.000Z";
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_deliveries (
			 id, email_id, idempotency_key, kind, source, actor_kind, status,
			 available_at, undo_until, created_at, updated_at
			) VALUES (?, ?, ?, 'send', 'portal', 'user', 'queued', ?, ?, ?, ?)`,
			`delivery-${emailId}`,
			emailId,
			`test-${emailId}`,
			now,
			now,
			now,
			now,
		);
	}

	mutationTruthStateForTest() {
		const emails = [...this.ctx.storage.sql.exec(
			`SELECT id, folder_id AS folderId, read, starred
			 FROM emails ORDER BY id`,
		)];
		const labels = [...this.ctx.storage.sql.exec(
			`SELECT email_id AS emailId, label_id AS labelId
			 FROM email_labels ORDER BY email_id, label_id`,
		)];
		const activities = [...this.ctx.storage.sql.exec(
			`SELECT action, entity_id AS entityId, metadata_json AS metadataJson
			 FROM activity_events
			 WHERE action IN (
			  'email_updated', 'conversation_read_state_changed',
			  'label_applied', 'label_removed', 'email_moved',
			  'batch_mark_read', 'batch_mark_unread'
			 )
			 ORDER BY occurred_at, id`,
		)];
		const changes = [...this.ctx.storage.sql.exec(
			`SELECT sequence, resource, entity_id AS entityId, operation
			 FROM mailbox_changes ORDER BY sequence`,
		)];
		return { emails, labels, activities, changes };
	}
}

type MutationTruthStub = DurableObjectStub<MutationTruthMailboxDO> & {
	seedMutationTruthForTest(): Promise<{ labelId: string }>;
	seedActiveOutboundForTest(emailId: string): Promise<void>;
	mutationTruthStateForTest(): Promise<{
		emails: Array<Record<string, unknown>>;
		labels: Array<Record<string, unknown>>;
		activities: Array<Record<string, unknown>>;
		changes: Array<Record<string, unknown>>;
	}>;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as MutationTruthStub;
		if (url.pathname === "/seed") {
			return Response.json(await stub.seedMutationTruthForTest());
		}
		if (url.pathname === "/state") {
			return Response.json(await stub.mutationTruthStateForTest());
		}
		if (url.pathname === "/seed-active-outbound") {
			const body = await request.json() as { emailId: string };
			await stub.seedActiveOutboundForTest(body.emailId);
			return Response.json({ status: "created" });
		}
		if (url.pathname === "/update-email") {
			const body = await request.json() as {
				id: string;
				changes: { read?: boolean; starred?: boolean };
				actor: ActivityActor;
			};
			return Response.json(
				await stub.updateEmail(body.id, body.changes, body.actor),
			);
		}
		if (url.pathname === "/conversation-read") {
			const body = await request.json() as {
				conversationId: string;
				folderId: string;
				read: boolean;
				actor: ActivityActor;
			};
			return Response.json(await stub.setConversationRead(
				body.conversationId,
				body.folderId,
				body.read,
				body.actor,
			));
		}
		if (url.pathname === "/mutate-labels") {
			const body = await request.json() as {
				labelId: string;
				action: "apply" | "remove";
				targets: LabelMutationTarget[];
				actor: ActivityActor;
			};
			return Response.json(await stub.mutateLabels(
				{ labelId: body.labelId, action: body.action, targets: body.targets },
				body.actor,
			));
		}
		if (url.pathname === "/move") {
			const body = await request.json() as {
				id: string;
				folderId: string;
				actor: ActivityActor;
			};
			return Response.json({
				result: await stub.moveEmail(body.id, body.folderId, body.actor),
			});
		}
		if (url.pathname === "/batch") {
			const body = await request.json() as {
				command: BatchTriageCommand;
				actor: ActivityActor;
			};
			return Response.json(await stub.batchTriage(body.command, body.actor));
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
