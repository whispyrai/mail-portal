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
			const request = async <T>(path: string, body?: unknown): Promise<T> => {
				const response = await runtime!.dispatchFetch(
					`http://mutation.test${path}?mailbox=${encodeURIComponent(mailboxId)}`,
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
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
