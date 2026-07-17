#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";
import {
	EMAIL_AUTHORIZATION_CANARY_SIZES,
	buildEmailAuthorizationFixture,
} from "./email-authorization-canary-fixtures.mjs";
import { createPrivateOperationLogger } from "./private-operation-logger.mjs";
import {
	StatefulSecretRedactor,
	redactCompleteValue,
} from "./stateful-secret-redactor.mjs";

const ROOT = process.cwd();
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const FIXED_DESTINATION = "heshamelmahdi@gmail.com";
const AWS_REGION = "eu-west-2";
const REQUEST_TIMEOUT_MS = 120_000;
const FORWARD_PROOF_TIMEOUT_MS = 120_000;
const FORWARD_PROOF_POLL_MS = 2_000;
const GENERAL_EMAIL_LIMIT_BYTES = 5 * 1024 * 1024;
const MAX_TRANSPORT_SIZE_DELTA = 1024 * 1024;
const WRANGLER_PATH = resolve("node_modules", ".bin", "wrangler");
const WORKER_MAIN_PATH = resolve(
	"scripts",
	"email-authorization-canary-worker.ts",
);
const SUFFIX_PATTERN = /^[a-f0-9]{16}$/u;
const EMAIL_ADDRESS_PATTERN =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

export const APPLY_CONFIRMATION = "run-email-authorization-canary";

export const BRAND_CANARY_CONFIG = Object.freeze({
	wiser: Object.freeze({
		domain: "wiserchat.ai",
		sender: "emergency-forward@wiserchat.ai",
		zoneIdEnvironment: "CLOUDFLARE_WISER_ZONE_ID",
	}),
	whispyr: Object.freeze({
		domain: "whispyrcrm.com",
		sender: "emergency-forward@whispyrcrm.com",
		zoneIdEnvironment: "CLOUDFLARE_WHISPYR_ZONE_ID",
	}),
});

const BRAND_ORDER = Object.freeze(["wiser", "whispyr"]);

function requireSuffix(suffix) {
	assert.equal(
		typeof suffix === "string" && SUFFIX_PATTERN.test(suffix),
		true,
		"Canary suffix must be exactly 16 lowercase hexadecimal characters",
	);
	return suffix;
}

function requireEmailAddress(address, label) {
	assert.equal(
		typeof address === "string" && EMAIL_ADDRESS_PATTERN.test(address),
		true,
		`${label} must be a valid ASCII email address`,
	);
	return address;
}

function resourceNames(brand, suffix) {
	const config = BRAND_CANARY_CONFIG[brand];
	if (!config) throw new Error(`Unsupported canary brand: ${brand}`);
	requireSuffix(suffix);
	return {
		recipient: `mail-auth-canary-${suffix}@${config.domain}`,
		runId: `canary-${brand}-${suffix}`,
		workerName: `mail-auth-canary-${brand}-${suffix}`,
		kvTitle: `mail-auth-canary-${brand}-${suffix}`,
	};
}

export function parseCanaryArguments(argv) {
	if (argv.length === 0) return { apply: false };
	if (
		argv.length === 3 &&
		argv[0] === "--apply" &&
		argv[1] === "--confirm" &&
		argv[2] === APPLY_CONFIRMATION
	) {
		return { apply: true };
	}
	throw new Error(
		`Use no arguments for read-only preflight, or --apply --confirm ${APPLY_CONFIRMATION} after exact production approval`,
	);
}

export function buildWranglerCanaryConfig({
	brand,
	destination,
	kvNamespaceId,
	mainPath,
	suffix,
}) {
	const brandConfig = BRAND_CANARY_CONFIG[brand];
	if (!brandConfig) throw new Error(`Unsupported canary brand: ${brand}`);
	requireEmailAddress(destination, "Canary destination");
	const names = resourceNames(brand, suffix);
	return {
		$schema: resolve("node_modules", "wrangler", "config-schema.json"),
		name: names.workerName,
		main: mainPath,
		compatibility_date: "2026-07-17",
		workers_dev: true,
		observability: { enabled: false },
		kv_namespaces: [
			{
				binding: "CANARY_STATE",
				id: kvNamespaceId,
			},
		],
		send_email: [
			{
				name: "EMAIL",
				destination_address: destination,
				allowed_sender_addresses: [brandConfig.sender],
			},
		],
		vars: {
			CANARY_DESTINATION: destination,
			CANARY_RECIPIENT: names.recipient,
			CANARY_RUN_ID: names.runId,
			CANARY_SENDER: brandConfig.sender,
		},
	};
}

export function buildRoutingRule({ brand, suffix }) {
	const names = resourceNames(brand, suffix);
	return {
		actions: [{ type: "worker", value: [names.workerName] }],
		enabled: false,
		matchers: [
			{
				type: "literal",
				field: "to",
				value: names.recipient,
			},
		],
		name: `Temporary mail authorization canary ${brand} ${suffix}`,
		priority: 0,
		source: "api",
	};
}

export function buildSesV2Request({ from, to, raw }) {
	requireEmailAddress(from, "SES sender");
	requireEmailAddress(to, "SES recipient");
	assert.ok(Buffer.isBuffer(raw), "SES raw message must be a Buffer");
	return {
		Content: { Raw: { Data: raw.toString("base64") } },
		Destination: { ToAddresses: [to] },
		FromEmailAddress: from,
	};
}

function canonicalRule(rule) {
	const byJson = (left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right));
	return {
		id: rule.id ?? null,
		actions: [...(rule.actions ?? [])]
			.map((action) => ({
				type: action.type ?? null,
				value: [...(action.value ?? [])].sort(),
			}))
			.sort(byJson),
		enabled: rule.enabled ?? null,
		matchers: [...(rule.matchers ?? [])]
			.map((matcher) => ({
				type: matcher.type ?? null,
				field: matcher.field ?? null,
				value: matcher.value ?? null,
			}))
			.sort(byJson),
		name: rule.name ?? null,
		priority: rule.priority ?? null,
		source: rule.source ?? null,
	};
}

export function canonicalRoutingSnapshot(snapshot) {
	const rules = [...(snapshot.rules ?? [])]
		.map(canonicalRule)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));
	return JSON.stringify({
		rules,
		catchAll: canonicalRule(snapshot.catchAll ?? {}),
	});
}

function buildProbes(brand, suffix, destination) {
	const brandConfig = BRAND_CANARY_CONFIG[brand];
	const names = resourceNames(brand, suffix);
	return [
		...Object.entries(EMAIL_AUTHORIZATION_CANARY_SIZES).map(
			([sizeName, rawBytes]) => {
				const probeId = `${names.runId}-forward-${sizeName
					.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}`;
				return {
					brand,
					lane: "forward",
					probeId,
					rawBytes,
					fixture: buildEmailAuthorizationFixture({
						from: brandConfig.sender,
						to: names.recipient,
						probeId,
						rawBytes,
					}),
				};
			},
		),
		...Object.entries(EMAIL_AUTHORIZATION_CANARY_SIZES).map(
			([sizeName, rawBytes]) => {
				const probeId = `${names.runId}-send-${sizeName
					.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}`;
				return {
					brand,
					lane: "send",
					probeId,
					rawBytes,
					fixture: buildEmailAuthorizationFixture({
						from: brandConfig.sender,
						to: destination,
						probeId,
						rawBytes,
					}),
				};
			},
		),
	];
}

function validateAcceptance(result, probe) {
	const validObservedForwardSize =
		probe.lane !== "forward" ||
		(Number.isSafeInteger(result?.observedRawBytes) &&
			result.observedRawBytes > GENERAL_EMAIL_LIMIT_BYTES &&
			Math.abs(result.observedRawBytes - probe.rawBytes) <=
				MAX_TRANSPORT_SIZE_DELTA);
	if (
		result?.status !== "accepted" ||
		result.probeId !== probe.probeId ||
		result.rawBytes !== probe.rawBytes ||
		typeof result.messageId !== "string" ||
		result.messageId.trim().length === 0 ||
		!validObservedForwardSize
	) {
		throw new Error(`Probe ${probe.probeId} did not return exact acceptance proof`);
	}
	return {
		brand: probe.brand,
		lane: probe.lane,
		probeId: probe.probeId,
		rawBytes: probe.rawBytes,
		messageId: result.messageId,
		...(probe.lane === "forward"
			? { observedRawBytes: result.observedRawBytes }
			: {}),
		status: "accepted",
	};
}

function inventoryError(brand, inventory) {
	if (!inventory.routingReady) return `${brand} Email Routing is not ready`;
	if (inventory.ruleCount >= 200) {
		return `${brand} has no free Email Routing rule slot`;
	}
	if (!inventory.destinationVerified) {
		return `${brand} fixed destination is not verified`;
	}
	if (!inventory.workerAbsent) {
		return `${brand} temporary Worker name already exists`;
	}
	if (!inventory.namespaceAbsent) {
		return `${brand} temporary KV namespace name already exists`;
	}
	if (!inventory.workersSubdomain) {
		return `${brand} account workers.dev subdomain is unavailable`;
	}
	return null;
}

async function cleanupBrand({
	brand,
	state,
	logger,
	setRoutingRuleEnabled,
	deleteRoutingRule,
	deleteWorker,
	deleteKvNamespace,
}) {
	const errors = [];
	if (state.rule) {
		try {
			await setRoutingRuleEnabled(brand, state.rule, false);
			state.rule = { ...state.rule, enabled: false };
			await logger.progress(`${brand}: temporary routing rule disabled`);
		} catch (error) {
			errors.push(error);
		}
		try {
			await deleteRoutingRule(brand, state.rule);
			state.rule = null;
			await logger.progress(`${brand}: temporary routing rule deleted`);
		} catch (error) {
			errors.push(error);
		}
	}
	if (state.workerMayExist) {
		try {
			await deleteWorker(brand, state.workerName);
			state.workerMayExist = false;
			await logger.progress(`${brand}: temporary Worker deleted`);
		} catch (error) {
			errors.push(error);
		}
	}
	if (state.kvNamespaceId) {
		try {
			await deleteKvNamespace(brand, state.kvNamespaceId);
			state.kvNamespaceId = null;
			await logger.progress(`${brand}: temporary KV namespace deleted`);
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

export async function runEmailAuthorizationCanary({
	argv,
	destination,
	logger,
	suffix,
	signal,
	inventoryBrand,
	createKvNamespace,
	deployWorker,
	checkHealth,
	createRoutingRule,
	setRoutingRuleEnabled,
	deleteRoutingRule,
	injectWithSes,
	awaitForwardResult,
	sendWithBinding,
	deleteWorker,
	deleteKvNamespace,
	readRoutingSnapshot,
}) {
	const checkInterrupted = () => signal?.throwIfAborted();
	const { apply } = parseCanaryArguments(argv);
	requireSuffix(suffix);
	requireEmailAddress(destination, "Canary destination");
	await logger.progress(
		`Email authorization canary starting mode=${apply ? "apply" : "preflight"} run=${suffix} log=${logger.logFilePath}`,
	);

	const inventories = new Map();
	const baselines = new Map();
	for (const brand of BRAND_ORDER) {
		checkInterrupted();
		const inventory = await inventoryBrand(brand, {
			destination,
			names: resourceNames(brand, suffix),
		});
		const error = inventoryError(brand, inventory);
		if (error) throw new Error(error);
		inventories.set(brand, inventory);
		baselines.set(brand, canonicalRoutingSnapshot(inventory.routing));
		await logger.progress(
			`${brand}: READY routing ready, destination verified, one temporary rule slot available`,
		);
	}
	if (!apply) {
		await logger.progress(
			`READY eight acceptance probes planned; rerun with --apply --confirm ${APPLY_CONFIRMATION} after exact Cloudflare and SES production approval`,
		);
		return { mode: "preflight", results: [] };
	}

	const results = [];
	for (const brand of BRAND_ORDER) {
		const names = resourceNames(brand, suffix);
		const probes = buildProbes(brand, suffix, destination);
		const state = {
			kvNamespaceId: null,
			rule: null,
			workerMayExist: false,
			workerName: names.workerName,
		};
		let operationError = null;
		try {
			checkInterrupted();
			await logger.progress(`${brand}: creating temporary isolated canary resources`);
			state.kvNamespaceId = await createKvNamespace(brand, names.kvTitle);
			checkInterrupted();
			const config = buildWranglerCanaryConfig({
				brand,
				destination,
				kvNamespaceId: state.kvNamespaceId,
				mainPath: WORKER_MAIN_PATH,
				suffix,
			});
			state.workerMayExist = true;
			await deployWorker(brand, {
				authToken: randomBytes(32).toString("base64url"),
				config,
				workerName: names.workerName,
			});
			checkInterrupted();
			await checkHealth(brand, names.workerName);
			state.rule = buildRoutingRule({ brand, suffix });
			state.rule = await createRoutingRule(brand, state.rule);
			checkInterrupted();
			state.rule = await setRoutingRuleEnabled(brand, state.rule, true);
			await logger.progress(`${brand}: exact temporary routing rule enabled`);

			for (const probe of probes.filter((entry) => entry.lane === "forward")) {
				checkInterrupted();
				const ses = await injectWithSes(brand, probe);
				await logger.detail(
					`${probe.probeId} ses_message_id=${ses.messageId ?? "(missing)"}`,
				);
				const proof = await awaitForwardResult(brand, probe);
				results.push(validateAcceptance(proof, probe));
				await logger.progress(
					`${brand}: PASS ${probe.lane} ${probe.rawBytes} bytes accepted`,
				);
			}

			state.rule = await setRoutingRuleEnabled(brand, state.rule, false);
			await logger.progress(`${brand}: temporary routing rule disabled`);
			await deleteRoutingRule(brand, state.rule);
			state.rule = null;
			await logger.progress(`${brand}: temporary routing rule deleted`);

			for (const probe of probes.filter((entry) => entry.lane === "send")) {
				checkInterrupted();
				const proof = await sendWithBinding(brand, probe);
				results.push(validateAcceptance(proof, probe));
				await logger.progress(
					`${brand}: PASS ${probe.lane} ${probe.rawBytes} bytes accepted`,
				);
			}
		} catch (error) {
			operationError = error;
		}

		const cleanupErrors = await cleanupBrand({
			brand,
			state,
			logger,
			setRoutingRuleEnabled,
			deleteRoutingRule,
			deleteWorker,
			deleteKvNamespace,
		});
		try {
			const after = canonicalRoutingSnapshot(await readRoutingSnapshot(brand));
			if (after !== baselines.get(brand)) {
				throw new Error(
					`${brand} routing snapshot changed outside the temporary canary rule`,
				);
			}
			await logger.progress(`${brand}: PASS original routing snapshot restored`);
		} catch (error) {
			cleanupErrors.push(error);
		}

		if (operationError || cleanupErrors.length > 0) {
			const primary =
				operationError instanceof Error
					? operationError
					: new Error(String(operationError ?? "Canary cleanup failed"));
			if (cleanupErrors.length === 0) throw primary;
			throw new AggregateError(
				[primary, ...cleanupErrors],
				`${primary.message}; cleanup verification also failed`,
			);
		}
	}

	await logger.progress(
		"PASS all eight Cloudflare email authorization probes returned exact acceptance evidence and all temporary resources were removed",
	);
	await logger.progress(
		"DELIVERY CHECK REQUIRED confirm all eight probe IDs in the fixed destination inbox before recording the production gate as complete",
	);
	return { mode: "apply", results };
}

function safeError(error) {
	return error instanceof Error ? error.message : String(error);
}

function childEnvironment(apiToken, wranglerLogPath) {
	const allowed = [
		"HOME",
		"LANG",
		"LC_ALL",
		"LOGNAME",
		"PATH",
		"SHELL",
		"TMPDIR",
		"TZ",
		"USER",
	];
	const environment = Object.fromEntries(
		allowed
			.filter((name) => process.env[name])
			.map((name) => [name, process.env[name]]),
	);
	return {
		...environment,
		CLOUDFLARE_API_TOKEN: apiToken,
		CLOUDFLARE_CF_FETCH_ENABLED: "false",
		CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
		WRANGLER_LOG_PATH: wranglerLogPath,
		WRANGLER_SEND_ERROR_REPORTS: "false",
		WRANGLER_SEND_METRICS: "false",
	};
}

async function runChild({
	arguments_,
	apiToken,
	input,
	logger,
	secrets,
	signal,
	wranglerLogPath,
}) {
	const output = new Map([
		["stdout", new StatefulSecretRedactor(secrets)],
		["stderr", new StatefulSecretRedactor(secrets)],
	]);
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(WRANGLER_PATH, arguments_, {
			cwd: ROOT,
			env: childEnvironment(apiToken, wranglerLogPath),
			signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const streamName of ["stdout", "stderr"]) {
			child[streamName].on("data", (chunk) => {
				const safe = output.get(streamName).write(chunk.toString("utf8"));
				if (safe) void logger.detail(`wrangler_${streamName}=${safe}`);
			});
		}
		child.on("error", rejectPromise);
		child.on("close", (code, signal) => {
			for (const [streamName, redactor] of output) {
				const safe = redactor.flush();
				if (safe) void logger.detail(`wrangler_${streamName}=${safe}`);
			}
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`Wrangler failed code=${code ?? "none"} signal=${signal ?? "none"}`,
				),
			);
		});
		if (input) child.stdin.end(`${input}\n`);
		else child.stdin.end();
	});
}

function createCloudflareClient({ accountId, apiToken, zoneIds, logger }) {
	async function request(
		path,
		{ method = "GET", body, allowStatuses = [] } = {},
	) {
		const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		if (allowStatuses.includes(response.status)) {
			return { allowedStatus: response.status, result: null };
		}
		let envelope;
		try {
			envelope = text ? JSON.parse(text) : { success: response.ok, result: null };
		} catch {
			throw new Error(`Cloudflare API returned invalid JSON for ${method} ${path}`);
		}
		if (!response.ok || envelope.success !== true) {
			const messages = [...(envelope.errors ?? []), ...(envelope.messages ?? [])]
				.map((entry) => entry?.message)
				.filter(Boolean)
				.slice(0, 3)
				.join("; ");
			throw new Error(
				`Cloudflare API failed ${method} ${path} status=${response.status}${messages ? `: ${messages}` : ""}`,
			);
		}
		await logger.detail(
			`cloudflare_api method=${method} path=${path} status=${response.status}`,
		);
		return { result: envelope.result, resultInfo: envelope.result_info };
	}

	async function listPaginated(path, perPage) {
		const separator = path.includes("?") ? "&" : "?";
		const first = await request(`${path}${separator}page=1&per_page=${perPage}`);
		const results = [...(first.result ?? [])];
		const totalPages = first.resultInfo?.total_pages ?? 1;
		for (let page = 2; page <= totalPages; page += 1) {
			const next = await request(
				`${path}${separator}page=${page}&per_page=${perPage}`,
			);
			results.push(...(next.result ?? []));
		}
		return results;
	}

	async function routingSnapshot(brand) {
		const zoneId = zoneIds[brand];
		const [rules, catchAll] = await Promise.all([
			listPaginated(`/zones/${zoneId}/email/routing/rules`, 200),
			request(`/zones/${zoneId}/email/routing/rules/catch_all`).then(
				(value) => value.result,
			),
		]);
		return { rules, catchAll };
	}

	async function listNamespaces() {
		return listPaginated(
			`/accounts/${accountId}/storage/kv/namespaces`,
			1000,
		);
	}

	async function listRoutingRules(brand) {
		return listPaginated(
			`/zones/${zoneIds[brand]}/email/routing/rules`,
			200,
		);
	}

	function sameTemporaryRule(candidate, expected) {
		const normalize = (rule) =>
			JSON.stringify({
				actions: canonicalRule(rule).actions,
				enabled: rule.enabled ?? false,
				matchers: canonicalRule(rule).matchers,
				name: rule.name ?? null,
			});
		return normalize(candidate) === normalize(expected);
	}

	async function resolveTemporaryRule(brand, rule) {
		if (rule?.id) return rule;
		const matches = (await listRoutingRules(brand)).filter((candidate) =>
			sameTemporaryRule(candidate, rule),
		);
		if (matches.length > 1) {
			throw new Error(`${brand} has duplicate temporary canary routing rules`);
		}
		return matches[0] ?? null;
	}

	return {
		async inventoryBrand(brand, { destination, names }) {
			const zoneId = zoneIds[brand];
			const [
				routingSettings,
				routing,
				addresses,
				workers,
				namespaces,
				subdomain,
			] = await Promise.all([
				request(`/zones/${zoneId}/email/routing`).then(
					(value) => value.result,
				),
				routingSnapshot(brand),
				listPaginated(
					`/accounts/${accountId}/email/routing/addresses`,
					200,
				),
				request(`/accounts/${accountId}/workers/scripts`).then(
					(value) => value.result ?? [],
				),
				listPaginated(
					`/accounts/${accountId}/storage/kv/namespaces`,
					1000,
				),
				request(`/accounts/${accountId}/workers/subdomain`).then(
					(value) => value.result?.subdomain,
				),
			]);
			return {
				routing,
				routingReady:
					routingSettings?.enabled === true &&
					routingSettings?.status === "ready",
				ruleCount: routing.rules.length,
				destinationVerified: addresses.some(
					(address) =>
						address.email?.toLowerCase() === destination.toLowerCase() &&
						Boolean(address.verified),
				),
				workerAbsent: !workers.some(
					(worker) => worker.id === names.workerName,
				),
				namespaceAbsent: !namespaces.some(
					(namespace) => namespace.title === names.kvTitle,
				),
				workersSubdomain: subdomain,
			};
		},
		readRoutingSnapshot: routingSnapshot,
		listNamespaces,
		async createKvNamespace(_brand, title) {
			try {
				const created = await request(
					`/accounts/${accountId}/storage/kv/namespaces`,
					{ method: "POST", body: { title } },
				);
				if (!created.result?.id) {
					throw new Error("Cloudflare did not return a KV namespace ID");
				}
				return created.result?.id;
			} catch (error) {
				const matches = (await listNamespaces()).filter(
					(namespace) => namespace.title === title,
				);
				if (matches.length === 1) return matches[0].id;
				throw error;
			}
		},
		async deleteKvNamespace(_brand, namespaceId) {
			await request(
				`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
				{ method: "DELETE", allowStatuses: [404] },
			);
		},
		listRoutingRules,
		async createRoutingRule(brand, rule) {
			try {
				const created = await request(
					`/zones/${zoneIds[brand]}/email/routing/rules`,
					{ method: "POST", body: rule },
				);
				if (!created.result?.id) {
					throw new Error("Cloudflare did not return a routing rule ID");
				}
				return created.result;
			} catch (error) {
				const matches = (await listRoutingRules(brand)).filter((candidate) =>
					sameTemporaryRule(candidate, rule),
				);
				if (matches.length === 1) return matches[0];
				throw error;
			}
		},
		async setRoutingRuleEnabled(brand, rule, enabled) {
			const resolvedRule = await resolveTemporaryRule(brand, rule);
			if (!resolvedRule) {
				if (!enabled) return rule;
				throw new Error(`${brand} temporary canary routing rule is missing`);
			}
			const payload = {
				actions: resolvedRule.actions,
				enabled,
				matchers: resolvedRule.matchers,
				name: resolvedRule.name,
				priority: resolvedRule.priority,
				source: resolvedRule.source,
			};
			const updated = await request(
				`/zones/${zoneIds[brand]}/email/routing/rules/${resolvedRule.id}`,
				{ method: "PUT", body: payload },
			);
			return updated.result;
		},
		async deleteRoutingRule(brand, rule) {
			const resolvedRule = await resolveTemporaryRule(brand, rule);
			if (!resolvedRule) return;
			await request(
				`/zones/${zoneIds[brand]}/email/routing/rules/${resolvedRule.id}`,
				{ method: "DELETE", allowStatuses: [404] },
			);
		},
		async deleteWorker(_brand, workerName) {
			await request(
				`/accounts/${accountId}/workers/scripts/${workerName}?force=true`,
				{ method: "DELETE", allowStatuses: [404] },
			);
		},
		async workersSubdomain() {
			return request(`/accounts/${accountId}/workers/subdomain`).then(
				(value) => value.result?.subdomain,
			);
		},
	};
}

function requiredEnvironment(environment) {
	const required = [
		"CLOUDFLARE_API_TOKEN",
		"CLOUDFLARE_ACCOUNT_ID",
		"CLOUDFLARE_WISER_ZONE_ID",
		"CLOUDFLARE_WHISPYR_ZONE_ID",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
	];
	for (const name of required) {
		if (!environment[name]?.trim()) throw new Error(`${name} is required`);
	}
	if (environment.AWS_REGION && environment.AWS_REGION !== AWS_REGION) {
		throw new Error(`AWS_REGION must be ${AWS_REGION}`);
	}
	return {
		accountId: environment.CLOUDFLARE_ACCOUNT_ID,
		apiToken: environment.CLOUDFLARE_API_TOKEN,
		awsAccessKeyId: environment.AWS_ACCESS_KEY_ID,
		awsSecretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
		awsSessionToken: environment.AWS_SESSION_TOKEN,
		zoneIds: {
			wiser: environment.CLOUDFLARE_WISER_ZONE_ID,
			whispyr: environment.CLOUDFLARE_WHISPYR_ZONE_ID,
		},
	};
}

async function createProductionDependencies({
	environment,
	logger,
	signal,
	suffix,
}) {
	const credentials = requiredEnvironment(environment);
	const tempDirectory = await mkdtemp(
		join(tmpdir(), `mail-auth-canary-${suffix}-`),
	);
	const wranglerLogPath = join(tempDirectory, "wrangler.log");
	const secrets = [
		credentials.apiToken,
		credentials.awsAccessKeyId,
		credentials.awsSecretAccessKey,
		credentials.awsSessionToken,
	].filter(Boolean);
	const cloudflare = createCloudflareClient({
		accountId: credentials.accountId,
		apiToken: credentials.apiToken,
		zoneIds: credentials.zoneIds,
		logger,
	});
	const authTokens = new Map();
	const workerUrls = new Map();
	const aws = new AwsClient({
		accessKeyId: credentials.awsAccessKeyId,
		secretAccessKey: credentials.awsSecretAccessKey,
		sessionToken: credentials.awsSessionToken,
		service: "ses",
		region: AWS_REGION,
		retries: 0,
	});
	const operationSignal = signal;
	const boundedSignal = (timeoutMs) =>
		operationSignal
			? AbortSignal.any([operationSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);

	return {
		...cloudflare,
		async deployWorker(brand, deployment) {
			const configPath = join(tempDirectory, `${brand}-wrangler.json`);
			await writeFile(configPath, `${JSON.stringify(deployment.config, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			authTokens.set(brand, deployment.authToken);
			await runChild({
				arguments_: [
					"deploy",
					"--config",
					configPath,
					"--strict",
					"--message",
					`Temporary ${brand} email authorization canary`,
				],
				apiToken: credentials.apiToken,
				logger,
				secrets: [...secrets, deployment.authToken],
				signal: operationSignal,
				wranglerLogPath,
			});
			await runChild({
				arguments_: [
					"secret",
					"put",
					"CANARY_AUTH_TOKEN",
					"--config",
					configPath,
				],
				apiToken: credentials.apiToken,
				input: deployment.authToken,
				logger,
				secrets: [...secrets, deployment.authToken],
				signal: operationSignal,
				wranglerLogPath,
			});
			const subdomain = await cloudflare.workersSubdomain();
			if (!subdomain) throw new Error("workers.dev subdomain is unavailable");
			workerUrls.set(
				brand,
				`https://${deployment.workerName}.${subdomain}.workers.dev`,
			);
		},
		async checkHealth(brand) {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const response = await fetch(`${workerUrls.get(brand)}/health`, {
						headers: {
							Authorization: `Bearer ${authTokens.get(brand)}`,
						},
						signal: boundedSignal(10_000),
					});
					if (response.ok && (await response.json()).status === "ready") return;
				} catch {
					// Deployment propagation is bounded by the deadline below.
				}
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
			}
			throw new Error(`${brand} temporary Worker did not become healthy`);
		},
		async injectWithSes(brand, probe) {
			const brandConfig = BRAND_CANARY_CONFIG[brand];
			const names = resourceNames(brand, suffix);
			const payload = buildSesV2Request({
				from: brandConfig.sender,
				to: names.recipient,
				raw: probe.fixture.raw,
			});
			const request = await aws.sign(
				`https://email.${AWS_REGION}.amazonaws.com/v2/email/outbound-emails`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				},
			);
			const response = await fetch(request, {
				signal: boundedSignal(REQUEST_TIMEOUT_MS),
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok || typeof body.MessageId !== "string") {
				throw new Error(
					`${brand} SES v2 probe ${probe.probeId} did not return acceptance`,
				);
			}
			return { messageId: body.MessageId };
		},
		async awaitForwardResult(brand, probe) {
			const deadline = Date.now() + FORWARD_PROOF_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const response = await fetch(
					`${workerUrls.get(brand)}/status?probe=${encodeURIComponent(probe.probeId)}`,
					{
						headers: {
							Authorization: `Bearer ${authTokens.get(brand)}`,
						},
						signal: boundedSignal(10_000),
					},
				);
				const result = await response.json().catch(() => ({}));
				if (response.status === 200) return result;
				if (response.status !== 202) {
					throw new Error(
						`${brand} forward proof failed for ${probe.probeId}`,
					);
				}
				await new Promise((resolvePromise) =>
					setTimeout(resolvePromise, FORWARD_PROOF_POLL_MS),
				);
			}
			throw new Error(`${brand} forward proof timed out for ${probe.probeId}`);
		},
		async sendWithBinding(brand, probe) {
			const response = await fetch(`${workerUrls.get(brand)}/send`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${authTokens.get(brand)}`,
					"Content-Length": String(probe.rawBytes),
					"Content-Type": "message/rfc822",
					"X-Canary-Probe-ID": probe.probeId,
					"X-Canary-Raw-Bytes": String(probe.rawBytes),
				},
				body: probe.fixture.raw,
				signal: boundedSignal(REQUEST_TIMEOUT_MS),
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new Error(
					`${brand} send binding failed for ${probe.probeId}`,
				);
			}
			return result;
		},
		async close() {
			await rm(tempDirectory, { recursive: true, force: true });
		},
	};
}

async function createLogger(environment) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = randomBytes(6).toString("hex");
	const secrets = [
		environment.CLOUDFLARE_API_TOKEN,
		environment.AWS_ACCESS_KEY_ID,
		environment.AWS_SECRET_ACCESS_KEY,
		environment.AWS_SESSION_TOKEN,
	].filter(Boolean);
	return createPrivateOperationLogger({
		logFilePath: resolve(
			"script-logs",
			`email-authorization-canary-${timestamp}-${process.pid}-${suffix}.log`,
		),
		header: `email-authorization-canary\nstarted_at=${new Date().toISOString()}\ndestination=${FIXED_DESTINATION}`,
		sanitize: (value) =>
			redactCompleteValue(String(value ?? ""), secrets).slice(0, 20_000),
	});
}

async function main() {
	const suffix = randomBytes(8).toString("hex");
	const logger = await createLogger(process.env);
	const controller = new AbortController();
	let interruptedSignal = null;
	const handlers = new Map(
		[
			["SIGHUP", 129],
			["SIGINT", 130],
			["SIGTERM", 143],
		].map(([signalName, status]) => [
			signalName,
			() => {
				if (interruptedSignal) return;
				interruptedSignal = { signalName, status };
				controller.abort(new Error(`Interrupted by ${signalName}`));
			},
		]),
	);
	for (const [signalName, handler] of handlers) {
		process.on(signalName, handler);
	}
	let dependencies;
	try {
		dependencies = await createProductionDependencies({
			environment: process.env,
			logger,
			signal: controller.signal,
			suffix,
		});
		await runEmailAuthorizationCanary({
			argv: process.argv.slice(2),
			destination: FIXED_DESTINATION,
			logger,
			signal: controller.signal,
			suffix,
			...dependencies,
		});
	} catch (error) {
		if (interruptedSignal) {
			await logger.failure(`INTERRUPTED ${interruptedSignal.signalName}`);
			process.exitCode = interruptedSignal.status;
		} else {
			await logger.failure(`FAIL ${safeError(error)}`);
			process.exitCode = 1;
		}
	} finally {
		await dependencies?.close().catch(async (error) => {
			await logger.failure(`FAIL temporary local cleanup: ${safeError(error)}`);
			process.exitCode = 1;
		});
		await logger.close();
		for (const [signalName, handler] of handlers) {
			process.off(signalName, handler);
		}
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}
