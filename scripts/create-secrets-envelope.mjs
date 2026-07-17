// Create a private brand-bound secrets envelope from inherited environment
// values. Secret bytes never appear in argv or output, and JSON.stringify owns
// all escaping, including the nested ACCOUNT_RECOVERY_DIRECTORY JSON string.

import { constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REQUIRED_SECRETS } from "./verify-built-environment.mjs";

const BRANDS = new Set(["whispyr", "wiser"]);
const CREATOR_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];

function throwIfCreatorAborted(signal) {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new Error("Secrets envelope creation interrupted");
	}
}

async function removeSecretsEnvelopeArtifact(path, directory) {
	if (path) {
		try {
			await unlink(path);
		} catch (error) {
			if (!(error && error.code === "ENOENT")) throw error;
		}
	}
	if (directory) {
		try {
			await rmdir(directory);
		} catch (error) {
			if (!(error && error.code === "ENOENT")) throw error;
		}
	}
}

function exactSecrets(secrets) {
	const actual = Object.keys(secrets).sort();
	const required = [...REQUIRED_SECRETS].sort();
	if (
		actual.length !== required.length ||
		actual.some((name, index) => name !== required[index])
	) {
		throw new Error("Secrets input must contain exactly the declared secret names");
	}
	for (const name of REQUIRED_SECRETS) {
		if (typeof secrets[name] !== "string" || secrets[name].length === 0) {
			throw new Error(`Missing non-empty environment secret: ${name}`);
		}
	}
	return Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, secrets[name]]));
}

export async function createSecretsEnvelope({
	brand,
	secrets,
	temporaryRoot = tmpdir(),
	signal,
	afterDirectoryCreated,
	onArtifactCreated,
	openEnvelopeFile = ({ path, flags, mode }) => open(path, flags, mode),
}) {
	throwIfCreatorAborted(signal);
	if (!BRANDS.has(brand)) throw new Error("brand must be whispyr or wiser");
	const envelope = {
		schemaVersion: 1,
		brand,
		secrets: exactSecrets(secrets),
	};
	let directory;
	let path;
	let handle;
	try {
			directory = await mkdtemp(
				join(resolve(temporaryRoot), `${brand}-mail-portal-secrets-`),
			);
			await afterDirectoryCreated?.({ directory, signal });
			throwIfCreatorAborted(signal);
			path = join(directory, "envelope.json");
			await onArtifactCreated?.({ directory, path, signal });
			throwIfCreatorAborted(signal);
			await chmod(directory, 0o700);
			throwIfCreatorAborted(signal);
			handle = await openEnvelopeFile({
				path,
				flags:
					fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
				mode: 0o600,
				signal,
			});
			throwIfCreatorAborted(signal);
			await handle.writeFile(JSON.stringify(envelope), "utf8");
			throwIfCreatorAborted(signal);
			await handle.chmod(0o600);
			throwIfCreatorAborted(signal);
			await handle.sync();
			throwIfCreatorAborted(signal);
			await handle.close();
			handle = null;
			throwIfCreatorAborted(signal);
			return path;
	} catch (error) {
		await handle?.close().catch(() => {});
		await removeSecretsEnvelopeArtifact(path, directory);
		throw error;
	}
}

export async function runSecretsEnvelopeCreator({
	brand,
	secrets,
	temporaryRoot = tmpdir(),
	afterDirectoryCreated,
	onArtifactCreated,
	beforePathOutput,
	openEnvelopeFile,
}) {
	const controller = new AbortController();
	let pendingSignal = null;
	let artifact = null;
	let terminating = false;
	let terminationBarrier = null;
	const handlers = new Map();
	const removeSignalHandlers = () => {
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
	};
	const reRaiseSignal = (signal) => {
		terminating = true;
		removeSignalHandlers();
		const keepAlive = setInterval(() => {}, 1_000);
		terminationBarrier = new Promise(() => {});
		try {
			process.kill(process.pid, signal);
		} catch (error) {
			clearInterval(keepAlive);
			terminationBarrier = null;
			terminating = false;
			throw error;
		}
	};
	for (const signal of CREATOR_SIGNALS) {
		const handler = () => {
			if (pendingSignal) return;
			pendingSignal = signal;
			controller.abort(new Error("Secrets envelope creation interrupted"));
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	try {
		const path = await createSecretsEnvelope({
			brand,
			secrets,
			temporaryRoot,
			signal: controller.signal,
			afterDirectoryCreated,
			openEnvelopeFile,
			async onArtifactCreated(createdArtifact) {
				artifact = createdArtifact;
				await onArtifactCreated?.(createdArtifact);
			},
		});
		throwIfCreatorAborted(controller.signal);
		await beforePathOutput?.({ ...artifact, signal: controller.signal });
		throwIfCreatorAborted(controller.signal);
		await new Promise((resolveOutput, rejectOutput) => {
			const handleOutputError = (error) => {
				process.stdout.off("error", handleOutputError);
				rejectOutput(error);
			};
			process.stdout.once("error", handleOutputError);
			process.stdout.write(`${path}\n`, () => {
				process.stdout.off("error", handleOutputError);
				resolveOutput();
			});
		});
		throwIfCreatorAborted(controller.signal);
		artifact = null;
		return path;
	} catch (error) {
		await removeSecretsEnvelopeArtifact(artifact?.path, artifact?.directory);
		if (pendingSignal) {
			if (!terminating) reRaiseSignal(pendingSignal);
			await terminationBarrier;
		}
		throw error;
	} finally {
		if (!terminating) removeSignalHandlers();
	}
}

const isDirectInvocation =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
	try {
		if (process.argv.length !== 3) {
			throw new Error("Usage: node scripts/create-secrets-envelope.mjs BRAND");
		}
		await runSecretsEnvelopeCreator({
			brand: process.argv[2],
			secrets: Object.fromEntries(
				REQUIRED_SECRETS.map((name) => [name, process.env[name]]),
			),
		});
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Secrets envelope creation failed"}\n`,
		);
		process.exitCode = 1;
	}
}
