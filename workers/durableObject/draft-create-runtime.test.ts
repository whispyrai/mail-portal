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

test(
	"MailboxDO serializes exact Draft creation retries in workerd",
	{ timeout: 30_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-draft-do-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/draft-do-integration-entry.ts",
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
				join(outputDirectory, "draft-do-integration-entry.js"),
				"utf8",
			);
			runtime = new Miniflare({
				log: new Log(LogLevel.ERROR),
				modules: true,
				script: bundle,
				compatibilityDate: "2026-07-14",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					MAILBOX: { className: "DraftTestMailboxDO", useSQLite: true },
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
					`http://draft.test${path}?mailbox=${encodeURIComponent(mailboxId)}`,
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
			const input = (
				id: string,
				fingerprint = "fingerprint-1",
				createKey = "tool-create-key-1",
			) => ({
				id,
				createKey,
				createFingerprint: fingerprint,
				subject: "Hello",
				sender: mailboxId,
				recipient: "person@example.com",
				cc: null,
				bcc: null,
				body: "<p>Body</p>",
				in_reply_to: null,
				thread_id: id,
			});
			const actor = { kind: "agent", id: "user-1" };
			type UpsertResult = {
				status: string;
				draftId: string;
				draft?: { draft_version: number; thread_id: string };
			};
			const [left, right] = await Promise.all([
				request<UpsertResult>("/upsert", {
					input: input("candidate-left"), actor,
				}),
				request<UpsertResult>("/upsert", {
					input: input("candidate-right"), actor,
				}),
			]);
			assert.deepEqual(
				[left.status, right.status].sort(),
				["creation_replay", "saved"],
			);
			const saved = left.status === "saved" ? left : right;
			const replay = left.status === "creation_replay" ? left : right;
			assert.equal(replay.draftId, saved.draftId);
			assert.equal(replay.draft?.draft_version, 1);
			assert.equal(replay.draft?.thread_id, saved.draftId);

			type State = {
				emails: Array<{ id: string; draftVersion: number; createKey: string }>;
				activities: Array<{ action: string; entityId: string }>;
				operations: Array<{
					createKey: string;
					draftId: string;
					draftVersion: number;
					state: string;
				}>;
			};
			let state = await request<State>("/state");
			assert.deepEqual(state.emails, [{
				id: saved.draftId,
				draftVersion: 1,
				createKey: "tool-create-key-1",
			}]);
			assert.deepEqual(state.activities, [{
				action: "draft_created",
				entityId: saved.draftId,
			}]);
			assert.deepEqual(state.operations, [{
				createKey: "tool-create-key-1",
				draftId: saved.draftId,
				draftVersion: 1,
				state: "active",
			}]);

			const conflict = await request<{ status: string; draftId: string }>(
				"/upsert",
				{ input: input("candidate-conflict", "fingerprint-2"), actor },
			);
			assert.equal(conflict.status, "creation_conflict");
			assert.equal(conflict.draftId, saved.draftId);
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
			assert.equal(state.activities.length, 1);

			const update = await request<{ status: string; draftVersion: number }>(
				"/upsert",
				{
					input: {
						...input(saved.draftId),
						createKey: undefined,
						createFingerprint: undefined,
						expectedVersion: 1,
						subject: "Edited",
					},
					actor: { kind: "user", id: "user-1" },
				},
			);
			assert.equal(update.status, "saved");
			assert.equal(update.draftVersion, 2);

			const superseded = await request<{
				status: string;
				draftId: string;
				currentVersion: number;
			}>("/upsert", { input: input("candidate-delayed"), actor });
			assert.equal(superseded.status, "creation_superseded");
			assert.equal(superseded.draftId, saved.draftId);
			assert.equal(superseded.currentVersion, 2);
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
			assert.deepEqual(state.activities.map((event) => event.action), [
				"draft_created",
				"draft_updated",
			]);

			for (const terminal of ["discard", "consume", "delete"] as const) {
				const createKey = `tool-create-key-${terminal}`;
				const created = await request<UpsertResult>("/upsert", {
					input: input(`candidate-${terminal}`, "terminal-fingerprint", createKey),
					actor,
				});
				assert.equal(created.status, "saved");
				const terminalResult = await request<{ status: string }>(`/${terminal}`, {
					draftId: created.draftId,
					...(terminal === "delete"
						? {}
						: {
								draftVersion: 1,
								actor: { kind: "user", id: "user-1" },
							}),
				});
				assert.equal(
					terminalResult.status,
					terminal === "discard"
						? "discarded"
						: terminal === "consume"
							? "consumed"
							: "deleted",
				);
				const delayed = await request<{
					status: string;
					draftId: string;
					reason: string;
				}>("/upsert", {
					input: input(`replacement-${terminal}`, "terminal-fingerprint", createKey),
					actor,
				});
				assert.equal(delayed.status, "creation_unavailable");
				assert.equal(delayed.draftId, created.draftId);
				assert.equal(
					delayed.reason,
					terminal === "discard"
						? "discarded"
						: terminal === "consume"
							? "consumed"
							: "deleted",
				);
			}
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
			assert.deepEqual(
				state.operations.map((operation) => [operation.createKey, operation.state]),
				[
					["tool-create-key-1", "active"],
					["tool-create-key-consume", "consumed"],
					["tool-create-key-delete", "deleted"],
					["tool-create-key-discard", "discarded"],
				],
			);
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
