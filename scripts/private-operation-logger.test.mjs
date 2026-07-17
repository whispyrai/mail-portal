import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPrivateOperationLogger } from "./private-operation-logger.mjs";

test("private operation logs are exclusive held 0600 files in a real 0700 directory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "private-operation-log-"));
	const logDirectory = join(directory, "logs");
	const logFilePath = join(logDirectory, "operation.log");
	const logger = await createPrivateOperationLogger({
		logFilePath,
		header: "header",
		stdout: () => {},
		stderr: () => {},
	});
	await logger.detail("preserved");
	assert.equal((await stat(logDirectory)).mode & 0o777, 0o700);
	assert.equal((await stat(logFilePath)).mode & 0o777, 0o600);
	await logger.close();
	assert.match(await readFile(logFilePath, "utf8"), /header\npreserved/);
	await assert.rejects(
		createPrivateOperationLogger({ logFilePath, header: "truncate" }),
		/EEXIST/,
	);
});

test("private operation logging rejects symlinks, public directories, and advertised-path substitution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "private-operation-hostile-"));
	const targetDirectory = join(directory, "target");
	const linkedDirectory = join(directory, "linked");
	await mkdir(targetDirectory, { mode: 0o700 });
	await symlink(targetDirectory, linkedDirectory, "dir");
	await assert.rejects(
		createPrivateOperationLogger({
			logFilePath: join(linkedDirectory, "operation.log"),
			header: "header",
		}),
		/real 0700 directory/i,
	);

	const publicDirectory = join(directory, "public");
	await mkdir(publicDirectory, { mode: 0o755 });
	await chmod(publicDirectory, 0o755);
	await assert.rejects(
		createPrivateOperationLogger({
			logFilePath: join(publicDirectory, "operation.log"),
			header: "header",
		}),
		/real 0700 directory/i,
	);

	const safeDirectory = join(directory, "safe");
	const logFilePath = join(safeDirectory, "operation.log");
	const logger = await createPrivateOperationLogger({
		logFilePath,
		header: "header",
		stdout: () => {},
		stderr: () => {},
	});
	const heldPath = `${logFilePath}.held`;
	await rename(logFilePath, heldPath);
	await symlink(heldPath, logFilePath, "file");
	await assert.rejects(logger.detail("must-not-follow"), /held file/i);
	await rm(logFilePath);
	await rename(heldPath, logFilePath);
	await logger.close().catch(() => {});

	const target = join(safeDirectory, "target.log");
	const linked = join(safeDirectory, "linked.log");
	await writeFile(target, "target", { mode: 0o600 });
	await symlink(target, linked, "file");
	await assert.rejects(
		createPrivateOperationLogger({ logFilePath: linked, header: "header" }),
		/EEXIST/,
	);
	assert.equal(await readFile(target, "utf8"), "target");
});
