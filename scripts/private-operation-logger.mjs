import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export async function createPrivateOperationLogger({
	logFilePath,
	header,
	stdout = console.log,
	stderr = console.error,
	sanitize = (value) => String(value),
	openFile = open,
}) {
	const logDirectory = dirname(logFilePath);
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	const directoryBefore = await lstat(logDirectory);
	const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
	const directoryIsPrivate = (entry) =>
		!entry.isSymbolicLink() &&
		entry.isDirectory() &&
		(entry.mode & 0o777) === 0o700 &&
		(expectedUid === null || entry.uid === expectedUid);
	if (!directoryIsPrivate(directoryBefore)) {
		throw new Error("Private operation log directory must be a real 0700 directory");
	}
	const canonicalDirectory = await realpath(logDirectory);
	const handle = await openFile(logFilePath, "wx", 0o600);
	let closed = false;

	const verifyOpenPath = async () => {
		const [directory, advertisedFile, heldFile, canonicalFile] = await Promise.all([
			lstat(logDirectory),
			lstat(logFilePath),
			handle.stat(),
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
			advertisedFile.nlink !== 1 ||
			heldFile.nlink !== 1 ||
			(advertisedFile.mode & 0o777) !== 0o600 ||
			(heldFile.mode & 0o777) !== 0o600 ||
			(expectedUid !== null &&
				(advertisedFile.uid !== expectedUid || heldFile.uid !== expectedUid)) ||
			dirname(canonicalFile) !== canonicalDirectory
		) {
			throw new Error("Private operation log path no longer names the held file");
		}
		return heldFile;
	};
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
			throw new Error("Private operation log path changed during close");
		}
	};

	let writes = Promise.resolve();
	const detail = (message) => {
		const pending = writes.then(async () => {
			if (closed) throw new Error("Private operation log is already closed");
			await verifyOpenPath();
			await handle.appendFile(`${sanitize(message)}\n`, "utf8");
			await handle.sync();
			await verifyOpenPath();
		});
		writes = pending.catch(() => {});
		return pending;
	};
	try {
		await handle.chmod(0o600);
		await verifyOpenPath();
		await detail(header);
	} catch (error) {
		closed = true;
		await handle.close().catch(() => {});
		throw error;
	}

	return {
		logFilePath,
		detail,
		async progress(message) {
			const safe = sanitize(message);
			stdout(safe);
			await detail(safe);
		},
		async failure(message) {
			const safe = sanitize(message);
			stderr(safe);
			await detail(safe);
		},
		async close() {
			if (closed) return;
			await writes;
			await verifyOpenPath();
			await handle.sync();
			const heldFile = await verifyOpenPath();
			await handle.close();
			closed = true;
			await verifyClosedPath(heldFile);
		},
	};
}
