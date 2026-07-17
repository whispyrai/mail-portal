import { open } from "node:fs/promises";

import { runSecretsEnvelopeCreator } from "./create-secrets-envelope.mjs";
import { REQUIRED_SECRETS } from "./verify-built-environment.mjs";

const stage = process.argv[4];

function pauseAt(stageName) {
	return async ({ signal }) => {
		process.stderr.write(
			`${stageName}-ready:${process.listenerCount("SIGTERM")}\n`,
		);
		await new Promise((_, reject) => {
			const keepAlive = setInterval(() => {}, 1_000);
			signal.addEventListener(
				"abort",
				() => {
					clearInterval(keepAlive);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	};
}

function waitForAbort(signal) {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolveAbort) => {
		const keepAlive = setInterval(() => {}, 1_000);
		signal.addEventListener(
			"abort",
			() => {
				clearInterval(keepAlive);
				resolveAbort();
			},
			{ once: true },
		);
	});
}

async function openDuringSignal({ path, flags, mode, signal }) {
	process.stderr.write(
		`open-ready:${process.listenerCount("SIGTERM")}\n`,
	);
	await waitForAbort(signal);
	const handle = await open(path, flags, mode);
	process.stderr.write("open-settled\n");
	return handle;
}

async function writeDuringSignal({ path, flags, mode, signal }) {
	const handle = await open(path, flags, mode);
	return {
		async writeFile(...args) {
			process.stderr.write(
				`write-ready:${process.listenerCount("SIGTERM")}\n`,
			);
			await waitForAbort(signal);
			await handle.writeFile(...args);
			process.stderr.write("write-settled\n");
		},
		chmod: (...args) => handle.chmod(...args),
		sync: () => handle.sync(),
		close: () => handle.close(),
	};
}

await runSecretsEnvelopeCreator({
	brand: process.argv[2],
	temporaryRoot: process.argv[3],
	secrets: Object.fromEntries(
		REQUIRED_SECRETS.map((name) => [name, process.env[name]]),
	),
	...(stage === "directory"
		? { afterDirectoryCreated: pauseAt("directory") }
		: stage === "artifact"
			? { beforePathOutput: pauseAt("artifact") }
			: stage === "open"
				? { openEnvelopeFile: openDuringSignal }
				: { openEnvelopeFile: writeDuringSignal }),
});
