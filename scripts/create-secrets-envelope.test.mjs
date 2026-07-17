import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readFile,
	readdir,
	rmdir,
	stat,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createSecretsEnvelope } from "./create-secrets-envelope.mjs";
import { REQUIRED_SECRETS } from "./verify-built-environment.mjs";

const CREATOR_PATH = resolve("scripts/create-secrets-envelope.mjs");
const SIGNAL_FIXTURE_PATH = resolve(
	"scripts/create-secrets-envelope-signal-fixture.mjs",
);

function testSecrets() {
	return Object.fromEntries(
		REQUIRED_SECRETS.map((name) => [name, `value for ${name}: "quoted" \\ safe`]),
	);
}

async function removeEnvelope(path) {
	await unlink(path);
	await rmdir(dirname(path));
}

test("creator JSON-encodes every exact value in a private brand envelope", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "mail-portal-envelope-root-"));
	await chmod(temporaryRoot, 0o700);
	const secrets = testSecrets();
	secrets.ACCOUNT_RECOVERY_DIRECTORY = JSON.stringify({
		"member@wiserchat.ai": 'owner+"quoted"@personal.example',
	});
	const path = await createSecretsEnvelope({
		brand: "wiser",
		secrets,
		temporaryRoot,
	});
	assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		schemaVersion: 1,
		brand: "wiser",
		secrets,
	});
	await removeEnvelope(path);
	await rmdir(temporaryRoot);
});

test("direct creator keeps secret values out of argv and output", async () => {
	const secrets = testSecrets();
	secrets.ACCOUNT_RECOVERY_DIRECTORY =
		'{"member@wiserchat.ai":"owner@personal.example"}';
	const result = spawnSync(process.execPath, [CREATOR_PATH, "wiser"], {
		env: { ...process.env, ...secrets },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const path = result.stdout.trim();
	assert.equal(result.stderr, "");
	assert.match(path, /wiser-mail-portal-secrets-/);
	for (const value of Object.values(secrets)) {
		assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
	}
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).secrets, secrets);
	await removeEnvelope(path);
});

test("creator fails before writing when any secret is missing", async () => {
	const secrets = testSecrets();
	delete secrets.JWT_SECRET;
	await assert.rejects(
		() =>
			createSecretsEnvelope({
				brand: "wiser",
				secrets,
			}),
		/exactly the declared secret names/i,
	);
});

async function assertInterruptedCreatorCleansArtifact(stage, terminatingSignal) {
	const temporaryRoot = await mkdtemp(
		join(tmpdir(), "mail-portal-envelope-signal-root-"),
	);
	const child = spawn(
		process.execPath,
		[SIGNAL_FIXTURE_PATH, "wiser", temporaryRoot, stage],
		{
			env: { ...process.env, ...testSecrets() },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const readyMessage = `${stage}-ready:1\n`;
	const ready = new Promise((resolveReady, rejectReady) => {
		const timeout = setTimeout(
			() => rejectReady(new Error("creator signal fixture did not become ready")),
			2_000,
		);
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.includes(readyMessage)) {
				clearTimeout(timeout);
				resolveReady();
			}
		});
		child.once("exit", (code, signal) => {
			if (!stderr.includes(readyMessage)) {
				clearTimeout(timeout);
				rejectReady(
					new Error(
						`creator exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
					),
				);
			}
		});
	});
	await ready;
	const [createdDirectory] = await readdir(temporaryRoot);
	assert.ok(createdDirectory);
	const createdPath = join(temporaryRoot, createdDirectory, "envelope.json");
	if (stage === "artifact" || stage === "write") {
		assert.equal((await stat(createdPath)).mode & 0o777, 0o600);
	} else {
		assert.deepEqual(await readdir(join(temporaryRoot, createdDirectory)), []);
	}
	assert.equal(child.kill(terminatingSignal), true);
	const exit = await new Promise((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
	assert.deepEqual(exit, { code: null, signal: terminatingSignal }, stderr);
	if (stage === "open" || stage === "write") {
		assert.match(stderr, new RegExp(`${stage}-settled\\n`));
	}
	assert.equal(stdout, "");
	assert.deepEqual(await readdir(temporaryRoot), []);
	await rmdir(temporaryRoot);
}

for (const terminatingSignal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
	for (const [stage, description] of [
		["directory", "directory before artifact registration"],
		["open", "in-flight file open"],
		["write", "in-flight file write"],
		["artifact", "completed unhanded artifact"],
	]) {
		test(`direct creator cleans an interrupted ${description} and re-raises ${terminatingSignal}`, async () => {
			await assertInterruptedCreatorCleansArtifact(stage, terminatingSignal);
		});
	}
}
