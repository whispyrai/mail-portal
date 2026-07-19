// Serialize the brand-specific build artifact from build through verification
// and optional deployment. Both brands share build/server/wrangler.json, so the
// lock and immutable staging copy are deployment correctness boundaries.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { createPrivateOperationLogger } from "./private-operation-logger.mjs";
import {
	redactCompleteValue,
	StatefulSecretRedactor,
} from "./stateful-secret-redactor.mjs";
import {
	REQUIRED_SECRETS,
	verifyBuiltEnvironment,
} from "./verify-built-environment.mjs";

const BRANDS = new Set(["whispyr", "wiser"]);
const MODES = new Set(["build", "verify", "deploy"]);
const SECRET_NAME_PATTERN =
	/(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|RECOVERY_DIRECTORY)/i;
const SAFE_VALUE_FLAGS = new Set(["--outdir", "--secrets-file"]);
const EXPECTED_UID = typeof process.getuid === "function" ? process.getuid() : null;
const SECRETS_ENVELOPE_SCHEMA_VERSION = 1;
const MAX_SECRETS_ENVELOPE_BYTES = 64 * 1024;

function defaultLogFilePath(cwd, brand, mode, now = new Date()) {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const suffix = randomBytes(6).toString("hex");
	return join(
		cwd,
		"script-logs",
		`environment-artifact-${brand}-${mode}-${timestamp}-${process.pid}-${suffix}.log`,
	);
}

function secretValues(env) {
	return Object.entries(env)
		.filter(
			([name, value]) =>
				SECRET_NAME_PATTERN.test(name) &&
				typeof value === "string" &&
				value.length > 0,
		)
		.map(([, value]) => value)
		.sort((left, right) => right.length - left.length);
}

async function createLogger({
	brand,
	mode,
	logFilePath,
	stdout,
	stderr,
	secrets,
}) {
	return createPrivateOperationLogger({
		logFilePath,
		header: `environment-artifact\nbrand=${brand}\nmode=${mode}\nstarted_at=${new Date().toISOString()}`,
		stdout,
		stderr,
		sanitize: (message) => redactCompleteValue(message, secrets),
	});
}

async function safeLstat(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function isOwned(entry) {
	return EXPECTED_UID === null || entry.uid === EXPECTED_UID;
}

function assertRegularSingleLink(entry, label, expectedMode) {
	if (
		entry.isSymbolicLink() ||
		!entry.isFile() ||
		entry.nlink !== 1 ||
		!isOwned(entry) ||
		(expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode)
	) {
		throw new Error(
			`${label} must be an owned regular non-symlink single-link file${
				expectedMode === undefined
					? ""
					: ` with mode 0${expectedMode.toString(8)}`
			}`,
		);
	}
}

function assertRealDirectory(entry, label, expectedMode) {
	if (
		entry.isSymbolicLink() ||
		!entry.isDirectory() ||
		!isOwned(entry) ||
		(expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode)
	) {
		throw new Error(
			`${label} must be an owned real directory${
				expectedMode === undefined
					? ""
					: ` with mode 0${expectedMode.toString(8)}`
			}`,
		);
	}
}

function sameInode(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

async function readHeldFile(handle, size) {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("Held file has an invalid size");
	}
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			size - offset,
			offset,
		);
		if (bytesRead === 0) throw new Error("Held file changed while being read");
		offset += bytesRead;
	}
	return buffer;
}

async function inspectHeldRegularFile(path, handle, label, expectedMode) {
	const [advertised, held] = await Promise.all([lstat(path), handle.stat()]);
	assertRegularSingleLink(advertised, label, expectedMode);
	assertRegularSingleLink(held, label, expectedMode);
	if (!sameInode(advertised, held)) {
		throw new Error(`${label} path no longer names the held file`);
	}
	return held;
}

async function openExactRegularFile(path, label, expectedMode, maxBytes) {
	const handle = await open(
		path,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		const before = await inspectHeldRegularFile(
			path,
			handle,
			label,
			expectedMode,
		);
		if (maxBytes !== undefined && before.size > maxBytes) {
			throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
		}
		const bytes = await readHeldFile(handle, before.size);
		const after = await inspectHeldRegularFile(
			path,
			handle,
			label,
			expectedMode,
		);
		if (after.size !== before.size) {
			throw new Error(`${label} changed size while being read`);
		}
		return { handle, bytes, stat: after };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

function exactObjectKeys(value, expected) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((name, index) => name === wanted[index])
	);
}

async function readSecretsEnvelope(path, brand, cwd) {
	const resolvedPath = resolve(cwd, path);
	const opened = await openExactRegularFile(
		resolvedPath,
		"Secrets envelope",
		0o600,
		MAX_SECRETS_ENVELOPE_BYTES,
	);
	try {
		let envelope;
		try {
			envelope = JSON.parse(opened.bytes.toString("utf8"));
		} catch {
			throw new Error("Secrets envelope must contain valid JSON");
		}
		if (
			!exactObjectKeys(envelope, ["schemaVersion", "brand", "secrets"]) ||
			envelope.schemaVersion !== SECRETS_ENVELOPE_SCHEMA_VERSION ||
			envelope.brand !== brand ||
			!exactObjectKeys(envelope.secrets, REQUIRED_SECRETS)
		) {
			throw new Error(
				`Secrets envelope must be schema version ${SECRETS_ENVELOPE_SCHEMA_VERSION}, bound to ${brand}, and contain exactly the declared secret names`,
			);
		}
		for (const name of REQUIRED_SECRETS) {
			const value = envelope.secrets[name];
			if (typeof value !== "string" || value.length === 0) {
				throw new Error(`Secrets envelope value ${name} must be a non-empty string`);
			}
		}
		return {
			secrets: Object.fromEntries(
				REQUIRED_SECRETS.map((name) => [name, envelope.secrets[name]]),
			),
		};
	} finally {
		await opened.handle.close();
	}
}

function replaceSecretsFileArgument(deployArgs, path) {
	const replaced = [...deployArgs];
	const index = replaced.indexOf("--secrets-file");
	if (index < 0) return replaced;
	replaced[index + 1] = path;
	return replaced;
}

async function createPrivateWranglerSecretsFile(secrets) {
	const root = await mkdtemp(join(tmpdir(), "mail-portal-wrangler-secrets-"));
	await chmod(root, 0o700);
	const path = join(root, "secrets.json");
	const bytes = Buffer.from(JSON.stringify(secrets), "utf8");
	let handle;
	try {
		handle = await open(
			path,
			fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
			0o600,
		);
		await handle.writeFile(bytes);
		await handle.chmod(0o400);
		await handle.sync();
		await inspectHeldRegularFile(path, handle, "Wrangler secrets file", 0o400);
		return { root, path, handle, bytes };
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(path).catch(() => {});
		await rmdir(root).catch(() => {});
		throw error;
	}
}

async function removePrivateWranglerSecretsFile(file) {
	try {
		const held = await inspectHeldRegularFile(
			file.path,
			file.handle,
			"Wrangler secrets file",
			0o400,
		);
		const actual = await readHeldFile(file.handle, held.size);
		if (!actual.equals(file.bytes)) {
			throw new Error("Wrangler secrets file changed while deployed");
		}
		await unlink(file.path);
		const after = await file.handle.stat();
		if (after.nlink !== 0) {
			throw new Error("Wrangler secrets file path changed during cleanup");
		}
	} finally {
		await file.handle.close().catch(() => {});
	}
	await rmdir(file.root);
}

async function createPrivateWranglerOutdir() {
	const root = await mkdtemp(join(tmpdir(), "mail-portal-wrangler-out-"));
	await chmod(root, 0o700);
	const identity = await lstat(root);
	assertRealDirectory(identity, "Private Wrangler outdir", 0o700);
	return { root, identity };
}

async function removePrivateWranglerOutdir(directory) {
	const current = await lstat(directory.root);
	assertRealDirectory(current, "Private Wrangler outdir", 0o700);
	if (!sameInode(current, directory.identity)) {
		throw new Error("Private Wrangler outdir path changed during deployment");
	}
	await rm(directory.root, { recursive: true, force: false });
}

async function validateArtifactAncestors(cwd, artifactPath) {
	const cwdEntry = await lstat(cwd);
	assertRealDirectory(cwdEntry, "Working directory");
	for (const directory of [
		join(cwd, "build"),
		join(cwd, "build", "server"),
	]) {
		const entry = await safeLstat(directory);
		if (!entry) return false;
		assertRealDirectory(entry, `Generated artifact ancestor ${directory}`);
	}
	if (dirname(artifactPath) !== join(cwd, "build", "server")) {
		throw new Error("Generated artifact escaped its expected directory");
	}
	return true;
}

async function invalidateGeneratedArtifact(cwd, artifactPath) {
	if (!(await validateArtifactAncestors(cwd, artifactPath))) return;
	const entry = await safeLstat(artifactPath);
	if (!entry) return;
	assertRegularSingleLink(entry, "Prior generated artifact");
	const { handle } = await openExactRegularFile(
		artifactPath,
		"Prior generated artifact",
	);
	try {
		await inspectHeldRegularFile(
			artifactPath,
			handle,
			"Prior generated artifact",
		);
		await unlink(artifactPath);
		const after = await handle.stat();
		if (after.nlink !== 0) {
			throw new Error(
				"Prior generated artifact path changed during invalidation",
			);
		}
	} finally {
		await handle.close();
	}
}

async function requireFreshGeneratedArtifact(cwd, artifactPath) {
	if (!(await validateArtifactAncestors(cwd, artifactPath))) {
		throw new Error("Build did not create build/server/wrangler.json");
	}
	if (!(await safeLstat(artifactPath))) {
		throw new Error("Build did not create build/server/wrangler.json");
	}
	const opened = await openExactRegularFile(
		artifactPath,
		"Fresh generated artifact",
	);
	await opened.handle.close();
	return opened.bytes;
}

async function createHeldLockFile(path, metadata) {
	let handle;
	try {
		handle = await open(
			path,
			fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
			0o600,
		);
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(
				`A mail portal artifact operation is already in progress (${path})`,
			);
		}
		throw error;
	}
	const bytes = Buffer.from(JSON.stringify(metadata), "utf8");
	try {
		await handle.writeFile(bytes);
		await handle.chmod(0o600);
		await handle.sync();
		return { path, handle, bytes };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

async function assertHeldLock(file) {
	let advertised;
	try {
		advertised = await lstat(file.path);
	} catch (error) {
		throw new Error(
			`Artifact lock integrity violation at ${file.path}: ${error.message}`,
		);
	}
	const held = await file.handle.stat();
	try {
		assertRegularSingleLink(advertised, "Artifact lock", 0o600);
		assertRegularSingleLink(held, "Artifact lock", 0o600);
	} catch (error) {
		throw new Error(
			`Artifact lock integrity violation at ${file.path}: ${error.message}`,
		);
	}
	if (!sameInode(advertised, held) || held.size !== file.bytes.length) {
		throw new Error(
			`Artifact lock integrity violation at ${file.path}: inode or size changed`,
		);
	}
	const actual = await readHeldFile(file.handle, held.size);
	if (!actual.equals(file.bytes)) {
		throw new Error(
			`Artifact lock integrity violation at ${file.path}: token changed`,
		);
	}
}

async function closeWithoutUnlink(file) {
	await file?.handle.close().catch(() => {});
}

async function unlinkExactHeldLock(file) {
	await assertHeldLock(file);
	await unlink(file.path);
	const after = await file.handle.stat();
	if (after.nlink !== 0) {
		throw new Error(
			`Artifact lock integrity violation at ${file.path}: path changed during release`,
		);
	}
	await file.handle.close();
}

async function acquireLock(lockPath, brand, mode) {
	const token = randomBytes(32).toString("hex");
	const common = {
		version: 1,
		token,
		pid: process.pid,
		brand,
		mode,
		startedAt: Date.now(),
	};
	const primary = await createHeldLockFile(lockPath, {
		...common,
		kind: "primary",
	});
	const guardPath = `${lockPath}.guard`;
	let guard;
	try {
		guard = await createHeldLockFile(guardPath, {
			...common,
			kind: "guard",
		});
		await Promise.all([assertHeldLock(primary), assertHeldLock(guard)]);
	} catch (error) {
		if (guard) {
			await unlinkExactHeldLock(guard).catch(() => closeWithoutUnlink(guard));
		}
		await unlinkExactHeldLock(primary).catch(() => closeWithoutUnlink(primary));
		throw error;
	}

	let released = false;
	return {
		guardPath,
		async assertHeld() {
			if (released) throw new Error("Artifact lock was already released");
			await assertHeldLock(primary);
			await assertHeldLock(guard);
		},
		async release() {
			if (released) return;
			released = true;
			try {
				await assertHeldLock(primary);
				await assertHeldLock(guard);
				await unlinkExactHeldLock(primary);
				await assertHeldLock(guard);
				await unlinkExactHeldLock(guard);
			} catch (error) {
				await closeWithoutUnlink(primary);
				await closeWithoutUnlink(guard);
				throw new Error(
					`Artifact lock release failed closed. Inspect ${guardPath} before any stale-lock removal. ${error.message}`,
				);
			}
		},
	};
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function assertStableDirectory(path, expected) {
	const current = await lstat(path);
	assertRealDirectory(current, `Generated directory ${path}`);
	if (!sameInode(current, expected)) {
		throw new Error(`Generated directory ${path} changed during staging`);
	}
}

async function copyGeneratedTree(
	sourceRoot,
	destinationRoot,
	manifest,
	stageRoot = destinationRoot,
) {
	const sourceDirectory = await lstat(sourceRoot);
	assertRealDirectory(sourceDirectory, `Generated build directory ${sourceRoot}`);
	const entries = (await readdir(sourceRoot)).sort();
	for (const name of entries) {
		if (name === "." || name === ".." || name.includes(sep)) {
			throw new Error("Generated build contains an invalid entry name");
		}
		const sourcePath = join(sourceRoot, name);
		const destinationPath = join(destinationRoot, name);
		const sourceEntry = await lstat(sourcePath);
		const relativePath = relative(stageRoot, destinationPath);
		if (sourceEntry.isSymbolicLink()) {
			throw new Error(`Generated build contains a symlink: ${sourcePath}`);
		}
		if (sourceEntry.isDirectory()) {
			assertRealDirectory(sourceEntry, `Generated directory ${sourcePath}`);
			await mkdir(destinationPath, { mode: 0o700 });
			await copyGeneratedTree(
				sourcePath,
				destinationPath,
				manifest,
				stageRoot,
			);
			await chmod(destinationPath, 0o500);
			manifest.set(`${relativePath}/`, { kind: "directory", mode: 0o500 });
			continue;
		}
		assertRegularSingleLink(sourceEntry, `Generated file ${sourcePath}`);
		const opened = await openExactRegularFile(
			sourcePath,
			`Generated file ${sourcePath}`,
		);
		try {
			const destination = await open(destinationPath, "wx", 0o600);
			try {
				await destination.writeFile(opened.bytes);
				await destination.sync();
				await destination.chmod(0o400);
			} finally {
				await destination.close();
			}
			manifest.set(relativePath, {
				kind: "file",
				mode: 0o400,
				size: opened.bytes.length,
				sha256: digest(opened.bytes),
			});
		} finally {
			await opened.handle.close();
		}
	}
	await assertStableDirectory(sourceRoot, sourceDirectory);
}

async function collectStagedTree(root, current, actual) {
	const entries = (await readdir(current)).sort();
	for (const name of entries) {
		const path = join(current, name);
		const relativePath = relative(root, path);
		const entry = await lstat(path);
		if (entry.isSymbolicLink()) {
			throw new Error(`Staged artifact contains a symlink: ${relativePath}`);
		}
		if (entry.isDirectory()) {
			assertRealDirectory(entry, `Staged directory ${relativePath}`, 0o500);
			actual.set(`${relativePath}/`, { kind: "directory", mode: 0o500 });
			await collectStagedTree(root, path, actual);
			continue;
		}
		const opened = await openExactRegularFile(
			path,
			`Staged file ${relativePath}`,
			0o400,
		);
		try {
			actual.set(relativePath, {
				kind: "file",
				mode: 0o400,
				size: opened.bytes.length,
				sha256: digest(opened.bytes),
			});
		} finally {
			await opened.handle.close();
		}
	}
}

function manifestsEqual(expected, actual) {
	if (expected.size !== actual.size) return false;
	for (const [path, expectedEntry] of expected) {
		if (JSON.stringify(actual.get(path)) !== JSON.stringify(expectedEntry)) {
			return false;
		}
	}
	return true;
}

async function verifyStagedArtifact(stage) {
	const rootEntry = await lstat(stage.root);
	assertRealDirectory(rootEntry, "Staged artifact root", 0o500);
	if (!sameInode(rootEntry, stage.rootIdentity)) {
		throw new Error("Staged artifact root inode changed");
	}
	const actual = new Map();
	await collectStagedTree(stage.root, stage.root, actual);
	if (!manifestsEqual(stage.manifest, actual)) {
		throw new Error(
			`Staged artifact bytes or topology changed. Evidence retained at ${stage.root}`,
		);
	}
}

async function createStagedArtifact(cwd, stagingParent) {
	const sourceRoot = join(cwd, "build");
	const parent = resolve(stagingParent ?? tmpdir());
	const parentEntry = await lstat(parent);
	assertRealDirectory(parentEntry, "Artifact staging parent");
	const root = await mkdtemp(join(parent, "mail-portal-artifact-"));
	await chmod(root, 0o700);
	const manifest = new Map();
	try {
		await copyGeneratedTree(sourceRoot, root, manifest);
		if (!manifest.has("server/wrangler.json")) {
			throw new Error("Staged build is missing server/wrangler.json");
		}
		await chmod(root, 0o500);
		const rootIdentity = await lstat(root);
		const stage = {
			root,
			rootIdentity,
			manifest,
			artifactPath: join(root, "server", "wrangler.json"),
		};
		await verifyStagedArtifact(stage);
		return stage;
	} catch (error) {
		await chmod(root, 0o700).catch(() => {});
		await rm(root, { recursive: true, force: false }).catch(() => {});
		throw error;
	}
}

async function makeStagedTreeWritable(current) {
	await chmod(current, 0o700);
	for (const name of await readdir(current)) {
		const path = join(current, name);
		const entry = await lstat(path);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			await makeStagedTreeWritable(path);
		} else if (entry.isFile() && !entry.isSymbolicLink()) {
			await chmod(path, 0o600);
		}
	}
}

async function removeStagedArtifact(stage) {
	await verifyStagedArtifact(stage);
	await makeStagedTreeWritable(stage.root);
	await rm(stage.root, { recursive: true, force: false });
}

export async function spawnCommand(command, args, options) {
	await new Promise((complete, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
		});
		options.onChild?.(child);
		const states = [
			{ name: "stdout", stream: child.stdout, decoder: new StringDecoder("utf8") },
			{ name: "stderr", stream: child.stderr, decoder: new StringDecoder("utf8") },
		].map((state) => ({ ...state, chain: Promise.resolve(), ended: false }));
		for (const state of states) {
			state.stream.on("data", (chunk) => {
				const decoded = state.decoder.write(chunk);
				state.chain = state.chain.then(() =>
					decoded ? options.onOutput(decoded, state.name) : undefined,
				);
			});
			state.stream.once("end", () => {
				state.ended = true;
				const decoded = state.decoder.end();
				state.chain = state.chain.then(() =>
					decoded ? options.onOutput(decoded, state.name) : undefined,
				);
			});
		}
		let spawnError = null;
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", async (code, signal) => {
			try {
				for (const state of states) {
					if (!state.ended) {
						state.ended = true;
						const decoded = state.decoder.end();
						state.chain = state.chain.then(() =>
							decoded ? options.onOutput(decoded, state.name) : undefined,
						);
					}
				}
				await Promise.all(states.map((state) => state.chain));
				if (spawnError) reject(spawnError);
				else if (code === 0) complete();
				else {
					reject(
						new Error(
							`${command} exited ${signal ? `after ${signal}` : `with code ${code}`}`,
						),
					);
				}
			} catch (error) {
				reject(error);
			} finally {
				options.onChild?.(null);
			}
		});
	});
}

export function validateDeployArgs(deployArgs) {
	const normalized = [];
	const seen = new Set();
	for (let index = 0; index < deployArgs.length; index += 1) {
		const argument = deployArgs[index];
		if (typeof argument !== "string" || argument.length === 0) {
			throw new Error("Deploy arguments must be non-empty strings");
		}
		if (argument === "--") {
			throw new Error("Deploy arguments cannot use -- or positional arguments");
		}
		if (!argument.startsWith("--")) {
			throw new Error(`Deploy argument is not allowed: ${argument}`);
		}
		const equalsIndex = argument.indexOf("=");
		const flag = equalsIndex < 0 ? argument : argument.slice(0, equalsIndex);
		const inlineValue =
			equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1);
		if (seen.has(flag)) {
			throw new Error(`Deploy argument cannot be repeated: ${flag}`);
		}
		seen.add(flag);

		if (flag === "--dry-run") {
			if (inlineValue !== undefined && inlineValue !== "true") {
				throw new Error("--dry-run accepts no value other than =true");
			}
			normalized.push("--dry-run");
			continue;
		}
		if (!SAFE_VALUE_FLAGS.has(flag)) {
			throw new Error(`Deploy argument is not allowed: ${flag}`);
		}
		let value = inlineValue;
		if (value === undefined) {
			index += 1;
			value = deployArgs[index];
		}
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value === "-" ||
			value.startsWith("--") ||
			value.includes("\0")
		) {
			throw new Error(`${flag} requires exactly one safe path value`);
		}
		normalized.push(flag, value);
	}
	return normalized;
}

export async function runEnvironmentArtifact({
	brand,
	mode,
	deployArgs = [],
	cwd = process.cwd(),
	env = process.env,
	lockPath = join(cwd, ".mail-portal-artifact.lock"),
	logFilePath = defaultLogFilePath(cwd, brand, mode),
	stagingParent,
	stdout = console.log,
	stderr = console.error,
	runCommand = spawnCommand,
	verifyArtifact = verifyBuiltEnvironment,
	signal,
	onChild,
	onBeforeDeploy,
}) {
	if (!BRANDS.has(brand)) throw new Error("brand must be whispyr or wiser");
	if (!MODES.has(mode)) throw new Error("mode must be build, verify, or deploy");
	const resolvedCwd = resolve(cwd);
	const safeDeployArgs =
		mode === "deploy" ? validateDeployArgs(deployArgs) : [];
	const secretsFileIndex = safeDeployArgs.indexOf("--secrets-file");
	const secretsEnvelope =
		secretsFileIndex < 0
			? null
			: await readSecretsEnvelope(
					safeDeployArgs[secretsFileIndex + 1],
					brand,
					resolvedCwd,
				);
	const resolvedLockPath = resolve(lockPath);
	const resolvedLogFilePath = resolve(logFilePath);
	const generatedArtifactPath = join(
		resolvedCwd,
		"build",
		"server",
		"wrangler.json",
	);
	const buildEnvironment = {
		...process.env,
		...env,
		CLOUDFLARE_ENV: brand,
	};
	// React Router resolves the named brand into a flat generated configuration.
	// Passing the selector to Wrangler again would suffix the already-resolved
	// Worker name and deploy to a different Worker.
	const deployEnvironment = { ...buildEnvironment };
	delete deployEnvironment.CLOUDFLARE_ENV;
	const secrets = [
		...secretValues(buildEnvironment),
		...Object.values(secretsEnvelope?.secrets ?? {}),
	].sort((left, right) => right.length - left.length);
	const lock = await acquireLock(resolvedLockPath, brand, mode);
	let logger;
	let stage;
	let wranglerSecretsFile;
	let wranglerOutdir;
	let operationError = null;
	try {
		await lock.assertHeld();
		logger = await createLogger({
			brand,
			mode,
			logFilePath: resolvedLogFilePath,
			stdout,
			stderr,
			secrets,
		});
		await logger.progress(`Locked shared deployment artifact for ${brand}`);
		await logger.progress(`Detailed log: ${resolvedLogFilePath}`);
		const execute = async (
			label,
			command,
			args,
			commandEnvironment = buildEnvironment,
		) => {
			signal?.throwIfAborted();
			await lock.assertHeld();
			await logger.progress(label);
			await logger.detail(`command=${command} args=${JSON.stringify(args)}`);
			const output = new Map([
				["stdout", new StatefulSecretRedactor(secrets)],
				["stderr", new StatefulSecretRedactor(secrets)],
			]);
			const onOutput = async (chunk, streamName = "stdout") => {
				const redactor = output.get(streamName);
				if (!redactor) throw new Error(`Unknown child output stream: ${streamName}`);
				const safe = redactor.write(chunk);
				if (safe) await logger.detail(safe);
			};
			try {
				await runCommand(command, args, {
					cwd: resolvedCwd,
					env: commandEnvironment,
					onChild,
					onOutput,
					signal,
				});
			} finally {
				for (const redactor of output.values()) {
					const safe = redactor.flush();
					if (safe) await logger.detail(safe);
				}
			}
			signal?.throwIfAborted();
			await lock.assertHeld();
		};

		await invalidateGeneratedArtifact(resolvedCwd, generatedArtifactPath);
		await lock.assertHeld();
		await execute(
			`Phase 1/${mode === "build" ? 1 : mode === "verify" ? 2 : 3}: building ${brand}`,
			join(resolvedCwd, "node_modules", ".bin", "react-router"),
			["build"],
		);
		await requireFreshGeneratedArtifact(resolvedCwd, generatedArtifactPath);
		await lock.assertHeld();

		if (mode !== "build") {
			stage = await createStagedArtifact(resolvedCwd, stagingParent);
			await verifyStagedArtifact(stage);
			await lock.assertHeld();
			await logger.progress(
				`Phase 2/${mode === "verify" ? 2 : 3}: verifying immutable generated configuration`,
			);
			await verifyArtifact({
				brand,
				artifactPath: stage.artifactPath,
				logFilePath: `${resolvedLogFilePath}.verifier.log`,
				stdout: logger.detail,
				stderr: logger.detail,
			});
			signal?.throwIfAborted();
			await lock.assertHeld();
			await verifyStagedArtifact(stage);
		}
			if (mode === "deploy") {
			await onBeforeDeploy?.({
				stageRoot: stage.root,
				artifactPath: stage.artifactPath,
			});
				await lock.assertHeld();
				await verifyStagedArtifact(stage);
				let exactDeployArgs = safeDeployArgs;
				if (!exactDeployArgs.includes("--outdir")) {
					wranglerOutdir = await createPrivateWranglerOutdir();
					exactDeployArgs = [
						...exactDeployArgs,
						"--outdir",
						wranglerOutdir.root,
					];
				}
				if (secretsEnvelope) {
					wranglerSecretsFile = await createPrivateWranglerSecretsFile(
						secretsEnvelope.secrets,
					);
					exactDeployArgs = replaceSecretsFileArgument(
						exactDeployArgs,
						wranglerSecretsFile.path,
					);
				}
				try {
					await execute(
						"Phase 3/3: deploying the exact verified immutable configuration",
						join(resolvedCwd, "node_modules", ".bin", "wrangler"),
						["deploy", "--config", stage.artifactPath, ...exactDeployArgs],
						deployEnvironment,
					);
				} finally {
					if (wranglerSecretsFile) {
						const file = wranglerSecretsFile;
						wranglerSecretsFile = null;
						await removePrivateWranglerSecretsFile(file);
					}
					if (wranglerOutdir) {
						const directory = wranglerOutdir;
						wranglerOutdir = null;
						await removePrivateWranglerOutdir(directory);
					}
				}
			await verifyStagedArtifact(stage);
			await lock.assertHeld();
		}
		if (stage) {
			await removeStagedArtifact(stage);
			stage = null;
		}
		await logger.progress(`${brand} ${mode} operation complete`);
		return { logFilePath: resolvedLogFilePath };
		} catch (error) {
			operationError = error;
			if (wranglerSecretsFile) {
				const file = wranglerSecretsFile;
				wranglerSecretsFile = null;
				try {
					await removePrivateWranglerSecretsFile(file);
				} catch (cleanupError) {
					await logger?.detail(
						`Private Wrangler secrets cleanup failed closed: ${cleanupError.message}`,
					);
				}
			}
			if (wranglerOutdir) {
				const directory = wranglerOutdir;
				wranglerOutdir = null;
				try {
					await removePrivateWranglerOutdir(directory);
				} catch (cleanupError) {
					await logger?.detail(
						`Private Wrangler outdir cleanup failed closed: ${cleanupError.message}`,
					);
				}
			}
		if (stage) {
			try {
				await removeStagedArtifact(stage);
				stage = null;
			} catch (cleanupError) {
				await logger?.detail(
					`Staged artifact retained for integrity investigation: ${stage.root}. ${cleanupError.message}`,
				);
			}
		}
		if (logger) {
			const message = error instanceof Error ? error.message : String(error);
			await logger.detail(`FAILED: ${message}`).catch(() => {});
			await logger
				.failure(`${brand} ${mode} operation failed. See ${resolvedLogFilePath}`)
				.catch(() => {});
		}
		throw error;
	} finally {
		let finalizationError = null;
		try {
			await logger?.close();
		} catch (error) {
			finalizationError = error;
		}
		try {
			await lock.release();
		} catch (error) {
			finalizationError ??= error;
		}
		if (!operationError && finalizationError) throw finalizationError;
	}
}

function parseArguments(argv) {
	const [brand, mode, ...deployArgs] = argv;
	return { brand, mode, deployArgs };
}

const isDirectInvocation =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
	const abortController = new AbortController();
	let child = null;
	let receivedSignal = null;
	const stop = (signalName) => {
		if (receivedSignal) return;
		receivedSignal = signalName;
		abortController.abort(new Error(`Interrupted by ${signalName}`));
		child?.kill(signalName);
	};
	const signalHandlers = new Map([
		["SIGHUP", () => stop("SIGHUP")],
		["SIGINT", () => stop("SIGINT")],
		["SIGTERM", () => stop("SIGTERM")],
	]);
	for (const [signalName, handler] of signalHandlers) {
		process.once(signalName, handler);
	}
	try {
		await runEnvironmentArtifact({
			...parseArguments(process.argv.slice(2)),
			signal: abortController.signal,
			onChild(value) {
				child = value;
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(redactCompleteValue(message, secretValues(process.env)));
		process.exitCode =
			receivedSignal === "SIGHUP"
				? 129
				: receivedSignal === "SIGINT"
					? 130
					: receivedSignal
						? 143
						: 1;
	} finally {
		for (const [signalName, handler] of signalHandlers) {
			process.removeListener(signalName, handler);
		}
	}
}
