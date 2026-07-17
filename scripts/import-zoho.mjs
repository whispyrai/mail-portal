#!/usr/bin/env node
// One-time Zoho to portal mail importer driver (WISER-241).

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import PostalMime from "postal-mime";
import {
	ImportIdentityCollisionError,
	ImportReconciliation,
	localImportIdentity,
	mapLocalZohoFolder,
	normalizeLocalZohoFolderPath,
} from "./import-zoho-reconciliation.mjs";

const EMPTY_SUMMARY = Object.freeze({
	sourceTotal: 0,
	resultTotal: 0,
	unprocessed: 0,
	imported: 0,
	duplicate: 0,
	excluded: 0,
	error: 0,
	identityCollisions: 0,
});

export function parseArgs(argv) {
	const allowed = new Set(["base", "email", "mailbox", "dir"]);
	const args = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const key = flag?.startsWith("--") ? flag.slice(2) : "";
		if (!key || !allowed.has(key) || argv[index + 1] === undefined) {
			throw new Error(`Unexpected or incomplete argument: ${flag ?? "(missing)"}`);
		}
		if (Object.hasOwn(args, key)) throw new Error(`Duplicate argument: --${key}`);
		args[key] = argv[index + 1];
	}
	const missing = ["base", "email", "mailbox", "dir"].filter((key) => !args[key]);
	if (missing.length > 0) {
		throw new Error(`Missing required args: ${missing.map((key) => `--${key}`).join(", ")}`);
	}
	return args;
}

function bounded(value, maximum = 500) {
	return String(value ?? "").replace(/[\r\n\t]+/g, " ").slice(0, maximum);
}

function summaryLine(verdict, tally) {
	return `${verdict} source_total=${tally.sourceTotal} result_total=${tally.resultTotal} unprocessed=${tally.unprocessed} imported=${tally.imported} duplicate=${tally.duplicate} excluded=${tally.excluded} error=${tally.error} identity_collisions=${tally.identityCollisions}`;
}

function boundedJson(value, maximum = 8_000) {
	try {
		return bounded(JSON.stringify(value), maximum);
	} catch {
		return "[unserializable endpoint result]";
	}
}

export async function createImportLogger({
	cwd = process.cwd(),
	now = new Date(),
	openFile = open,
} = {}) {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const suffix = randomBytes(6).toString("hex");
	const logDirectory = resolve(cwd, "script-logs");
	const logFilePath = join(
		logDirectory,
		`import-zoho-${timestamp}-${process.pid}-${suffix}.log`,
	);
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	const directoryBefore = await lstat(logDirectory);
	const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
	const directoryIsPrivate = (entry) =>
		!entry.isSymbolicLink() &&
		entry.isDirectory() &&
		(entry.mode & 0o777) === 0o700 &&
		(expectedUid === null || entry.uid === expectedUid);
	if (!directoryIsPrivate(directoryBefore)) {
		throw new Error("Private import log directory must be a real directory");
	}
	const canonicalDirectory = await realpath(logDirectory);
	const handle = await openFile(logFilePath, "wx", 0o600);
	let closed = false;
	let closedFileIdentity = null;
	const verifyOpenPath = async (openHandle, expectedIdentity = null) => {
		const [directory, advertisedFile, heldFile, canonicalFile] = await Promise.all([
			lstat(logDirectory),
			lstat(logFilePath),
			openHandle.stat(),
			realpath(logFilePath),
		]);
		if (
			!directoryIsPrivate(directory) ||
			directory.dev !== directoryBefore.dev ||
			directory.ino !== directoryBefore.ino ||
			advertisedFile.isSymbolicLink() ||
			!advertisedFile.isFile() ||
			!heldFile.isFile() ||
			advertisedFile.dev !== heldFile.dev ||
			advertisedFile.ino !== heldFile.ino ||
			(expectedIdentity !== null &&
				(heldFile.dev !== expectedIdentity.dev ||
					heldFile.ino !== expectedIdentity.ino)) ||
			advertisedFile.nlink !== 1 ||
			heldFile.nlink !== 1 ||
			(advertisedFile.mode & 0o777) !== 0o600 ||
			(heldFile.mode & 0o777) !== 0o600 ||
			(expectedUid !== null &&
				(advertisedFile.uid !== expectedUid || heldFile.uid !== expectedUid)) ||
			dirname(canonicalFile) !== canonicalDirectory
		) {
			throw new Error("Private import log path no longer names the held file");
		}
		return heldFile;
	};
	const verifyAdvertisedPath = () => verifyOpenPath(handle);
	const verifyClosedPath = async (heldFile) => {
		const [directory, advertisedFile, canonicalFile] = await Promise.all([
			lstat(logDirectory),
			lstat(logFilePath),
			realpath(logFilePath),
		]);
		if (
			!directoryIsPrivate(directory) ||
			directory.dev !== directoryBefore.dev ||
			directory.ino !== directoryBefore.ino ||
			advertisedFile.isSymbolicLink() ||
			!advertisedFile.isFile() ||
			advertisedFile.dev !== heldFile.dev ||
			advertisedFile.ino !== heldFile.ino ||
			advertisedFile.nlink !== 1 ||
			(advertisedFile.mode & 0o777) !== 0o600 ||
			(expectedUid !== null && advertisedFile.uid !== expectedUid) ||
			dirname(canonicalFile) !== canonicalDirectory
		) {
			throw new Error("Private import log path changed during finalization");
		}
	};
	const detail = async (message) => {
		if (closed) throw new Error("Private import log is already closed");
		await verifyAdvertisedPath();
		await handle.appendFile(`${bounded(message, 10_000)}\n`, "utf8");
		await handle.sync();
		await verifyAdvertisedPath();
	};
	try {
		await handle.chmod(0o600);
		await verifyAdvertisedPath();
		await detail(`import-zoho started_at=${now.toISOString()} mode=apply`);
	} catch (error) {
		await handle.close().catch(() => {});
		closed = true;
		throw error;
	}
	return {
		logFilePath,
		detail,
		async progress(message) {
			console.log(bounded(message, 2_000));
			await detail(message);
		},
		async failure(message) {
			console.error(bounded(message, 2_000));
			await detail(message);
		},
		async flush() {
			if (closed) throw new Error("Private import log is already closed");
			await verifyAdvertisedPath();
			await handle.sync();
			await verifyAdvertisedPath();
		},
		async close() {
			if (closed) return;
			await verifyAdvertisedPath();
			await handle.sync();
			const heldFile = await verifyAdvertisedPath();
			await handle.close();
			closed = true;
			await verifyClosedPath(heldFile);
			closedFileIdentity = heldFile;
		},
		async appendAfterClose(message) {
			if (!closed || closedFileIdentity === null) {
				throw new Error("Private import log has not completed secure close");
			}
			if (typeof fsConstants.O_NOFOLLOW !== "number") {
				throw new Error("Secure no-follow log reopen is unsupported");
			}
			await verifyClosedPath(closedFileIdentity);
			const reopenFlags =
				fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
			let reopened = await openFile(logFilePath, reopenFlags, 0o600);
			try {
				await verifyOpenPath(reopened, closedFileIdentity);
				await reopened.appendFile(`${bounded(message, 10_000)}\n`, "utf8");
				await reopened.sync();
				await verifyOpenPath(reopened, closedFileIdentity);
				await reopened.close();
				reopened = null;
				await verifyClosedPath(closedFileIdentity);
			} finally {
				await reopened?.close().catch(() => {});
			}
		},
	};
}

export async function login({
	base,
	email,
	password,
	fetchImpl = fetch,
	signal,
}) {
	const body = new URLSearchParams({ email, password });
	const response = await fetchImpl(`${base}/login`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
		redirect: "manual",
		signal,
	});
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie || response.status >= 400) {
		throw new Error(`Login failed (HTTP ${response.status}). Check credentials or base URL.`);
	}
	return setCookie.split(";")[0];
}

export async function* walkEml(directory, folderSegments = [], readDirectory = readdir) {
	for (const entry of await readDirectory(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			yield* walkEml(full, [...folderSegments, entry.name], readDirectory);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".eml")) {
			if (folderSegments.length === 0) {
				throw new Error(
					`Loose root .eml has no authoritative Zoho folder: ${entry.name}`,
				);
			}
			yield {
				path: full,
				folder: normalizeLocalZohoFolderPath(folderSegments.join("/")),
			};
		}
	}
}

export async function inspectLocalIdentity(bytes, mailboxId) {
	const rawSha256 = createHash("sha256").update(bytes).digest("hex");
	const parsed = await new PostalMime().parse(bytes);
	return localImportIdentity(mailboxId, rawSha256, parsed.messageId);
}

export async function importOne({
	base,
	mailboxId,
	cookie,
	file,
	fetchImpl = fetch,
	readFileImpl = readFile,
	signal,
}) {
	const bytes = await readFileImpl(file.path, { signal });
	const identity = await inspectLocalIdentity(bytes, mailboxId);
	if (signal?.aborted) throw signal.reason ?? new Error("Import request aborted");
	const expectedFolder = mapLocalZohoFolder(file.folder);
	const url = `${base}/admin/import/${encodeURIComponent(mailboxId)}?folder=${encodeURIComponent(file.folder)}`;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "message/rfc822", cookie },
		body: bytes,
		signal,
	});
	let json = {};
	try {
		json = await response.json();
	} catch {
		// The reconciliation contract treats every non-JSON response as an error.
	}
	return { expectedFolder, identity, result: { ...json, httpStatus: response.status } };
}

export async function runImport({
	argv = process.argv.slice(2),
	env = process.env,
	fetchImpl = fetch,
	loggerFactory = createImportLogger,
	readDirectory = readdir,
	readFileImpl = readFile,
	signals = process,
} = {}) {
	let logger;
	let reconciliation;
	let fatalError = null;
	let loggingFailed = false;
	let stopRequested = null;
	const files = [];
	const abortController = new AbortController();
	const requestStop = (signalName) => {
		if (stopRequested) return;
		stopRequested = signalName;
		abortController.abort(new Error(`Import interrupted by ${signalName}`));
		console.error(`Import stop requested by ${signalName}; no new source work will start.`);
	};
	const onSigint = () => requestStop("SIGINT");
	const onSigterm = () => requestStop("SIGTERM");
	signals.once("SIGINT", onSigint);
	signals.once("SIGTERM", onSigterm);
	const stopError = () => {
		const error = new Error(`Import stopped by ${stopRequested ?? "signal"}`);
		error.code = "IMPORT_STOP_REQUESTED";
		return error;
	};
	const throwIfStopped = () => {
		if (stopRequested) throw stopError();
	};
	const safeLog = async (method, message) => {
		if (!logger) return false;
		try {
			await logger[method](message);
			return true;
		} catch {
			loggingFailed = true;
			console.error("Private import logging failed; import will stop safely.");
			return false;
		}
	};
	const requireLog = async (method, message) => {
		if (await safeLog(method, message)) return;
		const error = new Error("Private import audit logging failed");
		error.code = "IMPORT_AUDIT_LOG_FAILED";
		throw error;
	};
	try {
		logger = await loggerFactory();
		await requireLog("progress", `Zoho import starting. mode=apply log=${logger.logFilePath}`);
		throwIfStopped();
		const args = parseArgs(argv);
		const password = env.IMPORT_PASSWORD;
		if (!password) {
			throw new Error("IMPORT_PASSWORD is required. Set it with a hidden shell prompt before running.");
		}
		const base = args.base.replace(/\/$/, "");
		await requireLog("progress", "Phase 1/3: authenticating and discovering source messages");
		throwIfStopped();
		const cookie = await login({
			base,
			email: args.email,
			password,
			fetchImpl,
			signal: abortController.signal,
		});
		throwIfStopped();
		for await (const file of walkEml(args.dir, [], readDirectory)) {
			throwIfStopped();
			files.push(file);
			if (files.length % 100 === 0) {
				await requireLog("progress", `Discovered ${files.length} source messages`);
			}
		}
		reconciliation = new ImportReconciliation(files.length, args.mailbox);
		await requireLog("progress", `Phase 2/3: importing source_total=${files.length} into the requested mailbox`);
		await requireLog("detail", `target_mailbox=${bounded(args.mailbox, 320)}`);
		await requireLog("detail", `source_directory=${bounded(resolve(args.dir), 1_000)}`);

		for (let index = 0; index < files.length; index += 1) {
			if (stopRequested) {
				fatalError = stopError();
				break;
			}
			let imported;
			try {
				imported = await importOne({
					base,
					mailboxId: args.mailbox,
					cookie,
					file: files[index],
					fetchImpl,
					readFileImpl,
					signal: abortController.signal,
				});
			} catch (error) {
				reconciliation.record(
					null,
					{ status: "transport-error", httpStatus: 0 },
					mapLocalZohoFolder(files[index]?.folder),
				);
				await requireLog(
					"failure",
					`Source #${index + 1} failed before a valid endpoint result was received.`,
				);
				await requireLog(
					"detail",
					`source=${index + 1} path=${bounded(files[index]?.path, 1_000)} transport_error=${bounded(error instanceof Error ? error.message : "unknown")}`,
				);
				if (stopRequested) {
					fatalError = stopError();
					break;
				}
				continue;
			}
			await requireLog("detail",
				`source=${index + 1} path=${bounded(files[index]?.path, 1_000)} source_folder=${bounded(files[index]?.folder, 200)} expected_folder=${bounded(imported.expectedFolder, 20)} server_folder=${bounded(imported.result.folder, 200)} http=${bounded(imported.result.httpStatus, 20)} status=${bounded(imported.result.status, 80)} reason=${bounded(imported.result.reason, 80)} local_identity_source=${imported.identity.identitySource} server_identity_source=${bounded(imported.result.identitySource, 80)} portal_id=${bounded(imported.result.id, 80)} raw_sha256=${imported.identity.rawSha256}`,
			);
			const errorsBefore = reconciliation.summary().error;
			let verificationError = null;
			try {
				reconciliation.record(
					imported.identity,
					imported.result,
					imported.expectedFolder,
				);
			} catch (error) {
				verificationError = error;
			}
			if (verificationError) {
				fatalError = verificationError;
				await safeLog(
					"detail",
					`source=${index + 1} unexpected_endpoint_result_json=${boundedJson(imported.result)}`,
				);
				const code = verificationError instanceof ImportIdentityCollisionError
					? verificationError.code
					: "IMPORT_RESULT_IDENTITY_UNVERIFIABLE";
				await safeLog("failure", `Source #${index + 1} failed closed (${code}).`);
				await safeLog(
					"detail",
					`source=${index + 1} verification_error=${bounded(verificationError instanceof Error ? verificationError.message : "unknown")}`,
				);
				break;
			}
			if (reconciliation.summary().error > errorsBefore) {
				await requireLog(
					"detail",
					`source=${index + 1} unexpected_endpoint_result_json=${boundedJson(imported.result)}`,
				);
				await requireLog(
					"failure",
					`Source #${index + 1} returned an invalid or unsuccessful endpoint contract (HTTP ${bounded(imported.result.httpStatus, 20)}).`,
				);
			}
			if ((index + 1) % 25 === 0 || index + 1 === files.length) {
				await requireLog("progress", `Imported progress ${index + 1}/${files.length}`);
			}
		}
		if (!fatalError) throwIfStopped();
		await requireLog("progress", "Phase 3/3: reconciling source and endpoint outcomes");
	} catch (error) {
		fatalError ??= error;
		if (logger) {
			await safeLog("failure", "Import failed before all source messages were reconciled.");
			await safeLog(
				"detail",
				`fatal_error=${bounded(error instanceof Error ? error.message : "unknown")}`,
			);
		} else {
			console.error("Import logger initialization failed.");
		}
	} finally {
		const baseTally = reconciliation?.summary() ?? {
			...EMPTY_SUMMARY,
			sourceTotal: files.length,
			unprocessed: files.length,
			error: fatalError ? 1 : 0,
		};
		let tally = {
			...baseTally,
			error: fatalError && baseTally.error === 0 ? 1 : baseTally.error,
		};
		if (loggingFailed && tally.error === 0) tally = { ...tally, error: 1 };
		let passed = !fatalError && !loggingFailed && tally.error === 0 && tally.unprocessed === 0 &&
			tally.sourceTotal === tally.resultTotal && tally.identityCollisions === 0;
		let line = summaryLine(passed ? "PASS" : "FAIL", tally);
		let finalizationFailed = false;
		let signalListenersRemoved = false;
		const removeSignalListeners = () => {
			if (signalListenersRemoved) return;
			signals.removeListener("SIGINT", onSigint);
			signals.removeListener("SIGTERM", onSigterm);
			signalListenersRemoved = true;
		};
		const markFailed = () => {
			passed = false;
			if (tally.error === 0) tally = { ...tally, error: 1 };
			line = summaryLine("FAIL", tally);
		};
		const flushLogger = async () => {
			if (typeof logger?.flush === "function") await logger.flush();
		};
		const appendFinalTruth = async () => {
			await logger.detail(line);
			await flushLogger();
		};
		const persistFailureAfterCloseOrOpen = async () => {
			let closedAppendError;
			if (typeof logger?.appendAfterClose === "function") {
				try {
					await logger.appendAfterClose(line);
					return;
				} catch (error) {
					closedAppendError = error;
				}
			}
			try {
				await appendFinalTruth();
			} catch (openAppendError) {
				throw closedAppendError ?? openAppendError;
			}
		};
		if (logger) {
			try {
				await appendFinalTruth();
				if (stopRequested && passed) {
					markFailed();
					await appendFinalTruth();
				}
				await logger.close();
				// Commit barrier: after physical close and path verification, either a
				// handled signal already exists and receives durable FAIL truth, or the
				// listeners are synchronously removed before another handler can run.
				if (stopRequested && passed) {
					markFailed();
					await persistFailureAfterCloseOrOpen();
				}
				removeSignalListeners();
			} catch {
				finalizationFailed = true;
				markFailed();
				let failureTruthPersisted = false;
				try {
					await persistFailureAfterCloseOrOpen();
					failureTruthPersisted = true;
				} catch {
					// Retry after close below in case the first close failed while open.
				}
				await logger.close().catch(() => {});
				if (!failureTruthPersisted && typeof logger.appendAfterClose === "function") {
					await logger.appendAfterClose(line).catch(() => {});
				}
				removeSignalListeners();
			}
		}
		removeSignalListeners();
		if (stopRequested && passed) {
			markFailed();
		}
		if (finalizationFailed) {
			markFailed();
			console.error("Private import log finalization failed.");
		}
		(passed ? console.log : console.error)(line);
		return passed ? 0 : 1;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
	process.exitCode = await runImport();
}
