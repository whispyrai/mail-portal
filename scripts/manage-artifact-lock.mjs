// Inspect or remove stale artifact-lock evidence after an uncatchable process
// termination. A kill can leave the pair or either single creation/release
// residue. Removal requires exact metadata from a prior inspection and
// revalidates every held inode and the expected topology before unlinking.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPrivateOperationLogger } from "./private-operation-logger.mjs";

const EXPECTED_UID = typeof process.getuid === "function" ? process.getuid() : null;

function sameInode(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function readHeldDescriptor(descriptor, size) {
	const bytes = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const count = readSync(descriptor, bytes, offset, size - offset, offset);
		if (count === 0) throw new Error("Lock changed while being inspected");
		offset += count;
	}
	return bytes;
}

function validateHeldPath(path, descriptor) {
	const advertised = lstatSync(path);
	const held = fstatSync(descriptor);
	for (const entry of [advertised, held]) {
		if (
			entry.isSymbolicLink() ||
			!entry.isFile() ||
			entry.nlink !== 1 ||
			(entry.mode & 0o777) !== 0o600 ||
			(EXPECTED_UID !== null && entry.uid !== EXPECTED_UID)
		) {
			throw new Error(
				`${path} is not an owned regular 0600 single-link lock file`,
			);
		}
	}
	if (!sameInode(advertised, held)) {
		throw new Error(`${path} no longer names the inspected inode`);
	}
	return held;
}

function parseMetadata(path, descriptor, expectedKind) {
	const held = validateHeldPath(path, descriptor);
	const bytes = readHeldDescriptor(descriptor, held.size);
	let metadata;
	try {
		metadata = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${path} does not contain valid lock JSON`);
	}
	if (
		metadata?.version !== 1 ||
		metadata?.kind !== expectedKind ||
		typeof metadata.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(metadata.token) ||
		!Number.isSafeInteger(metadata.pid) ||
		metadata.pid <= 0 ||
		!["whispyr", "wiser"].includes(metadata.brand) ||
		!["build", "verify", "deploy"].includes(metadata.mode) ||
		!Number.isSafeInteger(metadata.startedAt) ||
		metadata.startedAt <= 0
	) {
		throw new Error(`${path} lock metadata is invalid`);
	}
	return { metadata, bytes };
}

function openLock(path) {
	return openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
}

function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function assertPathMissing(path) {
	if (pathExists(path)) {
		throw new Error(`Unexpected sibling lock appeared at ${path}`);
	}
}

function processState(pid) {
	try {
		process.kill(pid, 0);
		return "active";
	} catch (error) {
		if (error?.code === "ESRCH") return "stale";
		if (error?.code === "EPERM") return "active";
		throw error;
	}
}

function openArtifactLockInspection(
	lockPath = resolve(".mail-portal-artifact.lock"),
) {
	const primaryPath = resolve(lockPath);
	const guardPath = `${primaryPath}.guard`;
	const primaryPresent = pathExists(primaryPath);
	const guardPresent = pathExists(guardPath);
	if (!primaryPresent && !guardPresent) {
		throw new Error("No artifact lock residue exists");
	}
	let primary;
	let guard;
	try {
		if (primaryPresent) {
			const descriptor = openLock(primaryPath);
			try {
				primary = {
					descriptor,
					...parseMetadata(primaryPath, descriptor, "primary"),
				};
			} catch (error) {
				closeSync(descriptor);
				throw error;
			}
		}
		if (guardPresent) {
			const descriptor = openLock(guardPath);
			try {
				guard = {
					descriptor,
					...parseMetadata(guardPath, descriptor, "guard"),
				};
			} catch (error) {
				closeSync(descriptor);
				throw error;
			}
		}
		if (!primary) assertPathMissing(primaryPath);
		if (!guard) assertPathMissing(guardPath);
		if (
			primary &&
			guard &&
			(primary.metadata.token !== guard.metadata.token ||
				primary.metadata.pid !== guard.metadata.pid ||
				primary.metadata.brand !== guard.metadata.brand ||
				primary.metadata.mode !== guard.metadata.mode ||
				primary.metadata.startedAt !== guard.metadata.startedAt)
		) {
			throw new Error("Primary and guard lock metadata do not match");
		}
		const authoritative = primary ?? guard;
		return {
			lockPath: primaryPath,
			guardPath,
			pid: authoritative.metadata.pid,
			brand: authoritative.metadata.brand,
			mode: authoritative.metadata.mode,
			startedAt: authoritative.metadata.startedAt,
			processState: processState(authoritative.metadata.pid),
			residueKind: primary && guard ? "pair" : primary ? "primary" : "guard",
			primary,
			guard,
		};
	} catch (error) {
		if (primary) closeSync(primary.descriptor);
		if (guard) closeSync(guard.descriptor);
		throw error;
	}
}

function closeInspection(inspection) {
	if (inspection.primary) closeSync(inspection.primary.descriptor);
	if (inspection.guard) closeSync(inspection.guard.descriptor);
}

function revalidateFile(path, file) {
	const held = validateHeldPath(path, file.descriptor);
	const actual = readHeldDescriptor(file.descriptor, held.size);
	if (!actual.equals(file.bytes)) {
		throw new Error(`${path} content changed after inspection`);
	}
}

function revalidateInspection(inspection) {
	if (inspection.primary) {
		revalidateFile(inspection.lockPath, inspection.primary);
	} else {
		assertPathMissing(inspection.lockPath);
	}
	if (inspection.guard) {
		revalidateFile(inspection.guardPath, inspection.guard);
	} else {
		assertPathMissing(inspection.guardPath);
	}
}

function publicInspection(inspection) {
	return {
		lockPath: inspection.lockPath,
		guardPath: inspection.guardPath,
		pid: inspection.pid,
		brand: inspection.brand,
		mode: inspection.mode,
		startedAt: inspection.startedAt,
		processState: inspection.processState,
		residueKind: inspection.residueKind,
	};
}

export function inspectArtifactLockResidue(
	lockPath = resolve(".mail-portal-artifact.lock"),
) {
	const inspection = openArtifactLockInspection(lockPath);
	try {
		return publicInspection(inspection);
	} finally {
		closeInspection(inspection);
	}
}

export const inspectArtifactLockPair = inspectArtifactLockResidue;

export function removeStaleArtifactLockResidue({
	lockPath = resolve(".mail-portal-artifact.lock"),
	expectedPid,
	expectedStartedAt,
}) {
	const inspection = openArtifactLockInspection(lockPath);
	try {
		if (inspection.processState !== "stale") {
			throw new Error(
				`Refusing removal because PID ${inspection.pid} is still active or inaccessible`,
			);
		}
		if (
			inspection.pid !== expectedPid ||
			inspection.startedAt !== expectedStartedAt
		) {
			throw new Error("Expected PID and startedAt do not match inspected locks");
		}
		revalidateInspection(inspection);
		if (processState(inspection.pid) !== "stale") {
			throw new Error(
				`Refusing removal because PID ${inspection.pid} became active`,
			);
		}
		if (inspection.primary) {
			revalidateFile(inspection.lockPath, inspection.primary);
			if (!inspection.guard) assertPathMissing(inspection.guardPath);
			unlinkSync(inspection.lockPath);
			if (fstatSync(inspection.primary.descriptor).nlink !== 0) {
				throw new Error("Primary lock path changed during removal");
			}
		}
		if (inspection.guard) {
			if (processState(inspection.pid) !== "stale") {
				throw new Error(
					`Refusing removal because PID ${inspection.pid} became active`,
				);
			}
			revalidateFile(inspection.guardPath, inspection.guard);
			assertPathMissing(inspection.lockPath);
			unlinkSync(inspection.guardPath);
			if (fstatSync(inspection.guard.descriptor).nlink !== 0) {
				throw new Error("Guard lock path changed during removal");
			}
		}
		return {
			pid: inspection.pid,
			brand: inspection.brand,
			mode: inspection.mode,
			startedAt: inspection.startedAt,
			residueKind: inspection.residueKind,
		};
	} finally {
		closeInspection(inspection);
	}
}

export const removeStaleArtifactLockPair = removeStaleArtifactLockResidue;

function parseArguments(argv) {
	let remove = false;
	let expectedPid;
	let expectedStartedAt;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--remove") remove = true;
		else if (argument === "--expected-pid") {
			expectedPid = Number(argv[++index]);
		} else if (argument === "--expected-started-at") {
			expectedStartedAt = Number(argv[++index]);
		} else {
			throw new Error(`Unknown artifact-lock argument: ${argument}`);
		}
	}
	if (
		remove &&
		(!Number.isSafeInteger(expectedPid) ||
			!Number.isSafeInteger(expectedStartedAt))
	) {
		throw new Error(
			"--remove requires --expected-pid and --expected-started-at from inspection",
		);
	}
	return { remove, expectedPid, expectedStartedAt };
}

const isDirectInvocation =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const logFilePath = join(
		process.cwd(),
		"script-logs",
		`artifact-lock-${timestamp}-${process.pid}-${randomBytes(6).toString("hex")}.log`,
	);
	let logger;
	try {
		const input = parseArguments(process.argv.slice(2));
		logger = await createPrivateOperationLogger({
			logFilePath,
			header: `artifact-lock\nmode=${input.remove ? "remove" : "inspect"}\nstarted_at=${new Date().toISOString()}`,
			stdout: console.log,
			stderr: console.error,
		});
		await logger.progress(`Detailed log: ${logFilePath}`);
		if (input.remove) {
			const result = removeStaleArtifactLockResidue(input);
			await logger.progress(
				`Removed exact stale ${result.residueKind} ${result.brand} ${result.mode} lock residue for PID ${result.pid} startedAt ${result.startedAt}`,
			);
		} else {
			const inspection = inspectArtifactLockResidue();
			await logger.progress(
				`Artifact ${inspection.residueKind} lock residue is ${inspection.processState}: PID ${inspection.pid}, brand ${inspection.brand}, mode ${inspection.mode}, startedAt ${inspection.startedAt}`,
			);
		}
	} catch (error) {
		await logger?.failure(
			error instanceof Error ? error.message : String(error),
		);
		process.exitCode = 1;
	} finally {
		await logger?.close();
	}
}
