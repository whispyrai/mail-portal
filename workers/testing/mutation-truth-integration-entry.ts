import type { ActivityActor } from "../lib/activity.ts";
import type { BatchTriageCommand } from "../../shared/batch-triage.ts";
import type { LabelMutationTarget } from "../lib/labels.ts";
import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class MutationTruthMailboxDO extends MailboxDO {
  async createResourceForTest(
    input: Parameters<MailboxDO["createMailboxResourceIdempotently"]>[0],
  ) {
    return this.createMailboxResourceIdempotently(input);
  }

  resourceCreateStateForTest() {
    return {
      folders: [
        ...this.ctx.storage.sql.exec(
          `SELECT folder.id, folder.name,
				        COALESCE(SUM(CASE WHEN email.read = 0 THEN 1 ELSE 0 END), 0) AS unreadCount
				 FROM folders AS folder
				 LEFT JOIN emails AS email ON email.folder_id = folder.id
				 WHERE folder.id LIKE 'replay-%'
				 GROUP BY folder.id, folder.name ORDER BY folder.id`,
        ),
      ],
      labels: [
        ...this.ctx.storage.sql.exec(
          `SELECT id, name, color FROM labels WHERE id LIKE 'replay-%' ORDER BY id`,
        ),
      ],
      operations: [
        ...this.ctx.storage.sql.exec(
          `SELECT operation_key AS operationKey, resource_kind AS resourceKind,
					        fingerprint, resource_id AS resourceId, state, updated_at AS updatedAt
					 FROM resource_create_operations ORDER BY operation_key`,
        ),
      ],
      activities: [
        ...this.ctx.storage.sql.exec(
          `SELECT action, entity_id AS entityId FROM activity_events
				 WHERE entity_id LIKE 'replay-%' ORDER BY action, entity_id`,
        ),
      ],
      changes: [
        ...this.ctx.storage.sql.exec(
          `SELECT sequence, resource, entity_id AS entityId, operation FROM mailbox_changes
				 WHERE entity_id LIKE 'replay-%' ORDER BY sequence`,
        ),
      ],
    };
  }

  async seedResourceFolderEmailForTest(input: {
    folderId: string;
    emailId: string;
    read: boolean;
  }) {
    await this.createEmail(
      input.folderId,
      {
        id: input.emailId,
        subject: "Replay count fixture",
        sender: "customer@example.com",
        recipient: "team@example.com",
        date: "2026-07-15T00:00:00.000Z",
        body: "<p>Replay count fixture</p>",
        read: input.read,
        starred: false,
        thread_id: null,
      },
      [],
      { kind: "system" },
    );
    return { status: "created" as const };
  }

  seedResourceCreateOperationsForTest(
    rows: Array<{
      operationKey: string;
      resourceKind: "folder" | "label";
      fingerprint: string;
      resourceId: string;
      state: "active" | "superseded" | "unavailable";
      updatedAt: string;
    }>,
  ) {
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO resource_create_operations
				 (operation_key, resource_kind, fingerprint, resource_id, state, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
        row.operationKey,
        row.resourceKind,
        row.fingerprint,
        row.resourceId,
        row.state,
        row.updatedAt,
      );
    }
  }
	async seedMutationTruthForTest() {
		const actor = { kind: "user" as const, id: "seed-user" };
		await this.createFolder("custom-retry", "Custom retry");
		const messages = [
			{ id: "message-1", read: false, starred: false, threadId: "thread-1" },
			{ id: "message-2", read: true, starred: false, threadId: "thread-1" },
			{ id: "message-3", read: false, starred: false, threadId: null },
			{ id: "message-4", read: false, starred: false, threadId: "thread-null" },
			{ id: "message-5", read: false, starred: false, threadId: null },
			{ id: "archive-older", read: false, starred: false, threadId: "thread-archive" },
			{ id: "archive-anchor", read: false, starred: false, threadId: "thread-archive" },
			{ id: "trash-older", read: false, starred: false, threadId: "thread-trash" },
			{ id: "trash-anchor", read: false, starred: false, threadId: "thread-trash" },
			{ id: "batch-message", read: false, starred: false, threadId: null },
			{ id: "custom-batch-message", read: false, starred: false, threadId: null },
			{ id: "batch-trash-older", read: false, starred: false, threadId: "thread-batch-trash" },
			{ id: "batch-trash-anchor", read: false, starred: false, threadId: "thread-batch-trash" },
		];
		for (const [index, message] of messages.entries()) {
			await this.createEmail(
				message.id.startsWith("trash-")
					? "sent"
					: message.id === "custom-batch-message"
						? "custom-retry"
						: "inbox",
				{
					id: message.id,
					subject: "Customer question",
					sender: "customer@example.com",
					recipient: "team@example.com",
					date: new Date(Date.parse("2026-07-14T10:00:00.000Z") + index * 60_000)
						.toISOString(),
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

	async seedArchiveReplyForTest() {
		return this.createEmail(
			"inbox",
			{
				id: "archive-new-reply",
				subject: "Customer question",
				sender: "customer@example.com",
				recipient: "team@example.com",
				date: "2026-07-14T11:00:00.000Z",
				body: "<p>New reply</p>",
				read: false,
				starred: false,
				thread_id: "thread-archive",
			},
			[],
			{ kind: "user", id: "seed-user" },
		);
	}

	async seedLabelFilteredBatchForTest() {
		const actor = { kind: "user" as const, id: "seed-user" };
		const label = await this.createLabel("Label-filtered batch", "blue", actor);
		const fixtures = [
			{ action: "mark-read", read: false },
			{ action: "mark-unread", read: true },
			{ action: "archive", read: false },
			{ action: "trash", read: false },
		];
		for (const [index, fixture] of fixtures.entries()) {
			for (const [offset, suffix] of ["anchor", "newer"].entries()) {
				await this.createEmail(
					"inbox",
					{
						id: `label-${fixture.action}-${suffix}`,
						subject: `Label-filtered ${fixture.action}`,
						sender: "customer@example.com",
						recipient: "team@example.com",
						date: new Date(
							Date.parse("2026-07-14T12:00:00.000Z") +
								(index * 2 + offset) * 60_000,
						).toISOString(),
						body: "<p>Label-filtered batch</p>",
						read: fixture.read,
						starred: false,
						thread_id: `thread-label-${fixture.action}`,
					},
					[],
					actor,
				);
			}
		}
		await this.mutateLabels(
			{
				labelId: label.id,
				action: "apply",
				targets: fixtures.map((fixture) => ({
					emailId: `label-${fixture.action}-anchor`,
					folderId: "inbox",
				})),
			},
			actor,
		);
		const rows = await this.getThreadedEmails({
			folder: "inbox",
			label_id: label.id,
			limit: 100,
		});
		return rows.map((row) => ({
			id: row.id,
			conversationId: row.conversation_id,
			threadCount: row.thread_count,
		}));
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
			  'batch_mark_read', 'batch_mark_unread',
			  'conversation_archived', 'conversation_trashed',
			  'batch_archive', 'batch_trash'
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
  createResourceForTest(
    input: Parameters<MailboxDO["createMailboxResourceIdempotently"]>[0],
  ): Promise<unknown>;
  resourceCreateStateForTest(): Promise<Record<string, unknown[]>>;
  seedResourceFolderEmailForTest(input: {
    folderId: string;
    emailId: string;
    read: boolean;
  }): Promise<unknown>;
  seedResourceCreateOperationsForTest(
    rows: Array<{
      operationKey: string;
      resourceKind: "folder" | "label";
      fingerprint: string;
      resourceId: string;
      state: "active" | "superseded" | "unavailable";
      updatedAt: string;
    }>,
  ): Promise<void>;
	seedMutationTruthForTest(): Promise<{ labelId: string }>;
	seedArchiveReplyForTest(): Promise<unknown>;
	seedLabelFilteredBatchForTest(): Promise<Array<{
		id: string;
		conversationId: string;
		threadCount: number;
	}>>;
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
    if (url.pathname === "/resource-create") {
      return Response.json(
        await stub.createResourceForTest(
          (await request.json()) as Parameters<
            MailboxDO["createMailboxResourceIdempotently"]
          >[0],
        ),
      );
    }
    if (url.pathname === "/resource-create-state") {
      return Response.json(await stub.resourceCreateStateForTest());
    }
    if (url.pathname === "/resource-create-email") {
      return Response.json(
        await stub.seedResourceFolderEmailForTest(
          (await request.json()) as {
            folderId: string;
            emailId: string;
            read: boolean;
          },
        ),
      );
    }
    if (url.pathname === "/resource-create-operation-seed") {
      await stub.seedResourceCreateOperationsForTest(
        (await request.json()) as Array<{
          operationKey: string;
          resourceKind: "folder" | "label";
          fingerprint: string;
          resourceId: string;
          state: "active" | "superseded" | "unavailable";
          updatedAt: string;
        }>,
      );
      return Response.json({ status: "seeded" });
    }
    if (url.pathname === "/update-folder") {
      const body = (await request.json()) as { id: string; name: string };
      return Response.json(await stub.updateFolder(body.id, body.name));
    }
    if (url.pathname === "/update-label") {
      const body = (await request.json()) as {
        id: string;
        name: string;
        color: string;
        actor: ActivityActor;
      };
      return Response.json(
        await stub.updateLabel(body.id, body.name, body.color, body.actor),
      );
    }
    if (url.pathname === "/delete-label") {
      const body = (await request.json()) as {
        id: string;
        actor: ActivityActor;
      };
      return Response.json({
        deleted: await stub.deleteLabel(body.id, body.actor),
      });
    }
		if (url.pathname === "/seed-archive-reply") {
			await stub.seedArchiveReplyForTest();
			return Response.json({ status: "created" });
		}
		if (url.pathname === "/seed-label-filtered-batch") {
			return Response.json(await stub.seedLabelFilteredBatchForTest());
		}
		if (url.pathname === "/seed-active-outbound") {
			const body = await request.json() as { emailId: string };
			await stub.seedActiveOutboundForTest(body.emailId);
			return Response.json({ status: "created" });
		}
		if (url.pathname === "/delete-folder") {
			const body = await request.json() as { folderId: string; actor: ActivityActor };
			return Response.json({
				deleted: await stub.deleteFolder(body.folderId, body.actor),
			});
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
		if (url.pathname === "/conversation-archive") {
			const body = await request.json() as {
				conversationId: string;
				folderId: string;
				representativeEmailId: string;
				actor: ActivityActor;
			};
			return Response.json(await stub.archiveConversation(
				body.conversationId,
				body.folderId,
				body.representativeEmailId,
				body.actor,
			));
		}
		if (url.pathname === "/conversation-trash") {
			const body = await request.json() as {
				conversationId: string;
				folderId: string;
				representativeEmailId: string;
				actor: ActivityActor;
			};
			return Response.json(await stub.trashConversation(
				body.conversationId,
				body.folderId,
				body.representativeEmailId,
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
