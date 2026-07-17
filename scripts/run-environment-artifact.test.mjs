import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
	runEnvironmentArtifact,
	validateDeployArgs,
} from "./run-environment-artifact.mjs";
import { REQUIRED_SECRETS } from "./verify-built-environment.mjs";

const WRAPPER_PATH = resolve("scripts/run-environment-artifact.mjs");

function deferred() {
	let resolvePromise;
	const promise = new Promise((complete) => {
		resolvePromise = complete;
	});
	return { promise, resolve: resolvePromise };
}

async function writeGeneratedBuild(directory, marker = "expected-artifact") {
	await mkdir(join(directory, "build", "server"), { recursive: true });
	await mkdir(join(directory, "build", "client", "assets"), { recursive: true });
	await writeFile(
		join(directory, "build", "server", "wrangler.json"),
		JSON.stringify({ marker }),
	);
	await writeFile(join(directory, "build", "server", "index.js"), marker);
	await writeFile(join(directory, "build", "client", "assets", "app.js"), marker);
}

async function pathIsMissing(path) {
	try {
		await access(path);
		return false;
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
}

function quietRun(overrides) {
	return runEnvironmentArtifact({
		stdout: () => {},
		stderr: () => {},
		...overrides,
	});
}

function testSecrets() {
	return Object.fromEntries(
		REQUIRED_SECRETS.map((name) => [name, `test-${name.toLowerCase()}`]),
	);
}

async function writeSecretsEnvelope(directory, brand = "wiser", overrides = {}) {
	const path = join(directory, "secrets-envelope.json");
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			brand,
			secrets: testSecrets(),
			...overrides,
		}),
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
	return path;
}

test("deploy uses a private immutable copy of the exact verified build", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-deploy-"));
	const secretsEnvelopePath = await writeSecretsEnvelope(directory);
	const calls = [];
	let stagedPath;
	await quietRun({
		brand: "wiser",
		mode: "deploy",
		cwd: directory,
		deployArgs: [
			"--dry-run",
			"--outdir=dist",
			"--secrets-file",
			secretsEnvelopePath,
		],
		async runCommand(command, args, options) {
			if (command.endsWith("react-router")) {
				await writeGeneratedBuild(directory);
			} else {
				const wranglerSecretsPath = args[args.indexOf("--secrets-file") + 1];
				calls.push({
					command,
					args,
					env: options.env.CLOUDFLARE_ENV,
					artifact: await readFile(args[2], "utf8"),
					wranglerSecretsPath,
					wranglerSecrets: JSON.parse(
						await readFile(wranglerSecretsPath, "utf8"),
					),
					wranglerSecretsMode: (await stat(wranglerSecretsPath)).mode & 0o777,
					wranglerSecretsDirectoryMode:
						(await stat(dirname(wranglerSecretsPath))).mode & 0o777,
				});
			}
		},
		async verifyArtifact(input) {
			stagedPath = input.artifactPath;
			calls.push({
				verify: input,
				artifact: await readFile(input.artifactPath, "utf8"),
			});
		},
	});

	assert.equal(calls[0].verify.brand, "wiser");
	assert.notEqual(
		calls[0].verify.artifactPath,
		join(directory, "build", "server", "wrangler.json"),
	);
	assert.equal(calls[0].artifact, '{"marker":"expected-artifact"}');
	assert.match(calls[1].command, /wrangler$/);
	assert.deepEqual(calls[1].args, [
		"deploy",
		"--config",
		stagedPath,
		"--dry-run",
		"--outdir",
		"dist",
		"--secrets-file",
		calls[1].wranglerSecretsPath,
	]);
	assert.notEqual(calls[1].wranglerSecretsPath, secretsEnvelopePath);
	assert.deepEqual(calls[1].wranglerSecrets, testSecrets());
	assert.equal(calls[1].wranglerSecretsMode, 0o400);
	assert.equal(calls[1].wranglerSecretsDirectoryMode, 0o700);
	assert.equal(await pathIsMissing(calls[1].wranglerSecretsPath), true);
	assert.equal(
		(await stat(secretsEnvelopePath)).mode & 0o777,
		0o600,
	);
	assert.equal(calls[1].artifact, '{"marker":"expected-artifact"}');
	assert.equal(calls[1].env, "wiser");
	assert.equal(await pathIsMissing(dirname(dirname(stagedPath))), true);
});

test("secrets envelopes fail closed before lock, log, build, or verifier", async () => {
	for (const [name, prepare, pattern] of [
		[
			"wrong brand",
			(directory) => writeSecretsEnvelope(directory, "whispyr"),
			/bound to wiser/i,
		],
		[
			"extra field",
			(directory) =>
				writeSecretsEnvelope(directory, "wiser", { unexpected: true }),
			/schema version 1/i,
		],
		[
			"missing secret",
			async (directory) => {
				const secrets = testSecrets();
				delete secrets.JWT_SECRET;
				return writeSecretsEnvelope(directory, "wiser", { secrets });
			},
			/exactly the declared secret names/i,
		],
		[
			"non-string secret",
			(directory) =>
				writeSecretsEnvelope(directory, "wiser", {
					secrets: { ...testSecrets(), JWT_SECRET: 123 },
				}),
			/non-empty string/i,
		],
	]) {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-secrets-${name.replaceAll(" ", "-")}-`),
		);
		const path = await prepare(directory);
		let called = false;
		await assert.rejects(
			() =>
				quietRun({
					brand: "wiser",
					mode: "deploy",
					cwd: directory,
					deployArgs: ["--secrets-file", path],
					async runCommand() {
						called = true;
					},
					async verifyArtifact() {
						called = true;
					},
				}),
			pattern,
			name,
		);
		assert.equal(called, false, name);
		assert.equal(
			await pathIsMissing(join(directory, ".mail-portal-artifact.lock")),
			true,
			name,
		);
		assert.equal(await pathIsMissing(join(directory, "script-logs")), true, name);
	}
});

test("secrets envelopes reject public mode, symlinks, and hard links", async () => {
	for (const attack of ["mode", "symlink", "hardlink"]) {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-secrets-${attack}-`),
		);
		const source = await writeSecretsEnvelope(directory);
		let path = source;
		if (attack === "mode") {
			await chmod(source, 0o644);
		} else if (attack === "symlink") {
			path = join(directory, "secrets-link.json");
			await symlink(source, path, "file");
		} else {
			path = join(directory, "secrets-hardlink.json");
			await link(source, path);
		}
		await assert.rejects(
			() =>
				quietRun({
					brand: "wiser",
					mode: "deploy",
					cwd: directory,
					deployArgs: ["--secrets-file", path],
					async runCommand() {
						throw new Error("must not build");
					},
				}),
			/owned regular non-symlink single-link file with mode 0600|ELOOP/i,
			attack,
		);
		assert.equal(await readFile(source, "utf8").then(Boolean), true);
	}
});

test("derived Wrangler secrets are removed when deployment fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-secrets-failure-"));
	const source = await writeSecretsEnvelope(directory);
	let derivedPath;
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "deploy",
				cwd: directory,
				deployArgs: ["--secrets-file", source],
				async runCommand(command, args) {
					if (command.endsWith("react-router")) {
						await writeGeneratedBuild(directory);
						return;
					}
					derivedPath = args[args.indexOf("--secrets-file") + 1];
					throw new Error("simulated Wrangler failure");
				},
				async verifyArtifact() {},
			}),
		/simulated Wrangler failure/i,
	);
	assert.equal(await pathIsMissing(derivedPath), true);
	assert.equal(await pathIsMissing(dirname(derivedPath)), true);
	assert.equal((await stat(source)).mode & 0o777, 0o600);
});

test("a stale artifact cannot survive a no-op build", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-stale-"));
	await writeGeneratedBuild(directory, "stale");
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: directory,
				async runCommand() {},
			}),
		/did not create build\/server\/wrangler\.json/i,
	);
	assert.equal(
		await pathIsMissing(join(directory, "build", "server", "wrangler.json")),
		true,
	);
});

test("a stale symlink artifact is rejected without touching its target", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-symlink-"));
	const target = join(directory, "outside.json");
	await mkdir(join(directory, "build", "server"), { recursive: true });
	await writeFile(target, "preserve");
	await symlink(
		target,
		join(directory, "build", "server", "wrangler.json"),
		"file",
	);
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: directory,
				async runCommand() {
					throw new Error("must not build");
				},
			}),
		/prior generated artifact must be.*non-symlink/i,
	);
	assert.equal(await readFile(target, "utf8"), "preserve");
});

for (const mutation of ["bytes", "replacement", "symlink"]) {
	test(`staged artifact ${mutation} after verification fails closed`, async () => {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-stage-${mutation}-`),
		);
		let stageRoot;
		await assert.rejects(
			() =>
				quietRun({
					brand: "wiser",
					mode: "deploy",
					cwd: directory,
					deployArgs: ["--dry-run"],
					async runCommand(command) {
						if (command.endsWith("react-router")) {
							await writeGeneratedBuild(directory);
							return;
						}
						throw new Error("Wrangler must not run");
					},
					async verifyArtifact(input) {
						stageRoot = dirname(dirname(input.artifactPath));
						const serverDirectory = dirname(input.artifactPath);
						if (mutation === "bytes") {
							await chmod(input.artifactPath, 0o600);
							await writeFile(input.artifactPath, '{"marker":"mutated"}');
							await chmod(input.artifactPath, 0o400);
						} else {
							await chmod(serverDirectory, 0o700);
							await unlink(input.artifactPath);
							if (mutation === "replacement") {
								await writeFile(input.artifactPath, '{"marker":"replacement"}', {
									mode: 0o400,
								});
							} else {
								const target = join(directory, "malicious.json");
								await writeFile(target, "malicious");
								await symlink(target, input.artifactPath, "file");
							}
							await chmod(serverDirectory, 0o500);
						}
					},
				}),
			/staged artifact|staged file/i,
		);
		assert.equal(await pathIsMissing(stageRoot), false);
	});
}

test("mutation of the shared build after verification cannot change deployed bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-shared-mutate-"));
	let deployed;
	await quietRun({
		brand: "whispyr",
		mode: "deploy",
		cwd: directory,
		deployArgs: ["--dry-run"],
		async runCommand(command, args) {
			if (command.endsWith("react-router")) {
				await writeGeneratedBuild(directory, "verified");
				return;
			}
			deployed = {
				path: args[2],
				bytes: await readFile(args[2], "utf8"),
			};
		},
		async verifyArtifact() {},
		async onBeforeDeploy() {
			await writeFile(
				join(directory, "build", "server", "wrangler.json"),
				'{"marker":"unverified"}',
			);
		},
	});
	assert.equal(deployed.bytes, '{"marker":"verified"}');
	assert.notEqual(
		deployed.path,
		join(directory, "build", "server", "wrangler.json"),
	);
});

test("mutation during Wrangler execution is detected and retained as evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-deploy-mutate-"));
	let stagedPath;
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "deploy",
				cwd: directory,
				deployArgs: ["--dry-run"],
				async runCommand(command, args) {
					if (command.endsWith("react-router")) {
						await writeGeneratedBuild(directory);
						return;
					}
					stagedPath = args[2];
					await chmod(stagedPath, 0o600);
					await writeFile(stagedPath, '{"marker":"changed-during-deploy"}');
					await chmod(stagedPath, 0o400);
				},
				async verifyArtifact() {},
			}),
		/staged artifact bytes or topology changed/i,
	);
	assert.equal(await pathIsMissing(dirname(dirname(stagedPath))), false);
});

test("deploy arguments have an explicit strict operational allowlist", () => {
	assert.deepEqual(
		validateDeployArgs([
			"--dry-run=true",
			"--outdir=dist",
			"--secrets-file",
			"private.env",
		]),
		["--dry-run", "--outdir", "dist", "--secrets-file", "private.env"],
	);

	for (const args of [
		["--name", "other"],
		["--routes=x"],
		["--route", "x"],
		["--var", "A:B"],
		["--define=A:B"],
		["--assets", "other"],
		["--compatibility-date", "2099-01-01"],
		["--compatibility-flags=x"],
		["--kv", "A"],
		["--d1", "A"],
		["--r2", "A"],
		["--migrations", "other"],
		["--env", "other"],
		["--config=other.json"],
		["--cwd", "other"],
		["--no-bundle"],
		["--dry-run=false"],
		["--dry-run", "positional"],
		["--outdir"],
		["--outdir", "--dry-run"],
		["--outdir", "one", "--outdir", "two"],
		["--secrets-file=-"],
		["--"],
		["--", "positional"],
		["-c", "other.json"],
		["positional"],
	]) {
		assert.throws(
			() => validateDeployArgs(args),
			/Deploy argument|requires exactly|cannot use|dry-run accepts/i,
			JSON.stringify(args),
		);
	}
});

test("invalid deploy arguments are rejected before lock, log, build, or verifier", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-args-"));
	let called = false;
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "deploy",
				cwd: directory,
				deployArgs: ["--name", "wrong"],
				async runCommand() {
					called = true;
				},
				async verifyArtifact() {
					called = true;
				},
			}),
		/not allowed/i,
	);
	assert.equal(called, false);
	assert.equal(
		await pathIsMissing(join(directory, ".mail-portal-artifact.lock")),
		true,
	);
	assert.equal(await pathIsMissing(join(directory, "script-logs")), true);
});

test("the package has no raw shared-artifact build bypass", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8"));
	assert.equal(
		packageJson.scripts.build,
		"node scripts/run-environment-artifact.mjs whispyr build",
	);
	for (const name of [
		"build",
		"build:whispyr",
		"build:wiser",
		"deploy:whispyr",
		"deploy:wiser",
		"verify:env:whispyr",
		"verify:env:wiser",
	]) {
		assert.match(packageJson.scripts[name], /run-environment-artifact\.mjs/);
		assert.doesNotMatch(packageJson.scripts[name], /(^|\s)react-router build/);
	}
});

test("a guard lock still blocks a second operation after primary removal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-lock-remove-"));
	const lockPath = join(directory, ".mail-portal-artifact.lock");
	const buildStarted = deferred();
	const releaseBuild = deferred();
	let secondEntered = false;
	const first = quietRun({
		brand: "whispyr",
		mode: "build",
		cwd: directory,
		async runCommand() {
			buildStarted.resolve();
			await releaseBuild.promise;
		},
	});
	await buildStarted.promise;
	await unlink(lockPath);

	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: directory,
				async runCommand() {
					secondEntered = true;
				},
			}),
		/artifact operation is already in progress/i,
	);
	assert.equal(secondEntered, false);
	releaseBuild.resolve();
	await assert.rejects(first, /artifact lock integrity violation/i);
	assert.equal(await pathIsMissing(lockPath), true);
	assert.equal(await pathIsMissing(`${lockPath}.guard`), false);
});

for (const attack of ["replacement", "symlink", "mode", "hardlink"]) {
	test(`lock ${attack} attack fails closed and never unlinks attacker evidence`, async () => {
		const directory = await mkdtemp(
			join(tmpdir(), `mail-portal-lock-${attack}-`),
		);
		const lockPath = join(directory, ".mail-portal-artifact.lock");
		const attackerTarget = join(directory, "attacker-target");
		const hardlinkPath = join(directory, "attacker-hardlink");
		await assert.rejects(
			() =>
				quietRun({
					brand: "wiser",
					mode: "build",
					cwd: directory,
					async runCommand() {
						if (attack === "replacement") {
							await unlink(lockPath);
							await writeFile(lockPath, "attacker replacement", { mode: 0o600 });
						} else if (attack === "symlink") {
							await writeFile(attackerTarget, "attacker target", { mode: 0o600 });
							await unlink(lockPath);
							await symlink(attackerTarget, lockPath, "file");
						} else if (attack === "mode") {
							await chmod(lockPath, 0o644);
						} else {
							await link(lockPath, hardlinkPath);
						}
					},
				}),
			/artifact lock integrity violation/i,
		);
		assert.equal(await pathIsMissing(`${lockPath}.guard`), false);
		if (attack === "replacement") {
			assert.equal(await readFile(lockPath, "utf8"), "attacker replacement");
		} else if (attack === "symlink") {
			assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
			assert.equal(await readFile(attackerTarget, "utf8"), "attacker target");
		} else if (attack === "mode") {
			assert.equal((await stat(lockPath)).mode & 0o777, 0o644);
		} else {
			assert.equal((await stat(lockPath)).nlink, 2);
			assert.equal((await stat(hardlinkPath)).nlink, 2);
		}
	});
}

test("preexisting primary or guard lock evidence is preserved", async () => {
	const primaryDirectory = await mkdtemp(join(tmpdir(), "mail-portal-prelock-"));
	const primary = join(primaryDirectory, ".mail-portal-artifact.lock");
	await writeFile(primary, "primary evidence", { mode: 0o600 });
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: primaryDirectory,
				async runCommand() {},
			}),
		/already in progress/i,
	);
	assert.equal(await readFile(primary, "utf8"), "primary evidence");

	const guardDirectory = await mkdtemp(join(tmpdir(), "mail-portal-preguard-"));
	const guardPrimary = join(guardDirectory, ".mail-portal-artifact.lock");
	const guard = `${guardPrimary}.guard`;
	await writeFile(guard, "guard evidence", { mode: 0o600 });
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: guardDirectory,
				async runCommand() {},
			}),
		/already in progress/i,
	);
	assert.equal(await pathIsMissing(guardPrimary), true);
	assert.equal(await readFile(guard, "utf8"), "guard evidence");
});

test("failure cleanup removes both locks and redacts split output per stream", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-redaction-"));
	const logFilePath = join(directory, "operation.log");
	const stdoutSecret = "stdout-secret-that-must-not-leak";
	const stderrCredential = "stderr-bearer-that-must-not-leak";
	await assert.rejects(
		() =>
			quietRun({
				brand: "wiser",
				mode: "build",
				cwd: directory,
				logFilePath,
				env: { AWS_SECRET_ACCESS_KEY: stdoutSecret },
				async runCommand(_command, _args, options) {
					await Promise.all([
						options.onOutput(stdoutSecret.slice(0, 9), "stdout"),
						options.onOutput("Bearer stderr-", "stderr"),
					]);
					await Promise.all([
						options.onOutput(stdoutSecret.slice(9), "stdout"),
						options.onOutput("bearer-that-must-not-leak", "stderr"),
					]);
					throw new Error("build failed");
				},
			}),
		/build failed/,
	);
	const log = await readFile(logFilePath, "utf8");
	assert.doesNotMatch(log, new RegExp(stdoutSecret));
	assert.doesNotMatch(log, new RegExp(stderrCredential));
	assert.match(log, /\[REDACTED\]/);
	assert.equal((await stat(logFilePath)).mode & 0o777, 0o600);
	assert.equal(
		await pathIsMissing(join(directory, ".mail-portal-artifact.lock")),
		true,
	);
	assert.equal(
		await pathIsMissing(join(directory, ".mail-portal-artifact.lock.guard")),
		true,
	);
});

test("the private logger rejects existing files, symlinks, and public directories", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-log-path-"));
	const run = (logFilePath) =>
		quietRun({
			brand: "wiser",
			mode: "build",
			cwd: directory,
			logFilePath,
			async runCommand() {},
		});

	const existing = join(directory, "existing.log");
	await writeFile(existing, "preserve", { mode: 0o600 });
	await assert.rejects(() => run(existing), /EEXIST/);
	assert.equal(await readFile(existing, "utf8"), "preserve");

	const target = join(directory, "target.log");
	const linked = join(directory, "linked.log");
	await writeFile(target, "target", { mode: 0o600 });
	await symlink(target, linked, "file");
	await assert.rejects(() => run(linked), /EEXIST/);
	assert.equal(await readFile(target, "utf8"), "target");

	const publicDirectory = join(directory, "public-logs");
	await mkdir(publicDirectory, { mode: 0o755 });
	await chmod(publicDirectory, 0o755);
	await assert.rejects(
		() => run(join(publicDirectory, "operation.log")),
		/real 0700 directory/i,
	);
	assert.equal((await lstat(publicDirectory)).mode & 0o777, 0o755);

	const symlinkTarget = join(directory, "log-target");
	const symlinkDirectory = join(directory, "log-link");
	await mkdir(symlinkTarget, { mode: 0o700 });
	await symlink(symlinkTarget, symlinkDirectory, "dir");
	await assert.rejects(
		() => run(join(symlinkDirectory, "operation.log")),
		/real 0700 directory/i,
	);
});

async function waitForPath(path, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await pathIsMissing(path))) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

test("SIGHUP aborts the child, removes exact locks, and exits 129", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mail-portal-hup-"));
	const binaryDirectory = join(directory, "node_modules", ".bin");
	await mkdir(binaryDirectory, { recursive: true });
	const fakeBuilder = join(binaryDirectory, "react-router");
	await writeFile(
		fakeBuilder,
		`#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
		{ mode: 0o755 },
	);
	await chmod(fakeBuilder, 0o755);
	const lockPath = join(directory, ".mail-portal-artifact.lock");
	const child = spawn(process.execPath, [WRAPPER_PATH, "wiser", "build"], {
		cwd: directory,
		stdio: "ignore",
	});
	await waitForPath(`${lockPath}.guard`);
	child.kill("SIGHUP");
	const result = await new Promise((complete, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("SIGHUP child did not exit")),
			5_000,
		);
		child.once("error", reject);
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			complete({ code, signal });
		});
	});
	assert.deepEqual(result, { code: 129, signal: null });
	assert.equal(await pathIsMissing(lockPath), true);
	assert.equal(await pathIsMissing(`${lockPath}.guard`), true);
});
