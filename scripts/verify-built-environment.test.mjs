import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyBuiltEnvironment } from "./verify-built-environment.mjs";

const identities = {
	whispyr: {
		name: "sales-mail-portal",
		domain: "whispyrcrm.com",
		features: ["quiz"],
		databaseName: "sales_portal_users",
		databaseId: "f322fd13-dc49-4390-888c-ff862ca05882",
		bucket: "sales-mail-portal",
		previewBucket: "sales-mail-portal-preview",
		rawBucket: "sales-mail-raw-archive",
		rawPreviewBucket: "sales-mail-raw-archive-preview",
		queue: "sales-mail-inbound",
		dlq: "sales-mail-inbound-dlq",
		parking: "sales-mail-inbound-parking",
		kvId: "cd541026bdf949d9ac63b3b5fdff4969",
		route: "mail.whispyrcrm.com",
	},
	wiser: {
		name: "wiser-mail-portal",
		domain: "wiserchat.ai",
		features: [],
		databaseName: "wiser_mail_portal_users",
		databaseId: "87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
		bucket: "wiser-mail-portal",
		previewBucket: "wiser-mail-portal-preview",
		rawBucket: "wiser-mail-raw-archive",
		rawPreviewBucket: "wiser-mail-raw-archive-preview",
		queue: "wiser-mail-inbound",
		dlq: "wiser-mail-inbound-dlq",
		parking: "wiser-mail-inbound-parking",
		kvId: "c934d803c2f8430d9088f4a5d9f29d55",
		route: "mail.wiserchat.ai",
	},
};

function validArtifact(brand) {
	const identity = identities[brand];
	return {
		name: identity.name,
		vars: {
			BRAND: brand,
			DOMAINS: identity.domain,
			FEATURES: identity.features,
			INBOUND_QUEUE_NAME: identity.queue,
			INBOUND_DLQ_NAME: identity.dlq,
			INBOUND_PARKING_NAME: identity.parking,
		},
		secrets: {
			required: [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"SES_EVENT_WEBHOOK_SECRET",
				"JWT_SECRET",
				"ADMIN_BOOTSTRAP_EMAIL",
				"ACCOUNT_RECOVERY_DIRECTORY",
				"EMERGENCY_FORWARD_TO",
				"VAPID_PUBLIC_KEY",
				"VAPID_PRIVATE_KEY",
			],
		},
		routes: [{ pattern: identity.route, custom_domain: true }],
		d1_databases: [
			{
				binding: "DB",
				database_name: identity.databaseName,
				database_id: identity.databaseId,
				migrations_dir: "migrations",
			},
		],
		r2_buckets: [
			{
				binding: "BUCKET",
				bucket_name: identity.bucket,
				preview_bucket_name: identity.previewBucket,
			},
			{
				binding: "RAW_MAIL_BUCKET",
				bucket_name: identity.rawBucket,
				preview_bucket_name: identity.rawPreviewBucket,
			},
		],
		queues: {
			producers: [{ binding: "INBOUND_QUEUE", queue: identity.queue }],
			consumers: [
				{
					queue: identity.queue,
					max_batch_size: 1,
					max_concurrency: 1,
					max_batch_timeout: 5,
					max_retries: 10,
					retry_delay: 1,
					dead_letter_queue: identity.dlq,
				},
				{
					queue: identity.dlq,
					max_batch_size: 1,
					max_concurrency: 1,
					max_batch_timeout: 5,
					max_retries: 10,
					retry_delay: 60,
					dead_letter_queue: identity.parking,
				},
				{
					queue: identity.parking,
					max_batch_size: 1,
					max_concurrency: 1,
					max_batch_timeout: 5,
					max_retries: 100,
					retry_delay: 3600,
				},
			],
		},
		triggers: { crons: ["* * * * *", "*/5 * * * *", "17 * * * *"] },
		kv_namespaces: [{ binding: "OAUTH_KV", id: identity.kvId }],
		ai: { binding: "AI" },
		durable_objects: {
			bindings: [
				{ name: "MAILBOX", class_name: "MailboxDO" },
				{ name: "EMAIL_AGENT", class_name: "EmailAgent" },
				{ name: "EMAIL_MCP", class_name: "EmailMCP" },
			],
		},
		workflows: [],
		services: [],
		vectorize: [],
		logfwdr: { bindings: [] },
	};
}

async function runFixture(brand, mutate = () => {}) {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-env-verifier-"));
	const artifactPath = join(directory, "wrangler.json");
	const logFilePath = join(directory, "verifier.log");
	const artifact = validArtifact(brand);
	mutate(artifact);
	await writeFile(artifactPath, JSON.stringify(artifact), "utf8");
	const terminal = [];
	const errors = [];
	const invocation = () =>
		verifyBuiltEnvironment({
			brand,
			artifactPath,
			logFilePath,
			stdout: (message) => terminal.push(message),
			stderr: (message) => errors.push(message),
		});
	return { directory, errors, invocation, logFilePath, terminal };
}

test("accepts the exact Whispyr and Wiser deployment topologies", async () => {
	for (const brand of ["whispyr", "wiser"]) {
		const fixture = await runFixture(brand);
		await fixture.invocation();
		assert.match(fixture.terminal.at(-1), /isolated and valid/);
		assert.deepEqual(fixture.errors, []);
	}
});

test("rejects a wrong Wiser mail domain", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.vars.DOMAINS = "staging.wiserchat.ai";
	});
	await assert.rejects(fixture.invocation, /DOMAINS/);
});

test("rejects a missing required secret", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.secrets.required = artifact.secrets.required.filter(
			(name) => name !== "SES_EVENT_WEBHOOK_SECRET",
		);
	});
	await assert.rejects(fixture.invocation, /required secrets/);
});

test("rejects an attachment preview bucket that aliases production", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.r2_buckets[0].preview_bucket_name =
			artifact.r2_buckets[0].bucket_name;
	});
	await assert.rejects(
		fixture.invocation,
		/attachment R2 preview bucket must be isolated from production/,
	);
});

test("rejects a missing Queue edge", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		delete artifact.queues.consumers[1].dead_letter_queue;
	});
	await assert.rejects(fixture.invocation, /Queue graph and consumer settings/);
});

test("rejects a wrong Cron schedule", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.triggers.crons[1] = "*/10 * * * *";
	});
	await assert.rejects(fixture.invocation, /Cron schedules/);
});

test("rejects an extra custom-domain route", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.routes.push({ pattern: "test.wiserchat.ai", custom_domain: true });
	});
	await assert.rejects(fixture.invocation, /custom-domain routes/);
});

test("rejects an extra platform resource", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.services.push({ binding: "OTHER", service: "other-worker" });
	});
	await assert.rejects(fixture.invocation, /services resources/);
});

test("rejects an extra singleton platform binding", async () => {
	const fixture = await runFixture("wiser", (artifact) => {
		artifact.browser = { binding: "BROWSER" };
	});
	await assert.rejects(fixture.invocation, /browser resource/);
});

test("rejects cross-brand and forbidden test-domain leakage", async () => {
	for (const leakedIdentifier of [
		"sales-mail-inbound",
		"sales-mail-portal-preview",
		"test.wiserchat.ai",
	]) {
		const fixture = await runFixture("wiser", (artifact) => {
			artifact.metadata = leakedIdentifier;
		});
		await assert.rejects(fixture.invocation, /leaked forbidden identifier/);
	}
});

test("rejects an invalid brand before reading an artifact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-env-verifier-"));
	await assert.rejects(
		() =>
			verifyBuiltEnvironment({
				brand: "unknown",
				artifactPath: join(directory, "missing.json"),
				logFilePath: join(directory, "invalid.log"),
				stdout: () => {},
				stderr: () => {},
			}),
		/brand must be one of: whispyr, wiser/,
	);
});

test("creates a detailed log for successful and failed runs", async () => {
	const successful = await runFixture("whispyr");
	await successful.invocation();
	assert.match(await readFile(successful.logFilePath, "utf8"), /Phase 4\/4/);

	const failed = await runFixture("wiser", (artifact) => {
		artifact.vars.INBOUND_QUEUE_NAME = "wrong-queue";
	});
	await assert.rejects(failed.invocation);
	const failedLog = await readFile(failed.logFilePath, "utf8");
	assert.match(failedLog, /INBOUND_QUEUE_NAME/);
	assert.match(failedLog, /FAILED:/);
});
