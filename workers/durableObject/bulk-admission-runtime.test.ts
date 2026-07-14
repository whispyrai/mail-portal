import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import {
	bulkAdmissionFingerprint,
	BULK_LIMITS,
} from "../lib/bulk-job-admission.ts";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

const FLAKY_R2_WRAPPER = `
export default function(env) {
  return {
    async get(key, options) {
      if (key.startsWith("bulk-attachments/") && await env.CONTROL.get("fail-get") === "1") {
        const failures = Number(await env.CONTROL.get("get-failures") || "0") + 1;
        await env.CONTROL.put("get-failures", String(failures));
        throw new Error("injected transient R2 get failure");
      }
      return env.INNER.get(key, options);
    },
    put: (key, value, options) => env.INNER.put(key, value, options),
    head: (key) => env.INNER.head(key),
    delete: (keys) => env.INNER.delete(keys),
    list: (options) => env.INNER.list(options),
    createMultipartUpload: (key, options) => env.INNER.createMultipartUpload(key, options),
    resumeMultipartUpload: (key, uploadId) => env.INNER.resumeMultipartUpload(key, uploadId),
  };
}
`;

type JsonRecord = Record<string, unknown>;

async function waitFor<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for state: ${JSON.stringify(value)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		value = await read();
	}
	return value;
}

test(
	"MailboxDO executes bulk reservation, admission, retry, cleanup, and pruning in workerd",
	{ timeout: 30_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-bulk-do-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/bulk-do-integration-entry.ts",
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
				join(outputDirectory, "bulk-do-integration-entry.js"),
				"utf8",
			);
			runtime = new Miniflare({
				log: new Log(LogLevel.ERROR),
				workers: [
					{
						name: "main",
						modules: true,
						script: bundle,
						compatibilityDate: "2026-07-14",
						compatibilityFlags: ["nodejs_compat"],
						durableObjects: {
							MAILBOX: {
								className: "BulkTestMailboxDO",
								useSQLite: true,
							},
						},
						wrappedBindings: { BUCKET: "flaky-r2" },
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
					},
					{
						name: "flaky-r2",
						modules: true,
						r2Buckets: { INNER: "bulk-runtime" },
						kvNamespaces: { CONTROL: "bulk-runtime-control" },
						script: FLAKY_R2_WRAPPER,
					},
				],
			});

			const database = await runtime.getD1Database("DB", "main");
			await database
				.prepare(
					"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, role TEXT NOT NULL DEFAULT 'AGENT', is_active INTEGER NOT NULL DEFAULT 1, mailbox_address TEXT NOT NULL UNIQUE, mcp_token_hash TEXT, recovery_email TEXT, ownership_confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
				)
				.run();
			await database
				.prepare(
					"CREATE TABLE mailboxes (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, type TEXT NOT NULL, owner_user_id TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
				)
				.run();
			await database
				.prepare(
					"CREATE TABLE mailbox_memberships (mailbox_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (mailbox_id, user_id))",
				)
				.run();

			async function seedMailbox(index: number) {
				const actorUserId = `user-${index}`;
				const mailboxId = `team-${index}@example.com`;
				const now = Date.now();
				await database
					.prepare(
						"INSERT INTO users (id,email,password_hash,password_salt,role,is_active,mailbox_address,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
					)
					.bind(
						actorUserId,
						actorUserId + "@example.com",
						"hash",
						"salt",
						"AGENT",
						1,
						mailboxId,
						now,
						now,
					)
					.run();
				await database
					.prepare(
						"INSERT INTO mailboxes (id,address,type,owner_user_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
					)
					.bind(mailboxId, mailboxId, "PERSONAL", actorUserId, 1, now, now)
					.run();
				return { actorUserId, mailboxId };
			}

			async function rpc<T>(
				mailboxId: string,
				path: string,
				body: unknown,
			): Promise<T> {
				const response = await runtime!.dispatchFetch(
					`http://bulk.test${path}?mailbox=${encodeURIComponent(mailboxId)}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				const responseBody = await response.text();
				assert.equal(response.status, 200, responseBody);
				return JSON.parse(responseBody) as T;
			}

			async function submission(
				actorUserId: string,
				mailboxId: string,
				attachmentUploadIds: string[] = [],
			) {
				const operationId = crypto.randomUUID();
				const recipients = [{ email: "recipient@example.com", company: "Acme" }];
				const subject = "Hello {{company}}";
				const text = "A reliable bulk message";
				const fingerprint = await bulkAdmissionFingerprint({
					actorUserId,
					subject,
					text,
					recipients,
					attachmentUploadIds,
				});
				return {
					reservation: {
						operationId,
						actorUserId,
						fingerprint,
						total: recipients.length,
					},
					enqueue: {
						operationId,
						actorUserId,
						fromEmail: mailboxId,
						fromName: "Team",
						subject,
						text,
						recipients,
						attachmentUploadIds,
					},
				};
			}

			const cancelledMailbox = await seedMailbox(1);
			const cancelled = await submission(
				cancelledMailbox.actorUserId,
				cancelledMailbox.mailboxId,
			);
			assert.equal(
				(
					await rpc<JsonRecord>(
						cancelledMailbox.mailboxId,
						"/reserve",
						cancelled.reservation,
					)
				).status,
				"reserved",
			);
			assert.equal(
				(
					await rpc<JsonRecord>(cancelledMailbox.mailboxId, "/cancel", {
						operationId: cancelled.enqueue.operationId,
						actorUserId: cancelledMailbox.actorUserId,
					})
				).status,
				"cancelled",
			);
			assert.equal(
				await rpc(cancelledMailbox.mailboxId, "/recover", {
					operationId: cancelled.enqueue.operationId,
					actorUserId: cancelledMailbox.actorUserId,
				}),
				null,
			);

			const replayMailbox = await seedMailbox(2);
			const replay = await submission(
				replayMailbox.actorUserId,
				replayMailbox.mailboxId,
			);
			await rpc(replayMailbox.mailboxId, "/reserve", replay.reservation);
			const first = await rpc<JsonRecord>(
				replayMailbox.mailboxId,
				"/enqueue",
				replay.enqueue,
			);
			const repeated = await rpc<JsonRecord>(
				replayMailbox.mailboxId,
				"/enqueue",
				replay.enqueue,
			);
			assert.equal(first.status, "accepted");
			assert.equal(repeated.status, "accepted");
			assert.equal(repeated.jobId, first.jobId);
			assert.equal(repeated.replayed, true);

			const raceMailbox = await seedMailbox(3);
			const race = await submission(
				raceMailbox.actorUserId,
				raceMailbox.mailboxId,
			);
			await rpc(raceMailbox.mailboxId, "/reserve", race.reservation);
			const [racedAdmission, racedCancellation] = await Promise.all([
				rpc<JsonRecord>(raceMailbox.mailboxId, "/enqueue", race.enqueue),
				rpc<JsonRecord>(raceMailbox.mailboxId, "/cancel", {
					operationId: race.enqueue.operationId,
					actorUserId: raceMailbox.actorUserId,
				}),
			]);
			if (racedAdmission.status === "accepted") {
				assert.equal(racedCancellation.status, "admitted");
				assert.equal(racedCancellation.jobId, racedAdmission.jobId);
			} else {
				assert.equal(racedAdmission.status, "rejected");
				assert.equal(racedAdmission.code, "bulk_reservation_expired");
				assert.equal(racedCancellation.status, "cancelled");
			}

			const invalidHtmlMailbox = await seedMailbox(7);
			const invalidHtmlBase = await submission(
				invalidHtmlMailbox.actorUserId,
				invalidHtmlMailbox.mailboxId,
			);
			const invalidHtmlEnqueue = {
				...invalidHtmlBase.enqueue,
				html: '<img src="{{image_url}}">',
				recipients: [
					{
						email: "recipient@example.com",
						company: "Acme",
						image_url: "cid:missing@mail-portal.local",
					},
				],
			};
			const invalidHtmlFingerprint = await bulkAdmissionFingerprint({
				actorUserId: invalidHtmlEnqueue.actorUserId,
				subject: invalidHtmlEnqueue.subject,
				html: invalidHtmlEnqueue.html,
				text: invalidHtmlEnqueue.text,
				recipients: invalidHtmlEnqueue.recipients,
				attachmentUploadIds: invalidHtmlEnqueue.attachmentUploadIds,
			});
			await rpc(invalidHtmlMailbox.mailboxId, "/reserve", {
				...invalidHtmlBase.reservation,
				fingerprint: invalidHtmlFingerprint,
			});
			const invalidHtmlResult = await rpc<JsonRecord>(
				invalidHtmlMailbox.mailboxId,
				"/enqueue",
				invalidHtmlEnqueue,
			);
			assert.equal(invalidHtmlResult.status, "rejected");
			assert.equal(invalidHtmlResult.code, "invalid_bulk_request");
			assert.equal(
				invalidHtmlResult.error,
				"An inline image in the message is missing its attachment (missing@mail-portal.local).",
			);
			assert.deepEqual(
				await rpc<unknown[]>(invalidHtmlMailbox.mailboxId, "/storage/list", {
					prefix: "bulk:admission:",
				}),
				[],
			);

			const runtimeMailbox = await seedMailbox(4);
			const uploadId = crypto.randomUUID();
			const innerBucket = await runtime.getR2Bucket("INNER", "flaky-r2");
			await innerBucket.put(
				`uploads/${runtimeMailbox.mailboxId}/${uploadId}`,
				new TextEncoder().encode("attachment bytes"),
				{
					httpMetadata: { contentType: "text/plain" },
					customMetadata: { filename: "brief.txt", type: "text/plain" },
				},
			);
			const runtimeSubmission = await submission(
				runtimeMailbox.actorUserId,
				runtimeMailbox.mailboxId,
				[uploadId],
			);
			await rpc(
				runtimeMailbox.mailboxId,
				"/reserve",
				runtimeSubmission.reservation,
			);
			const admitted = await rpc<JsonRecord>(
				runtimeMailbox.mailboxId,
				"/enqueue",
				runtimeSubmission.enqueue,
			);
			assert.equal(admitted.status, "accepted");
			const jobId = String(admitted.jobId);
			const control = await runtime.getKVNamespace("CONTROL", "flaky-r2");
			await control.put("fail-get", "1");
			await rpc(runtimeMailbox.mailboxId, "/alarm", {});
			await waitFor(
				() => control.get("get-failures"),
				(value) => Number(value ?? 0) >= 1,
			);
			const retryingJob = await rpc<JsonRecord>(
				runtimeMailbox.mailboxId,
				"/job",
				{ jobId },
			);
			assert.equal(retryingJob.cursor, 0);
			assert.equal(retryingJob.enqueued, 0);
			assert.equal(retryingJob.failed, 0);
			assert.ok(
				await innerBucket.head(`bulk-attachments/${jobId}/generation-1/0`),
			);
			await control.delete("fail-get");
			await rpc(runtimeMailbox.mailboxId, "/alarm", {});
			const completedJob = await waitFor(
				() =>
					rpc<JsonRecord>(runtimeMailbox.mailboxId, "/job", {
						jobId,
					}),
				(value) => value.status === "done",
			);
			assert.equal(completedJob.enqueued, 1);
			assert.equal(completedJob.failed, 0);
			const recipientObjects = await innerBucket.list({ prefix: "attachments/" });
			assert.equal(recipientObjects.objects.length, 1);

			const cleanupMailbox = await seedMailbox(5);
			const cleanupKey = "bulk-runtime/orphan";
			await innerBucket.put(cleanupKey, "orphan");
			await rpc(cleanupMailbox.mailboxId, "/storage/write", {
				key: "bulk:attachment-cleanup:expired-lease",
				value: {
					id: "expired-lease",
					ownerId: "runtime-test",
					keys: [cleanupKey],
					dueAt: Date.now() - 10_000,
					leaseToken: "stale-token",
					leaseExpiresAt: Date.now() - 1,
					attempts: 1,
					createdAt: Date.now() - 20_000,
				},
			});
			await rpc(cleanupMailbox.mailboxId, "/alarm", {});
			await waitFor(
				() =>
					rpc<unknown[]>(cleanupMailbox.mailboxId, "/storage/list", {
						prefix: "bulk:attachment-cleanup:",
					}),
				(entries) => entries.length === 0,
			);
			assert.equal(await innerBucket.head(cleanupKey), null);

			const pruneMailbox = await seedMailbox(6);
			const terminalOperationId = crypto.randomUUID();
			const terminalJobId = `job_${crypto.randomUUID()}`;
			const admissionKey = `bulk:admission:${terminalOperationId}`;
			await rpc(pruneMailbox.mailboxId, "/storage/write", {
				key: `bulk:job:${terminalJobId}`,
				value: { id: terminalJobId, status: "done" },
			});
			await rpc(pruneMailbox.mailboxId, "/storage/write", {
				key: `bulk:rows:${terminalJobId}`,
				value: [{ email: "expired@example.com" }],
			});
			await rpc(pruneMailbox.mailboxId, "/storage/write", {
				key: admissionKey,
				value: { operationId: terminalOperationId, jobId: terminalJobId },
			});
			await rpc(pruneMailbox.mailboxId, "/storage/write", {
				key: "bulk:terminal-history",
				value: [
					{
						jobId: terminalJobId,
						admissionKey,
						completedAt:
							Date.now() - BULK_LIMITS.terminalRetentionMs - 1_000,
					},
				],
			});
			await rpc(pruneMailbox.mailboxId, "/alarm", {});
			await waitFor(
				() =>
					rpc<unknown[]>(pruneMailbox.mailboxId, "/storage/list", {
						prefix: "bulk:",
					}),
				(entries) =>
					!entries.some(
						(entry) =>
							Array.isArray(entry) &&
							(typeof entry[0] === "string" &&
								(entry[0] === `bulk:job:${terminalJobId}` ||
									entry[0] === `bulk:rows:${terminalJobId}` ||
									entry[0] === admissionKey)),
					),
			);
			const terminalHistory = await rpc<unknown[]>(
				pruneMailbox.mailboxId,
				"/storage/read",
				{ key: "bulk:terminal-history" },
			);
			assert.deepEqual(terminalHistory, []);
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
