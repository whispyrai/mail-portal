import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	APPLY_CONFIRMATION,
	BRAND_CANARY_CONFIG,
	buildRoutingRule,
	buildSesV2Request,
	buildWranglerCanaryConfig,
	canonicalRoutingSnapshot,
	parseCanaryArguments,
	runEmailAuthorizationCanary,
} from "./run-email-authorization-canary.mjs";

const execFileAsync = promisify(execFile);
const SUFFIX = "0123456789abcdef";

function createLogger() {
	const progress = [];
	const detail = [];
	const failure = [];
	return {
		logFilePath: "/private/canary.log",
		progress,
		detail,
		failure,
		async progress(message) {
			progress.push(message);
		},
		async detail(message) {
			detail.push(message);
		},
		async failure(message) {
			failure.push(message);
		},
	};
}

function baselineSnapshot(brand) {
	return {
		rules: [
			{
				id: `${brand}-catch-exception`,
				actions: [{ type: "worker", value: [`${brand}-mail-portal`] }],
				enabled: true,
				matchers: [
					{ type: "literal", field: "to", value: `known@${BRAND_CANARY_CONFIG[brand].domain}` },
				],
				name: "Known recipient",
				priority: 0,
				source: "api",
			},
		],
		catchAll: {
			id: `${brand}-catch-all`,
			actions: [{ type: "worker", value: [`${brand}-mail-portal`] }],
			enabled: true,
			matchers: [{ type: "all" }],
			name: "Catch all",
			source: "api",
		},
	};
}

function createDependencies({ failProbe } = {}) {
	const calls = [];
	const snapshots = new Map(
		Object.keys(BRAND_CANARY_CONFIG).map((brand) => [
			brand,
			baselineSnapshot(brand),
		]),
	);
	const dependencies = {
		calls,
		async inventoryBrand(brand) {
			calls.push(`inventory:${brand}`);
			return {
				routing: snapshots.get(brand),
				routingReady: true,
				ruleCount: 1,
				destinationVerified: true,
				workerAbsent: true,
				namespaceAbsent: true,
				workersSubdomain: "example-subdomain",
			};
		},
		async createKvNamespace(brand) {
			calls.push(`kv:create:${brand}`);
			return `${brand}-kv-id`;
		},
		async deployWorker(brand, deployment) {
			calls.push(`worker:deploy:${brand}`);
			assert.equal(
				deployment.config.kv_namespaces[0].id,
				`${brand}-kv-id`,
			);
		},
		async checkHealth(brand) {
			calls.push(`health:${brand}`);
		},
		async createRoutingRule(brand, rule) {
			calls.push(`rule:create:${brand}`);
			assert.equal(rule.enabled, false);
			return { ...rule, id: `${brand}-canary-rule` };
		},
		async setRoutingRuleEnabled(brand, rule, enabled) {
			calls.push(`rule:${enabled ? "enable" : "disable"}:${brand}`);
			return { ...rule, enabled };
		},
		async deleteRoutingRule(brand) {
			calls.push(`rule:delete:${brand}`);
		},
		async injectWithSes(brand, probe) {
			calls.push(`ses:${brand}:${probe.probeId}`);
			if (probe.probeId === failProbe) throw new Error("ambiguous SES result");
			return { messageId: `ses-${probe.probeId}` };
		},
		async awaitForwardResult(brand, probe) {
			calls.push(`forward:proof:${brand}:${probe.probeId}`);
			return {
				status: "accepted",
				probeId: probe.probeId,
				rawBytes: probe.rawBytes,
				messageId: `forward-${probe.probeId}`,
				observedRawBytes: probe.rawBytes + 8_192,
			};
		},
		async sendWithBinding(brand, probe) {
			calls.push(`binding:${brand}:${probe.probeId}`);
			return {
				status: "accepted",
				probeId: probe.probeId,
				rawBytes: probe.rawBytes,
				messageId: `binding-${probe.probeId}`,
			};
		},
		async deleteWorker(brand) {
			calls.push(`worker:delete:${brand}`);
		},
		async deleteKvNamespace(brand) {
			calls.push(`kv:delete:${brand}`);
		},
		async readRoutingSnapshot(brand) {
			calls.push(`snapshot:${brand}`);
			return snapshots.get(brand);
		},
	};
	return dependencies;
}

test("arguments are preflight by default and require the exact apply phrase", () => {
	assert.deepEqual(parseCanaryArguments([]), { apply: false });
	assert.deepEqual(
		parseCanaryArguments(["--apply", "--confirm", APPLY_CONFIRMATION]),
		{ apply: true },
	);
	for (const argv of [
		["--apply"],
		["--apply", "--confirm", "yes"],
		["--confirm", APPLY_CONFIRMATION],
	]) {
		assert.throws(() => parseCanaryArguments(argv), /exact production approval/u);
	}
});

test("the temporary Worker config is isolated, exact-address-bound, and contains no auth secret", () => {
	const config = buildWranglerCanaryConfig({
		brand: "wiser",
		destination: "verified@example.com",
		kvNamespaceId: "0123456789abcdef0123456789abcdef",
		mainPath: "/repo/scripts/email-authorization-canary-worker.ts",
		suffix: SUFFIX,
	});
	assert.equal(config.name, `mail-auth-canary-wiser-${SUFFIX}`);
	assert.equal(config.main, "/repo/scripts/email-authorization-canary-worker.ts");
	assert.deepEqual(config.kv_namespaces, [
		{
			binding: "CANARY_STATE",
			id: "0123456789abcdef0123456789abcdef",
		},
	]);
	assert.deepEqual(config.send_email, [
		{
			name: "EMAIL",
			destination_address: "verified@example.com",
			allowed_sender_addresses: ["emergency-forward@wiserchat.ai"],
		},
	]);
	assert.equal(config.vars.CANARY_RECIPIENT, `mail-auth-canary-${SUFFIX}@wiserchat.ai`);
	assert.equal(config.vars.CANARY_RUN_ID, `canary-wiser-${SUFFIX}`);
	assert.equal(JSON.stringify(config).includes("AUTH_TOKEN"), false);
});

test("Wrangler bundles the exact temporary Worker config without network access", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "mail-auth-canary-bundle-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const configPath = join(directory, "wrangler.json");
	const outputPath = join(directory, "output");
	const config = buildWranglerCanaryConfig({
		brand: "wiser",
		destination: "verified@example.com",
		kvNamespaceId: "0123456789abcdef0123456789abcdef",
		mainPath: resolve("scripts/email-authorization-canary-worker.ts"),
		suffix: SUFFIX,
	});
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	const environment = Object.fromEntries(
		["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "TZ"]
			.filter((name) => process.env[name])
			.map((name) => [name, process.env[name]]),
	);
	await execFileAsync(
		resolve("node_modules/.bin/wrangler"),
		["deploy", "--dry-run", "--config", configPath, "--outdir", outputPath],
		{
			cwd: process.cwd(),
			env: {
				...environment,
				CLOUDFLARE_CF_FETCH_ENABLED: "false",
				CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
				WRANGLER_SEND_ERROR_REPORTS: "false",
				WRANGLER_SEND_METRICS: "false",
			},
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		},
	);
});

test("routing rule starts disabled and targets only the temporary Worker", () => {
	assert.deepEqual(buildRoutingRule({ brand: "wiser", suffix: SUFFIX }), {
		actions: [
			{
				type: "worker",
				value: [`mail-auth-canary-wiser-${SUFFIX}`],
			},
		],
		enabled: false,
		matchers: [
			{
				type: "literal",
				field: "to",
				value: `mail-auth-canary-${SUFFIX}@wiserchat.ai`,
			},
		],
		name: `Temporary mail authorization canary wiser ${SUFFIX}`,
		priority: 0,
		source: "api",
	});
});

test("SES v2 request carries the exact raw MIME bytes once", () => {
	const raw = Buffer.from("From: sender@example.com\r\n\r\nbody", "ascii");
	const request = buildSesV2Request({
		from: "sender@example.com",
		to: "recipient@example.com",
		raw,
	});
	assert.deepEqual(request, {
		Content: { Raw: { Data: raw.toString("base64") } },
		Destination: { ToAddresses: ["recipient@example.com"] },
		FromEmailAddress: "sender@example.com",
	});
	assert.deepEqual(
		Buffer.from(request.Content.Raw.Data, "base64"),
		raw,
	);
});

test("routing snapshots are stable across API ordering and deprecated tags", () => {
	const before = baselineSnapshot("wiser");
	const after = {
		rules: before.rules.map((rule) => ({
			tag: "deprecated",
			...rule,
			actions: [...rule.actions].reverse(),
			matchers: [...rule.matchers].reverse(),
		})),
		catchAll: { tag: "deprecated", ...before.catchAll },
	};
	assert.equal(
		canonicalRoutingSnapshot(before),
		canonicalRoutingSnapshot(after),
	);
});

test("preflight inventories both brands and performs no mutation", async () => {
	const dependencies = createDependencies();
	const result = await runEmailAuthorizationCanary({
		argv: [],
		destination: "verified@example.com",
		logger: createLogger(),
		suffix: SUFFIX,
		...dependencies,
	});
	assert.equal(result.mode, "preflight");
	assert.deepEqual(dependencies.calls, [
		"inventory:wiser",
		"inventory:whispyr",
	]);
});

test("apply runs four unique probes per brand and removes every temporary resource", async () => {
	const dependencies = createDependencies();
	const result = await runEmailAuthorizationCanary({
		argv: ["--apply", "--confirm", APPLY_CONFIRMATION],
		destination: "verified@example.com",
		logger: createLogger(),
		suffix: SUFFIX,
		...dependencies,
	});
	assert.equal(result.mode, "apply");
	assert.equal(result.results.length, 8);
	assert.equal(new Set(result.results.map((entry) => entry.probeId)).size, 8);
	for (const brand of ["wiser", "whispyr"]) {
		const disable = dependencies.calls.indexOf(`rule:disable:${brand}`);
		const ruleDelete = dependencies.calls.indexOf(`rule:delete:${brand}`);
		const workerDelete = dependencies.calls.indexOf(`worker:delete:${brand}`);
		const kvDelete = dependencies.calls.indexOf(`kv:delete:${brand}`);
		assert.ok(disable >= 0);
		assert.ok(ruleDelete > disable);
		assert.ok(workerDelete > ruleDelete);
		assert.ok(kvDelete > workerDelete);
		assert.ok(dependencies.calls.indexOf(`snapshot:${brand}`) > kvDelete);
	}
});

test("an ambiguous send stops new probes but still disables and deletes all created state", async () => {
	const failProbe = `canary-wiser-${SUFFIX}-forward-above-general-limit`;
	const dependencies = createDependencies({ failProbe });
	await assert.rejects(
		runEmailAuthorizationCanary({
			argv: ["--apply", "--confirm", APPLY_CONFIRMATION],
			destination: "verified@example.com",
			logger: createLogger(),
			suffix: SUFFIX,
			...dependencies,
		}),
		/ambiguous SES result/u,
	);
	assert.ok(dependencies.calls.includes("rule:disable:wiser"));
	assert.ok(dependencies.calls.includes("rule:delete:wiser"));
	assert.ok(dependencies.calls.includes("worker:delete:wiser"));
	assert.ok(dependencies.calls.includes("kv:delete:wiser"));
	assert.equal(
		dependencies.calls.some((call) => call.startsWith("kv:create:whispyr")),
		false,
	);
});
