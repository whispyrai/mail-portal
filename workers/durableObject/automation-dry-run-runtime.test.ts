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

test("MailboxDO selects one Automation dry-run winner and replays it after a later draft edit", { timeout: 30_000 }, async () => {
	const outputDirectory = await mkdtemp(join(tmpdir(), "mail-automation-dry-run-"));
	let runtime: Miniflare | undefined;
	try {
		await execFileAsync(join(ROOT, "node_modules/.bin/wrangler"), [
			"deploy",
			"workers/testing/automation-dry-run-integration-entry.ts",
			"--dry-run",
			"--outdir",
			outputDirectory,
			"--compatibility-date",
			"2026-07-15",
			"--compatibility-flag",
			"nodejs_compat",
			"--config",
			"wrangler.jsonc",
			"--env=",
			"--upload-source-maps=false",
		], {
			cwd: ROOT,
			env: { ...process.env, WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log") },
		});
		const bundle = await readFile(
			join(outputDirectory, "automation-dry-run-integration-entry.js"),
			"utf8",
		);
		runtime = new Miniflare({
			log: new Log(LogLevel.ERROR),
			modules: true,
			script: bundle,
			compatibilityDate: "2026-07-15",
			compatibilityFlags: ["nodejs_compat"],
			durableObjects: {
				MAILBOX: { className: "AutomationDryRunTestMailboxDO", useSQLite: true },
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
				`http://automation.test${path}?mailbox=${encodeURIComponent(mailboxId)}`,
				body === undefined ? undefined : {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			const text = await response.text();
			assert.equal(response.status, 200, text);
			return JSON.parse(text) as T;
		};
		const definition = {
			schemaVersion: 1,
			name: "Invoices",
			match: "all",
			conditions: [{ kind: "every_incoming" }],
			actions: [{ kind: "star" }],
			stopProcessing: false,
		};
		const created = await request<{ rule: { id: string; revision: number; draftVersion: number } }>(
			"/create",
			{ definition, actorId: "user-1", expectedOrderRevision: 0 },
		);
		const command = {
			testId: `test_operation_${"a".repeat(64)}`,
			definition,
			actorId: "user-1",
			ruleId: created.rule.id,
			ruleVersion: created.rule.draftVersion,
			acknowledgedZero: true,
		};
		const [left, right] = await Promise.all([
			request<{ id: string; replayed: boolean }>("/dry-run", command),
			request<{ id: string; replayed: boolean }>("/dry-run", command),
		]);
		assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
		assert.equal(left.id, right.id);
		assert.deepEqual(await request("/state"), {
			tests: [{ id: command.testId, actorId: "user-1", ruleVersion: 1 }],
		});

		await request("/update", {
			ruleId: created.rule.id,
			definition: { ...definition, name: "Edited invoices" },
			actorId: "user-2",
			expectedRevision: created.rule.revision,
		});
		const delayed = await request<{ id: string; replayed: boolean }>("/dry-run", command);
		assert.equal(delayed.replayed, true);
		assert.equal(delayed.id, command.testId);
	} finally {
		await runtime?.dispose();
		await rm(outputDirectory, { recursive: true, force: true });
	}
});
