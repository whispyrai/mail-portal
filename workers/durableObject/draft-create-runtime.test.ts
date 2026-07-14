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

				const claimDraft = await request<UpsertResult>("/upsert", {
					input: input("draft-save-claim", "claim-create", "claim-create-key"),
					actor,
				});
				assert.equal(claimDraft.status, "saved");
				const claimInput = (saveKey: string, claimToken = `token-${saveKey}`) => ({
					saveKey,
					fingerprint: `fingerprint-${saveKey}`,
					draftId: claimDraft.draftId,
					expectedVersion: 1,
					claimToken,
					claimExpiresAt: Date.now() + 300_000,
				});
				const [firstClaim, competingClaim] = await Promise.all([
					request<{ status: string }>("/claim-save", claimInput("save-1")),
					request<{ status: string }>("/claim-save", claimInput("save-2")),
				]);
				assert.deepEqual(
					[firstClaim.status, competingClaim.status].sort(),
					["claimed", "revision_in_progress"],
				);
				const winnerKey = firstClaim.status === "claimed" ? "save-1" : "save-2";
				const winner = claimInput(winnerKey);
				const recorded = await request<{ recorded: boolean }>(
					"/record-save-promotion",
					{
						saveKey: winner.saveKey,
						fingerprint: winner.fingerprint,
						claimToken: winner.claimToken,
						destinationKeys: ["attachments/draft-save-claim/attachment/file.pdf"],
					},
				);
				assert.equal(recorded.recorded, true);
				const claimCommit = await request<{ status: string; draftVersion: number }>(
					"/upsert",
					{
						input: {
							...input(claimDraft.draftId),
							createKey: undefined,
							createFingerprint: undefined,
							expectedVersion: 1,
							saveKey: winner.saveKey,
							saveFingerprint: winner.fingerprint,
							saveClaimToken: winner.claimToken,
							subject: "Claimed edit",
						},
						actor: { kind: "user", id: "user-1" },
					},
				);
				assert.equal(claimCommit.status, "saved");
				assert.equal(claimCommit.draftVersion, 2);
				assert.equal(
					(await request<{ status: string }>("/save-outcome", {
						saveKey: winner.saveKey,
						fingerprint: winner.fingerprint,
					})).status,
					"committed",
				);

				for (const terminal of ["discard", "consume", "delete"] as const) {
					const terminalDraft = await request<UpsertResult>("/upsert", {
						input: input(
							`save-terminal-${terminal}`,
							`save-terminal-create-${terminal}`,
							`save-terminal-create-key-${terminal}`,
						),
						actor,
					});
					assert.equal(terminalDraft.status, "saved");
					const terminalSave = {
						saveKey: `save-terminal-key-${terminal}`,
						fingerprint: `save-terminal-fingerprint-${terminal}`,
						draftId: terminalDraft.draftId,
						expectedVersion: 1,
						claimToken: `save-terminal-token-${terminal}`,
						claimExpiresAt: Date.now() + 300_000,
					};
					assert.equal(
						(await request<{ status: string }>("/claim-save", terminalSave)).status,
						"claimed",
					);
					const committed = await request<{ status: string; draftVersion: number }>(
						"/upsert",
						{
							input: {
								...input(terminalDraft.draftId),
								createKey: undefined,
								createFingerprint: undefined,
								expectedVersion: 1,
								saveKey: terminalSave.saveKey,
								saveFingerprint: terminalSave.fingerprint,
								saveClaimToken: terminalSave.claimToken,
							},
							actor: { kind: "user", id: "user-1" },
						},
					);
					assert.equal(committed.status, "saved");
					assert.equal(committed.draftVersion, 2);
					assert.equal(
						(await request<{ status: string }>(`/${terminal}`, {
							draftId: terminalDraft.draftId,
							...(terminal === "delete"
								? {}
								: {
										draftVersion: 2,
										actor: { kind: "user", id: "user-1" },
									}),
						})).status,
						terminal === "discard"
							? "discarded"
							: terminal === "consume"
								? "consumed"
								: "deleted",
					);
					const terminalReplay = await request<{ status: string; claimToken?: string }>(
						"/claim-save",
						{ ...terminalSave, claimToken: `late-${terminal}` },
					);
					assert.equal(terminalReplay.status, "committed");
					assert.equal(terminalReplay.claimToken, terminalSave.claimToken);
				}

				const expiredSaveKey = "save-expired-generation";
				const expiredFingerprint = `fingerprint-${expiredSaveKey}`;
				const oldClaim = {
					saveKey: expiredSaveKey,
					fingerprint: expiredFingerprint,
					draftId: claimDraft.draftId,
					expectedVersion: 2,
					claimToken: "claim-old",
					claimExpiresAt: Date.now() - 1,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", oldClaim)).status,
					"claimed",
				);
				const expiredDestinationKey =
					"attachments/draft-save-claim/expired-generation/file.pdf";
				assert.equal(
					(await request<{ recorded: boolean }>("/record-save-promotion", {
						saveKey: oldClaim.saveKey,
						fingerprint: oldClaim.fingerprint,
						claimToken: oldClaim.claimToken,
						destinationKeys: [expiredDestinationKey],
					})).recorded,
					true,
				);
				const replacementClaim = {
					...oldClaim,
					claimToken: "claim-new",
					claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", replacementClaim)).status,
					"claimed",
				);
				let cleanupState = await request<State & {
					cleanupIntents: Array<{ claimToken: string; attempts: number }>;
				}>("/state");
				assert.equal(
					cleanupState.cleanupIntents.some((intent) =>
						intent.claimToken === oldClaim.claimToken,
					),
					true,
				);
				await request("/make-cleanup-due", { claimToken: oldClaim.claimToken });
				await request("/run-alarm");
				await request("/put-owned-object", {
					key: expiredDestinationKey,
					promotionOwner: oldClaim.claimToken,
				});
				assert.equal(
					(await request<{ exists: boolean }>("/object-exists", {
						key: expiredDestinationKey,
					})).exists,
					true,
				);
				await request("/make-cleanup-due", { claimToken: oldClaim.claimToken });
				await request("/run-alarm");
				assert.equal(
					(await request<{ exists: boolean }>("/object-exists", {
						key: expiredDestinationKey,
					})).exists,
					false,
				);
				cleanupState = await request<State & {
					cleanupIntents: Array<{ claimToken: string; attempts: number }>;
				}>("/state");
				assert.equal(
					cleanupState.cleanupIntents.find((intent) =>
						intent.claimToken === oldClaim.claimToken,
					)?.attempts,
					2,
				);
				const staleCommit = await request<{ status: string }>("/upsert", {
					input: {
						...input(claimDraft.draftId),
						createKey: undefined,
						createFingerprint: undefined,
						expectedVersion: 2,
						saveKey: expiredSaveKey,
						saveFingerprint: expiredFingerprint,
						saveClaimToken: "claim-old",
					},
					actor: { kind: "user", id: "user-1" },
				});
				assert.equal(staleCommit.status, "save_claim_lost");

				const oldUpdatedAt = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
				const recentUpdatedAt = new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString();
				await request("/seed-save-operations", {
					count: 101,
					state: "committed",
					updatedAt: oldUpdatedAt,
					prefix: "expired-terminal",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: recentUpdatedAt,
					prefix: "recent-terminal",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "claimed",
					updatedAt: oldUpdatedAt,
					prefix: "active-claim",
				});
				await request("/claim-save", {
					saveKey: "retention-trigger-1",
					fingerprint: "retention-trigger-1",
					draftId: "retention-trigger-draft-1",
					expectedVersion: 0,
					claimToken: "retention-token-1",
					claimExpiresAt: Date.now() + 300_000,
				});
				state = await request<State & { saveOperations: Array<{ saveKey: string }> }>("/state");
				assert.equal(
					state.saveOperations.filter((operation) =>
						operation.saveKey.startsWith("expired-terminal-"),
					).length,
					1,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "recent-terminal-0"),
					true,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "active-claim-0"),
					true,
				);

				const retentionReference = Date.now();
				const retentionWindow = 30 * 24 * 60 * 60_000;
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow + 60_000).toISOString(),
					prefix: "inside-boundary",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow).toISOString(),
					prefix: "exact-boundary",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow - 60_000).toISOString(),
					prefix: "outside-boundary",
				});
				await request("/claim-save", {
					saveKey: "retention-trigger-2",
					fingerprint: "retention-trigger-2",
					draftId: "retention-trigger-draft-2",
					expectedVersion: 0,
					claimToken: "retention-token-2",
					claimExpiresAt: Date.now() + 300_000,
				});
				state = await request<State & { saveOperations: Array<{ saveKey: string }> }>("/state");
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "inside-boundary-0"),
					true,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "exact-boundary-0"),
					false,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "outside-boundary-0"),
					false,
				);
			} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
