import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

type State = {
	emails: Array<{
		id: string;
		folderId: string;
		read: number | null;
		starred: number | null;
	}>;
	labels: Array<{ emailId: string; labelId: string }>;
	activities: Array<{
		action: string;
		entityId: string;
		metadataJson: string;
	}>;
	changes: Array<{
		sequence: number;
		resource: string;
		entityId: string;
		operation: string;
	}>;
};

test(
	"Mailbox desired-state retries emit only real activity and change-feed rows",
	{ timeout: 30_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-mutation-truth-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/mutation-truth-integration-entry.ts",
					"--dry-run",
					"--outdir",
					outputDirectory,
					"--compatibility-date",
					"2026-07-14",
					"--compatibility-flag",
					"nodejs_compat",
					"--config",
					"wrangler.jsonc",
					"--env=",
					"--upload-source-maps=false",
				],
				{
					cwd: ROOT,
					env: {
						...process.env,
						WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log"),
					},
				},
			);
			const bundle = await readFile(
				join(outputDirectory, "mutation-truth-integration-entry.js"),
				"utf8",
			);
			runtime = new Miniflare({
				log: new Log(LogLevel.ERROR),
				modules: true,
				script: bundle,
				compatibilityDate: "2026-07-14",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					MAILBOX: { className: "MutationTruthMailboxDO", useSQLite: true },
				},
				r2Buckets: ["BUCKET"],
				d1Databases: ["DB"],
				kvNamespaces: ["OAUTH_KV"],
				bindings: {
					BRAND: "wiser",
					FEATURES: [],
					DOMAINS: "wiserchat.ai",
					EMAIL_ADDRESSES: [],
					AWS_REGION: "eu-west-2",
					SES_CONFIGURATION_SET: "mail-portal-events",
					AI_MODEL: "test",
					AI_CHEAP_MODEL: "test",
					AI_STRONG_MODEL: "test",
					AI_COST_ALERT_USD: "25",
					AI_COST_REVIEW_USD: "50",
					VAPID_SUBJECT: "mailto:test@example.com",
				},
			});

			const mailboxId = "team@example.com";
      const request = async <T>(
        path: string,
        body?: unknown,
        targetMailboxId = mailboxId,
      ): Promise<T> => {
				const response = await runtime!.dispatchFetch(
          `http://mutation.test${path}?mailbox=${encodeURIComponent(targetMailboxId)}`,
					body === undefined
						? undefined
						: {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(body),
							},
				);
				const text = await response.text();
				assert.equal(response.status, 200, text);
				return JSON.parse(text) as T;
			};
			const actor = { kind: "user", id: "user-1" };
      const folderCreate = {
        kind: "folder",
        operationKey: "a".repeat(64),
        fingerprint: "b".repeat(64),
        resourceId: "replay-folder",
        name: "Replay folder",
        actor,
      };
      const labelCreate = {
        kind: "label",
        operationKey: "c".repeat(64),
        fingerprint: "d".repeat(64),
        resourceId: "replay-label",
        name: "Replay label",
        color: "red",
        actor,
      };
      assert.equal(
        (await request<{ status: string }>("/resource-create", folderCreate))
          .status,
        "created",
      );
      await request("/resource-create-email", {
        folderId: folderCreate.resourceId,
        emailId: "folder-replay-unread-fixture",
        read: false,
      });
      const beforeUnreadReplay = await request("/resource-create-state");
      assert.deepEqual(
        await request<{ status: string; resource: { unreadCount: number } }>(
          "/resource-create",
          folderCreate,
        ),
        {
          status: "replayed",
          resource: {
            id: "replay-folder",
            name: "Replay folder",
            unreadCount: 1,
          },
        },
      );
      assert.deepEqual(
        await request("/resource-create-state"),
        beforeUnreadReplay,
      );
      assert.equal(
        (await request<{ status: string }>("/resource-create", labelCreate))
          .status,
        "created",
      );
      assert.equal(
        (await request<{ status: string }>("/resource-create", labelCreate))
          .status,
        "replayed",
      );
      let createState = await request<{
        folders: Array<{ id: string; name: string; unreadCount: number }>;
        labels: Array<{ id: string; name: string; color: string }>;
        operations: Array<{ operationKey: string; state: string }>;
        activities: Array<{ action: string; entityId: string }>;
        changes: Array<{
          resource: string;
          entityId: string;
          operation: string;
        }>;
      }>("/resource-create-state");
      assert.equal(createState.folders.length, 1);
      assert.equal(createState.labels.length, 1);
      assert.deepEqual(
        createState.operations.map((operation) => operation.state),
        ["active", "active"],
      );
      assert.equal(
        createState.activities.filter(
          (event) => event.action === "folder_created",
        ).length,
        1,
      );
      assert.equal(
        createState.activities.filter(
          (event) => event.action === "label_created",
        ).length,
        1,
      );
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "folder" &&
            change.entityId === "replay-folder" &&
            change.operation === "created",
        ).length,
        1,
      );

      const concurrentLabel = {
        ...labelCreate,
        operationKey: "3".repeat(64),
        fingerprint: "4".repeat(64),
        resourceId: "replay-concurrent-label",
        name: "Concurrent label",
        color: "purple",
      };
      const concurrentLabelResults = await Promise.all([
        request<{ status: string }>("/resource-create", concurrentLabel),
        request<{ status: string }>("/resource-create", concurrentLabel),
      ]);
      assert.deepEqual(
        concurrentLabelResults.map((result) => result.status).sort(),
        ["created", "replayed"],
      );
      createState = await request("/resource-create-state");
      assert.equal(
        createState.labels.filter(
          (label) => label.id === "replay-concurrent-label",
        ).length,
        1,
      );
      assert.equal(
        createState.activities.filter(
          (event) =>
            event.action === "label_created" &&
            event.entityId === "replay-concurrent-label",
        ).length,
        1,
      );
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "label" &&
            change.entityId === "replay-concurrent-label" &&
            change.operation === "created",
        ).length,
        1,
      );
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "label" &&
            change.entityId === "replay-label" &&
            change.operation === "created",
        ).length,
        1,
      );

      const concurrentFolder = {
        ...folderCreate,
        operationKey: "e".repeat(64),
        fingerprint: "f".repeat(64),
        resourceId: "replay-concurrent-folder",
        name: "Concurrent folder",
      };
      const concurrentResults = await Promise.all([
        request<{ status: string }>("/resource-create", concurrentFolder),
        request<{ status: string }>("/resource-create", concurrentFolder),
      ]);
      assert.deepEqual(
        concurrentResults.map((result) => result.status).sort(),
        ["created", "replayed"],
      );
      createState = await request("/resource-create-state");
      assert.equal(
        createState.folders.filter(
          (folder) => folder.id === "replay-concurrent-folder",
        ).length,
        1,
      );
      assert.equal(
        createState.activities.filter(
          (event) =>
            event.action === "folder_created" &&
            event.entityId === "replay-concurrent-folder",
        ).length,
        1,
      );
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "folder" &&
            change.entityId === "replay-concurrent-folder" &&
            change.operation === "created",
        ).length,
        1,
      );

      const beforeConflict = structuredClone(createState);
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...concurrentFolder,
            fingerprint: "0".repeat(64),
            name: "Changed intent",
          })
        ).status,
        "idempotency_conflict",
      );
      assert.deepEqual(await request("/resource-create-state"), beforeConflict);
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...concurrentFolder,
            operationKey: "1".repeat(64),
            fingerprint: "2".repeat(64),
            resourceId: "replay-losing-folder",
          })
        ).status,
        "name_conflict",
      );
      assert.deepEqual(await request("/resource-create-state"), beforeConflict);
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...concurrentLabel,
            fingerprint: "5".repeat(64),
            color: "orange",
          })
        ).status,
        "idempotency_conflict",
      );
      assert.deepEqual(await request("/resource-create-state"), beforeConflict);
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...concurrentLabel,
            operationKey: "6".repeat(64),
            fingerprint: "7".repeat(64),
            resourceId: "replay-losing-label",
          })
        ).status,
        "name_conflict",
      );
      assert.deepEqual(await request("/resource-create-state"), beforeConflict);

      assert.equal(
        (
          await request<{ status: string }>(
            "/resource-create",
            concurrentFolder,
            "other@example.com",
          )
        ).status,
        "created",
      );
      assert.equal(
        (
          await request<{ status: string }>(
            "/resource-create",
            concurrentLabel,
            "other@example.com",
          )
        ).status,
        "created",
      );
      const isolatedState = await request<{
        folders: Array<{ id: string }>;
        labels: Array<{ id: string }>;
        operations: Array<{ operationKey: string }>;
        activities: Array<{ action: string; entityId: string }>;
        changes: Array<{
          resource: string;
          entityId: string;
          operation: string;
        }>;
      }>("/resource-create-state", undefined, "other@example.com");
      assert.deepEqual(
        isolatedState.folders.map((folder) => folder.id),
        ["replay-concurrent-folder"],
      );
      assert.deepEqual(
        isolatedState.labels.map((label) => label.id),
        ["replay-concurrent-label"],
      );
      assert.deepEqual(
        isolatedState.operations
          .map((operation) => operation.operationKey)
          .sort(),
        ["3".repeat(64), "e".repeat(64)].sort(),
      );
      assert.deepEqual(
        isolatedState.activities
          .map((event) => [event.action, event.entityId])
          .sort(),
        [
          ["folder_created", "replay-concurrent-folder"],
          ["label_created", "replay-concurrent-label"],
        ].sort(),
      );
      assert.deepEqual(
        isolatedState.changes
          .map((change) => [
            change.resource,
            change.entityId,
            change.operation,
          ])
          .sort(),
        [
          ["folder", "replay-concurrent-folder", "created"],
          ["label", "replay-concurrent-label", "created"],
        ].sort(),
      );
      assert.deepEqual(await request("/resource-create-state"), beforeConflict);
      const originalOperationStates = () =>
        createState.operations
          .filter((operation) =>
            ["a".repeat(64), "c".repeat(64)].includes(operation.operationKey),
          )
          .map((operation) => operation.state);

      const beforeNoOp = structuredClone(createState);
      await request("/update-folder", {
        id: "replay-folder",
        name: "Replay folder",
      });
      await request("/update-label", {
        id: "replay-label",
        name: "Replay label",
        color: "red",
        actor,
      });
      createState = await request("/resource-create-state");
      assert.deepEqual(createState, beforeNoOp);
      assert.deepEqual(originalOperationStates(), ["active", "active"]);
      await request("/update-folder", {
        id: "replay-folder",
        name: "Renamed folder",
      });
      await request("/update-label", {
        id: "replay-label",
        name: "Renamed label",
        color: "blue",
        actor,
      });
      createState = await request("/resource-create-state");
      assert.deepEqual(originalOperationStates(), ["superseded", "superseded"]);
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "folder" &&
            change.entityId === "replay-folder" &&
            change.operation === "updated",
        ).length,
        1,
      );
      assert.equal(
        createState.changes.filter(
          (change) =>
            change.resource === "label" &&
            change.entityId === "replay-label" &&
            change.operation === "updated",
        ).length,
        1,
      );
      assert.equal(
        createState.activities.filter(
          (event) =>
            event.action === "label_updated" &&
            event.entityId === "replay-label",
        ).length,
        1,
      );
      const beforeSupersededRetry = structuredClone(createState);
      assert.equal(
        (await request<{ status: string }>("/resource-create", folderCreate))
          .status,
        "creation_superseded",
      );
      assert.equal(
        (await request<{ status: string }>("/resource-create", labelCreate))
          .status,
        "creation_superseded",
      );
      assert.deepEqual(
        await request("/resource-create-state"),
        beforeSupersededRetry,
      );
      await request("/move", {
        id: "folder-replay-unread-fixture",
        folderId: "inbox",
        actor,
      });
      await request("/delete-folder", { folderId: "replay-folder", actor });
      await request("/delete-label", { id: "replay-label", actor });
      createState = await request("/resource-create-state");
      assert.deepEqual(originalOperationStates(), [
        "unavailable",
        "unavailable",
      ]);
      for (const [resource, entityId] of [
        ["folder", "replay-folder"],
        ["label", "replay-label"],
      ] as const) {
        assert.equal(
          createState.changes.filter(
            (change) =>
              change.resource === resource &&
              change.entityId === entityId &&
              change.operation === "deleted",
          ).length,
          1,
        );
      }
      assert.equal(
        createState.activities.filter(
          (event) =>
            event.action === "folder_deleted" &&
            event.entityId === "replay-folder",
        ).length,
        1,
      );
      assert.equal(
        createState.activities.filter(
          (event) =>
            event.action === "label_deleted" &&
            event.entityId === "replay-label",
        ).length,
        1,
      );
      const beforeUnavailableRetry = structuredClone(createState);
      assert.equal(
        (await request<{ status: string }>("/resource-create", folderCreate))
          .status,
        "creation_unavailable",
      );
      assert.equal(
        (await request<{ status: string }>("/resource-create", labelCreate))
          .status,
        "creation_unavailable",
      );
      assert.deepEqual(
        await request("/resource-create-state"),
        beforeUnavailableRetry,
      );

      const expiredRows = Array.from({ length: 101 }, (_, index) => ({
        operationKey: `old-${index}`.padEnd(64, "x"),
        resourceKind: "folder" as const,
        fingerprint: "9".repeat(64),
        resourceId: `expired-${index}`,
        state: "unavailable" as const,
        updatedAt: "2000-01-01T00:00:00.000Z",
      }));
      await request("/resource-create-operation-seed", [
        ...expiredRows,
        {
          operationKey: "z".repeat(64),
          resourceKind: "folder",
          fingerprint: "8".repeat(64),
          resourceId: "expired-exact-target",
          state: "superseded",
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
        {
          operationKey: "recent".padEnd(64, "r"),
          resourceKind: "folder",
          fingerprint: "7".repeat(64),
          resourceId: "recent-terminal",
          state: "unavailable",
          updatedAt: "2999-01-01T00:00:00.000Z",
        },
        {
          operationKey: "active-old".padEnd(64, "a"),
          resourceKind: "folder",
          fingerprint: "6".repeat(64),
          resourceId: "active-old",
          state: "active",
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
      ]);
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...folderCreate,
            operationKey: "z".repeat(64),
            fingerprint: "5".repeat(64),
            resourceId: "replay-expired-operation-reuse",
            name: "Expired operation reuse",
          })
        ).status,
        "created",
      );
      let retentionState = await request<{
        operations: Array<{ operationKey: string; state: string }>;
      }>("/resource-create-state");
      assert.equal(
        retentionState.operations.filter((operation) =>
          operation.operationKey.startsWith("old-"),
        ).length,
        2,
      );
      assert.equal(
        retentionState.operations.some(
          (operation) => operation.operationKey === "recent".padEnd(64, "r"),
        ),
        true,
      );
      assert.equal(
        retentionState.operations.some(
          (operation) =>
            operation.operationKey === "active-old".padEnd(64, "a") &&
            operation.state === "active",
        ),
        true,
      );
      assert.equal(
        retentionState.operations.some(
          (operation) =>
            operation.operationKey === "z".repeat(64) &&
            operation.state === "active",
        ),
        true,
      );
      assert.equal(
        (
          await request<{ status: string }>("/resource-create", {
            ...folderCreate,
            operationKey: "8".repeat(64),
            fingerprint: "4".repeat(64),
            resourceId: "replay-retention-second-pass",
            name: "Retention second pass",
          })
        ).status,
        "created",
      );
      retentionState = await request("/resource-create-state");
      assert.equal(
        retentionState.operations.filter((operation) =>
          operation.operationKey.startsWith("old-"),
        ).length,
        0,
      );

			const { labelId } = await request<{ labelId: string }>("/seed");
			const state = () => request<State>("/state");
			let before = await state();

			assert.deepEqual(
				await request("/conversation-archive", {
					conversationId: "thread-trash",
					folderId: "Sent",
					representativeEmailId: "trash-anchor",
					actor,
				}),
				{ status: "invalid_action", affectedCount: 0 },
			);
			assert.deepEqual(await state(), before);

			await request("/update-email", {
				id: "message-4",
				changes: { read: false, starred: false },
				actor,
			});
			assert.deepEqual(await state(), before);

			await request("/update-email", {
				id: "message-3",
				changes: { read: true, starred: true },
				actor,
			});
			let after = await state();
			assert.equal(after.emails.find((email) => email.id === "message-3")?.read, 1);
			assert.equal(after.emails.find((email) => email.id === "message-3")?.starred, 1);
			assert.deepEqual(
				after.activities.slice(-2).map((event) => event.metadataJson).sort(),
				[JSON.stringify({ read: true }), JSON.stringify({ starred: true })].sort(),
			);
			assert.equal(after.changes.length - before.changes.length, 1);
			before = after;

			await request("/update-email", {
				id: "message-3",
				changes: { read: true, starred: true },
				actor,
			});
			assert.deepEqual(await state(), before);

			const nullableConversation = await request<{
				status: string;
				affectedCount: number;
			}>("/conversation-read", {
				conversationId: "thread-null",
				folderId: "inbox",
				read: true,
				actor,
			});
			assert.deepEqual(nullableConversation, { status: "updated", affectedCount: 1 });
			after = await state();
			assert.equal(after.emails.find((email) => email.id === "message-4")?.read, 1);
			assert.equal(after.changes.length - before.changes.length, 1);
			before = after;

			const nullableBatch = await request<{
				results: Array<{ status: string; affectedCount: number }>;
			}>("/batch", {
				command: {
					action: "mark_read",
					targets: [{ emailId: "message-5", folderId: "inbox" }],
				},
				actor,
			});
			assert.deepEqual(nullableBatch.results, [
				{ status: "updated", affectedCount: 1, emailId: "message-5" },
			]);
			after = await state();
			assert.equal(after.emails.find((email) => email.id === "message-5")?.read, 1);
			assert.equal(after.changes.length - before.changes.length, 1);
			before = after;

			const conversation = await request<{
				status: string;
				affectedCount: number;
			}>("/conversation-read", {
				conversationId: "thread-1",
				folderId: "inbox",
				read: true,
				actor,
			});
			assert.deepEqual(conversation, { status: "updated", affectedCount: 1 });
			after = await state();
			assert.equal(after.changes.length - before.changes.length, 1);
			assert.deepEqual(JSON.parse(after.activities.at(-1)!.metadataJson), {
				folderId: "inbox",
				read: true,
				affectedCount: 1,
			});
			before = after;

			const conversationReplay = await request<{
				status: string;
				affectedCount: number;
			}>("/conversation-read", {
				conversationId: "thread-1",
				folderId: "inbox",
				read: true,
				actor,
			});
			assert.deepEqual(conversationReplay, { status: "updated", affectedCount: 0 });
			assert.deepEqual(await state(), before);

			const apply = (targets: Array<{
				emailId: string;
				folderId: string;
				conversationId?: string;
			}>) => request<{
				status: string;
				results: Array<{ affectedCount: number }>;
			}>("/mutate-labels", { labelId, action: "apply", targets, actor });
			assert.equal((await apply([{ emailId: "message-1", folderId: "inbox" }]))
				.results[0]?.affectedCount, 1);
			await request("/seed-active-outbound", { emailId: "message-1" });
			before = await state();
			assert.equal((await apply([{
				emailId: "message-1",
				folderId: "inbox",
				conversationId: "thread-1",
			}])).results[0]?.affectedCount, 1);
			after = await state();
			assert.equal(after.labels.length - before.labels.length, 1);
			assert.deepEqual(JSON.parse(after.activities.at(-1)!.metadataJson), {
				labelId,
				affectedCount: 1,
			});
			before = after;
			assert.equal((await apply([{
				emailId: "message-1",
				folderId: "inbox",
				conversationId: "thread-1",
			}])).results[0]?.affectedCount, 0);
			assert.deepEqual(await state(), before);

			const blockedRemove = await request<{
				results: Array<{ status: string; affectedCount: number }>;
			}>("/mutate-labels", {
				labelId,
				action: "remove",
				targets: [{ emailId: "message-1", folderId: "inbox" }],
				actor,
			});
			assert.deepEqual(blockedRemove.results, [{
				emailId: "message-1",
				status: "outbound_delivery_active",
				affectedCount: 0,
			}]);
			assert.deepEqual(await state(), before);

			const sameFolder = await request<{ result: boolean }>("/move", {
				id: "message-3",
				folderId: "inbox",
				actor,
			});
			assert.equal(sameFolder.result, true);
			assert.deepEqual(await state(), before);

			const batch = await request<{
				results: Array<{ status: string; affectedCount: number }>;
			}>("/batch", {
				command: {
					action: "mark_read",
					targets: [{
						emailId: "message-2",
						folderId: "inbox",
						conversationId: "thread-1",
					}],
				},
				actor,
			});
			assert.deepEqual(batch.results, [
				{ status: "updated", affectedCount: 0, emailId: "message-2" },
			]);
			assert.deepEqual(await state(), before);

			const archived = await request<{ status: string; affectedCount: number }>(
				"/conversation-archive",
				{
					conversationId: "thread-archive",
					folderId: "inbox",
					representativeEmailId: "archive-anchor",
					actor,
				},
			);
			assert.deepEqual(archived, { status: "archived", affectedCount: 2 });
			after = await state();
			assert.equal(
				after.emails.find((email) => email.id === "archive-anchor")?.folderId,
				"archive",
			);
			await request("/seed-archive-reply");
			await request("/seed-active-outbound", { emailId: "archive-anchor" });
			before = await state();

			const archiveReplay = await request<{ status: string; affectedCount: number }>(
				"/conversation-archive",
				{
					conversationId: "thread-archive",
					folderId: "inbox",
					representativeEmailId: "archive-anchor",
					actor,
				},
			);
			assert.deepEqual(archiveReplay, { status: "archived", affectedCount: 0 });
			after = await state();
			assert.equal(
				after.emails.find((email) => email.id === "archive-new-reply")?.folderId,
				"inbox",
			);
			assert.deepEqual(after, before);

			const trashed = await request<{ status: string; affectedCount: number }>(
				"/conversation-trash",
				{
					conversationId: "thread-trash",
					folderId: "sent",
					representativeEmailId: "trash-anchor",
					actor,
				},
			);
			assert.deepEqual(trashed, { status: "trashed", affectedCount: 2 });
			before = await state();
			assert.deepEqual(
				await request("/conversation-trash", {
					conversationId: "thread-trash",
					folderId: "sent",
					representativeEmailId: "trash-anchor",
					actor,
				}),
				{ status: "trashed", affectedCount: 0 },
			);
			assert.deepEqual(await state(), before);
			assert.deepEqual(
				await request("/conversation-trash", {
					conversationId: "thread-trash",
					folderId: "Trash",
					representativeEmailId: "trash-anchor",
					actor,
				}),
				{ status: "invalid_action", affectedCount: 0 },
			);
			assert.deepEqual(await state(), before);

			const batchArchive = {
				command: {
					action: "archive" as const,
					targets: [{ emailId: "batch-message", folderId: "inbox" }],
				},
				actor,
			};
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					batchArchive,
				)).results,
				[{ emailId: "batch-message", status: "updated", affectedCount: 1 }],
			);
			before = await state();
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					batchArchive,
				)).results,
				[{ emailId: "batch-message", status: "updated", affectedCount: 0 }],
			);
			assert.deepEqual(await state(), before);

			const batchTrash = {
				command: {
					action: "trash" as const,
					targets: [{
						emailId: "batch-trash-anchor",
						folderId: "inbox",
						conversationId: "thread-batch-trash",
					}],
				},
				actor,
			};
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					batchTrash,
				)).results,
				[{ emailId: "batch-trash-anchor", status: "updated", affectedCount: 2 }],
			);
			before = await state();
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					batchTrash,
				)).results,
				[{ emailId: "batch-trash-anchor", status: "updated", affectedCount: 0 }],
			);
			assert.deepEqual(await state(), before);

			const customArchive = {
				command: {
					action: "archive" as const,
					targets: [{ emailId: "custom-batch-message", folderId: "custom-retry" }],
				},
				actor,
			};
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					customArchive,
				)).results,
				[{ emailId: "custom-batch-message", status: "updated", affectedCount: 1 }],
			);
			await request("/delete-folder", { folderId: "custom-retry", actor });
			before = await state();
			assert.deepEqual(
				(await request<{ results: Array<{ status: string; affectedCount: number }> }>(
					"/batch",
					customArchive,
				)).results,
				[{ emailId: "custom-batch-message", status: "updated", affectedCount: 0 }],
			);
			assert.deepEqual(await state(), before);

			const labelFilteredRows = await request<Array<{
				id: string;
				conversationId: string;
				threadCount: number;
			}>>("/seed-label-filtered-batch");
			assert.deepEqual(labelFilteredRows, [
				{
					id: "label-trash-anchor",
					conversationId: "thread-label-trash",
					threadCount: 2,
				},
				{
					id: "label-archive-anchor",
					conversationId: "thread-label-archive",
					threadCount: 2,
				},
				{
					id: "label-mark-unread-anchor",
					conversationId: "thread-label-mark-unread",
					threadCount: 2,
				},
				{
					id: "label-mark-read-anchor",
					conversationId: "thread-label-mark-read",
					threadCount: 2,
				},
			]);
			for (const [action, expectedEmailId] of [
				["mark_read", "label-mark-read-anchor"],
				["mark_unread", "label-mark-unread-anchor"],
				["archive", "label-archive-anchor"],
				["trash", "label-trash-anchor"],
			] as const) {
				const target = labelFilteredRows.find((row) => row.id === expectedEmailId);
				assert.ok(target);
				const result = await request<{
					results: Array<{ emailId: string; status: string; affectedCount: number }>;
				}>("/batch", {
					command: {
						action,
						targets: [{
							emailId: target.id,
							folderId: "inbox",
							conversationId: target.conversationId,
						}],
					},
					actor,
				});
				assert.deepEqual(result.results, [{
					emailId: expectedEmailId,
					status: "updated",
					affectedCount: 2,
				}]);
			}
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
