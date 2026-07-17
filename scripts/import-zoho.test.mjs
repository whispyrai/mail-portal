import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
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
import {
	createImportLogger,
	inspectLocalIdentity,
	runImport,
	walkEml,
} from "./import-zoho.mjs";

test("local PostalMime inspection owns identity-kind selection from exact bytes", async () => {
	const withMessageId = Buffer.from(
		"From: sender@example.com\r\nMessage-ID: <owned@example.com>\r\n\r\nBody",
	);
	const withoutMessageId = Buffer.from("From: sender@example.com\r\n\r\nBody");
	assert.equal(
		(await inspectLocalIdentity(withMessageId, "team@example.com")).identitySource,
		"message-id",
	);
	assert.equal(
		(await inspectLocalIdentity(withoutMessageId, "team@example.com")).identitySource,
		"raw-sha256",
	);
});

test("source discovery rejects loose root EMLs and preserves complete relative folders", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-folders-"));
	try {
		await mkdir(join(directory, "Trash", "2024"), { recursive: true });
		await mkdir(join(directory, "Customers", "Receipts"), { recursive: true });
		await writeFile(join(directory, "Trash", "2024", "lost.eml"), "lost");
		await writeFile(join(directory, "Customers", "Receipts", "kept.eml"), "kept");
		const discovered = [];
		for await (const file of walkEml(directory)) discovered.push(file);
		assert.deepEqual(
			discovered.map(({ folder }) => folder).sort(),
			["Customers/Receipts", "Trash/2024"],
		);

		await writeFile(join(directory, "loose.eml"), "ambiguous");
		await assert.rejects(async () => {
			for await (const _file of walkEml(directory)) {
				// Exhaust discovery so a loose file cannot evade validation.
			}
		}, /loose root \.eml/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private import logs use a held exclusive 0600 file and cannot be truncated", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-log-"));
	try {
		const logger = await createImportLogger({ cwd: directory });
		assert.equal((await stat(logger.logFilePath)).mode & 0o777, 0o600);
		await assert.rejects(open(logger.logFilePath, "wx", 0o600), /EEXIST/);
		await logger.detail("preserved-line");
		await logger.close();
		assert.match(await readFile(logger.logFilePath, "utf8"), /preserved-line/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private logging rejects a symlink directory and closes on initial append failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-log-hardening-"));
	try {
		const target = join(directory, "target");
		await mkdir(target);
		await symlink(target, join(directory, "script-logs"), "dir");
		await assert.rejects(
			createImportLogger({ cwd: directory }),
			/real directory/i,
		);
		await rm(join(directory, "script-logs"));

		let closed = false;
		await assert.rejects(
			createImportLogger({
				cwd: directory,
				openFile: async (...args) => {
					const actual = await open(...args);
					return {
						chmod: (...chmodArgs) => actual.chmod(...chmodArgs),
						stat: (...statArgs) => actual.stat(...statArgs),
						async appendFile() { throw new Error("controlled append failure"); },
						async close() {
							closed = true;
							await actual.close();
						},
					};
				},
			}),
			/controlled append failure/,
		);
		assert.equal(closed, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private logging rejects non-private directories and advertised-path substitution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-log-substitution-"));
	try {
		const logDirectory = join(directory, "script-logs");
		await mkdir(logDirectory, { mode: 0o755 });
		await chmod(logDirectory, 0o755);
		await assert.rejects(
			createImportLogger({ cwd: directory }),
			/private import log directory/i,
		);
		await chmod(logDirectory, 0o700);

		const logger = await createImportLogger({ cwd: directory });
		const heldPath = `${logger.logFilePath}.held`;
		await rename(logger.logFilePath, heldPath);
		await writeFile(logger.logFilePath, "decoy", { mode: 0o600 });
		await assert.rejects(logger.detail("must-not-hit-decoy"), /held file/i);
		await rm(logger.logFilePath);
		await symlink(heldPath, logger.logFilePath, "file");
		await assert.rejects(logger.detail("must-not-follow-symlink"), /held file/i);
		await rm(logger.logFilePath);
		await rename(heldPath, logger.logFilePath);
		await logger.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private logging detects a decoy swapped in during append", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-log-race-"));
	try {
		let swapped = false;
		await assert.rejects(
			createImportLogger({
				cwd: directory,
				openFile: async (path, ...args) => {
					const actual = await open(path, ...args);
					return {
						chmod: (...values) => actual.chmod(...values),
						stat: (...values) => actual.stat(...values),
						sync: (...values) => actual.sync(...values),
						async appendFile(...values) {
							await actual.appendFile(...values);
							if (!swapped) {
								swapped = true;
								await rename(path, `${path}.held`);
								await writeFile(path, "decoy", { mode: 0o600 });
							}
						},
						close: (...values) => actual.close(...values),
					};
				},
			}),
			/held file/i,
		);
		assert.equal(swapped, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("fallible argument validation still writes and closes a bounded FAIL summary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-args-"));
	let logPath = "";
	try {
		const exitCode = await runImport({
			argv: ["--unknown", "value"],
			env: {},
			loggerFactory: async () => {
				const logger = await createImportLogger({ cwd: directory });
				logPath = logger.logFilePath;
				return logger;
			},
		});
		assert.equal(exitCode, 1);
		const log = await readFile(logPath, "utf8");
		assert.match(
			log,
			/FAIL source_total=0 result_total=0 unprocessed=0 imported=0 duplicate=0 excluded=0 error=1 identity_collisions=0/,
		);
		await open(logPath, "a").then((handle) => handle.close());
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing password and authentication failure both emit final FAIL verdicts", async () => {
	for (const scenario of ["password", "authentication"]) {
		const lines = [];
		let closed = false;
		const logger = {
			logFilePath: "private.log",
			async detail(line) { lines.push(String(line)); },
			async progress(line) { lines.push(String(line)); },
			async failure(line) { lines.push(String(line)); },
			async close() { closed = true; },
		};
		const exitCode = await runImport({
			argv: [
				"--base", "https://mail.example.com",
				"--email", "admin@example.com",
				"--mailbox", "team@example.com",
				"--dir", "/unused",
			],
			env: scenario === "password" ? {} : { IMPORT_PASSWORD: "secret" },
			loggerFactory: async () => logger,
			fetchImpl: async () => new Response("denied", { status: 401 }),
		});
		assert.equal(exitCode, 1);
		assert.equal(closed, true);
		assert.match(lines.at(-1), /^FAIL source_total=0 result_total=0 /);
	}
});

test("a complete run accepts exact endpoint contracts and emits PASS totals", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-pass-"));
	const exportDirectory = join(directory, "export");
	let logPath = "";
	try {
		await mkdir(join(exportDirectory, "Inbox"), { recursive: true });
		await mkdir(join(exportDirectory, "Trash", "2024"), { recursive: true });
		const included = Buffer.from(
			"From: sender@example.com\r\nMessage-ID: <pass@example.com>\r\n\r\nBody",
		);
		const excluded = Buffer.from("From: spam@example.com\r\n\r\nSpam");
		await writeFile(join(exportDirectory, "Inbox", "included.eml"), included);
		await writeFile(join(exportDirectory, "Trash", "2024", "excluded.eml"), excluded);
		const includedIdentity = await inspectLocalIdentity(included, "team@example.com");
		const fetchImpl = async (url) => {
			if (String(url).endsWith("/login")) {
				return new Response(null, {
					status: 302,
					headers: { "set-cookie": "session=test; Path=/; HttpOnly" },
				});
			}
			if (String(url).includes("folder=Trash%2F2024")) {
				return Response.json(
					{ status: "skipped", reason: "excluded-folder", folder: "Trash/2024" },
					{ status: 200 },
				);
			}
			return Response.json({
				status: "imported",
				id: includedIdentity.portalId,
				identitySource: includedIdentity.identitySource,
				folder: "inbox",
			}, { status: 201 });
		};
		const exitCode = await runImport({
			argv: [
				"--base", "https://mail.example.com",
				"--email", "admin@example.com",
				"--mailbox", "team@example.com",
				"--dir", exportDirectory,
			],
			env: { IMPORT_PASSWORD: "secret" },
			fetchImpl,
			loggerFactory: async () => {
				const logger = await createImportLogger({ cwd: directory });
				logPath = logger.logFilePath;
				return logger;
			},
		});
		assert.equal(exitCode, 0);
		assert.match(
			await readFile(logPath, "utf8"),
			/PASS source_total=2 result_total=2 unprocessed=0 imported=1 duplicate=0 excluded=1 error=0 identity_collisions=0/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("handled signals stop new source work, record FAIL, and close the log", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-signal-"));
	const exportDirectory = join(directory, "export", "Inbox");
	const signals = new EventEmitter();
	const lines = [];
	let closed = false;
	let importRequests = 0;
	try {
		await mkdir(exportDirectory, { recursive: true });
		await writeFile(join(exportDirectory, "one.eml"), "From: one@example.com\r\n\r\nOne");
		await writeFile(join(exportDirectory, "two.eml"), "From: two@example.com\r\n\r\nTwo");
		const exitCode = await runImport({
			argv: [
				"--base", "https://mail.example.com",
				"--email", "admin@example.com",
				"--mailbox", "team@example.com",
				"--dir", join(directory, "export"),
			],
			env: { IMPORT_PASSWORD: "secret" },
			signals,
			loggerFactory: async () => ({
				logFilePath: "private.log",
				async detail(line) { lines.push(String(line)); },
				async progress(line) { lines.push(String(line)); },
				async failure(line) { lines.push(String(line)); },
				async close() { closed = true; },
			}),
			fetchImpl: async (url) => {
				if (String(url).endsWith("/login")) {
					return new Response(null, {
						status: 302,
						headers: { "set-cookie": "session=test" },
					});
				}
				importRequests += 1;
				signals.emit("SIGINT");
				throw new Error("controlled abort");
			},
		});
		assert.equal(exitCode, 1);
		assert.equal(importRequests, 1);
		assert.equal(closed, true);
		assert.match(lines.at(-1), /^FAIL source_total=2 result_total=1 unprocessed=1 /);
		assert.equal(signals.listenerCount("SIGINT"), 0);
		assert.equal(signals.listenerCount("SIGTERM"), 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("signals during PASS write, flush, or close leave FAIL as the last durable truth", async () => {
	for (const phase of ["detail", "flush", "close"]) {
		const directory = await mkdtemp(join(tmpdir(), `import-zoho-final-${phase}-`));
		const signals = new EventEmitter();
		const lines = [];
		let injected = false;
		let closed = false;
		try {
			const exitCode = await runImport({
				argv: [
					"--base", "https://mail.example.com",
					"--email", "admin@example.com",
					"--mailbox", "team@example.com",
					"--dir", directory,
				],
				env: { IMPORT_PASSWORD: "secret" },
				signals,
				loggerFactory: async () => ({
					logFilePath: "private.log",
					async detail(line) {
						lines.push(String(line));
						if (!injected && phase === "detail" && String(line).startsWith("PASS ")) {
							injected = true;
							signals.emit("SIGINT");
						}
					},
					async progress(line) { lines.push(String(line)); },
					async failure(line) { lines.push(String(line)); },
					async flush() {
						if (!injected && phase === "flush" && lines.at(-1)?.startsWith("PASS ")) {
							injected = true;
							signals.emit("SIGTERM");
						}
					},
					async close() {
						if (!injected && phase === "close") {
							injected = true;
							signals.emit("SIGINT");
						}
						closed = true;
					},
					async appendAfterClose(line) {
						lines.push(String(line));
					},
				}),
				fetchImpl: async () => new Response(null, {
					status: 302,
					headers: { "set-cookie": "session=test" },
				}),
			});
			assert.equal(exitCode, 1, phase);
			assert.equal(injected, true, phase);
			assert.equal(closed, true, phase);
			assert.match(lines.at(-1), /^FAIL /, phase);
			assert.equal(signals.listenerCount("SIGINT"), 0, phase);
			assert.equal(signals.listenerCount("SIGTERM"), 0, phase);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("the real logger handles a signal after physical close and durably appends FAIL", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-real-close-signal-"));
	const signals = new EventEmitter();
	let logPath = "";
	let listenersAtClose = -1;
	let emittedWasHandled = false;
	try {
		const exitCode = await runImport({
			argv: [
				"--base", "https://mail.example.com",
				"--email", "admin@example.com",
				"--mailbox", "team@example.com",
				"--dir", directory,
			],
			env: { IMPORT_PASSWORD: "secret" },
			signals,
			loggerFactory: async () => {
				const logger = await createImportLogger({
					cwd: directory,
					openFile: async (path, flags, mode) => {
						const actual = await open(path, flags, mode);
						if (flags !== "wx") return actual;
						return {
							chmod: (...values) => actual.chmod(...values),
							stat: (...values) => actual.stat(...values),
							appendFile: (...values) => actual.appendFile(...values),
							sync: (...values) => actual.sync(...values),
							async close() {
								await actual.close();
								listenersAtClose = signals.listenerCount("SIGINT");
								emittedWasHandled = signals.emit("SIGINT");
							},
						};
					},
				});
				logPath = logger.logFilePath;
				return logger;
			},
			fetchImpl: async () => new Response(null, {
				status: 302,
				headers: { "set-cookie": "session=test" },
			}),
		});
		assert.equal(exitCode, 1);
		assert.equal(listenersAtClose, 1);
		assert.equal(emittedWasHandled, true);
		const physicalLines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
		assert.match(physicalLines.at(-1), /^FAIL /);
		assert.equal(signals.listenerCount("SIGINT"), 0);
		assert.equal(signals.listenerCount("SIGTERM"), 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unexpected endpoint JSON stays complete in the private log and off terminal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "import-zoho-private-result-"));
	const exportDirectory = join(directory, "export", "Inbox");
	let logPath = "";
	const terminal = [];
	const originalLog = console.log;
	const originalError = console.error;
	try {
		await mkdir(exportDirectory, { recursive: true });
		const bytes = Buffer.from(
			"From: sender@example.com\r\nMessage-ID: <private-result@example.com>\r\n\r\nBody",
		);
		await writeFile(join(exportDirectory, "message.eml"), bytes);
		const identity = await inspectLocalIdentity(bytes, "team@example.com");
		console.log = (...values) => terminal.push(values.join(" "));
		console.error = (...values) => terminal.push(values.join(" "));
		const exitCode = await runImport({
			argv: [
				"--base", "https://mail.example.com",
				"--email", "admin@example.com",
				"--mailbox", "team@example.com",
				"--dir", join(directory, "export"),
			],
			env: { IMPORT_PASSWORD: "secret" },
			loggerFactory: async () => {
				const logger = await createImportLogger({ cwd: directory });
				logPath = logger.logFilePath;
				return logger;
			},
			fetchImpl: async (url) => String(url).endsWith("/login")
				? new Response(null, {
						status: 302,
						headers: { "set-cookie": "session=test" },
					})
				: Response.json({
						status: "imported",
						id: identity.portalId,
						identitySource: "message-id",
						folder: "inbox",
						unexpected: { secret: "private-evidence" },
					}, { status: 500 }),
		});
		assert.equal(exitCode, 1);
		const privateLog = await readFile(logPath, "utf8");
		assert.match(privateLog, /"secret":"private-evidence"/);
		assert.doesNotMatch(terminal.join("\n"), /private-evidence|unexpected_endpoint/);
	} finally {
		console.log = originalLog;
		console.error = originalError;
		await rm(directory, { recursive: true, force: true });
	}
});

test("summary, detail, and close errors produce a controlled nonzero result", async () => {
	let closeAttempts = 0;
	const exitCode = await runImport({
		argv: ["--invalid", "value"],
		env: {},
		loggerFactory: async () => ({
			logFilePath: "private.log",
			async progress() {},
			async failure() {},
			async detail() { throw new Error("controlled detail failure"); },
			async close() {
				closeAttempts += 1;
				throw new Error("controlled close failure");
			},
		}),
	});
	assert.equal(exitCode, 1);
	assert.equal(closeAttempts, 1);
});
