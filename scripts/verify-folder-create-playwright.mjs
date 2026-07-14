import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const logDirectory = join(root, "script-logs");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logFilePath = join(logDirectory, `folder-create-playwright-${runStamp}.log`);
const mailboxId = "playwright-folder-create@wiserchat.ai";
const password = "LocalMailPortal!2026";
const playwrightConfigPath = join(root, "scripts", "wrangler-folder-create-playwright.jsonc");
let interruptedSignal;

mkdirSync(logDirectory, { recursive: true });

function logLine(channel, message) {
	appendFileSync(logFilePath, `${new Date().toISOString()} ${channel} ${message}\n`);
}

function progress(message) {
	console.log(message);
	logLine("PROGRESS", message);
}

function detail(message) {
	logLine("DETAIL", message);
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function localEnvironment(overrides = {}) {
	const inheritedNames = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
		"USER",
		"LOGNAME",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TERM",
		"NO_COLOR",
	];
	const environment = {};
	for (const name of inheritedNames) {
		if (process.env[name]) environment[name] = process.env[name];
	}
	return { ...environment, ...overrides };
}

async function freePort() {
	const server = createServer();
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	);
	return address.port;
}

async function waitForServer(baseUrl, serverProcess) {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
			throw new Error(
				`Wiser test server exited with ${serverProcess.exitCode ?? serverProcess.signalCode}`,
			);
		}
		try {
			const remaining = deadline - Date.now();
			const response = await fetch(`${baseUrl}/login`, {
				signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
			});
			if (response.ok) return;
		} catch {
			// The server has not bound its port yet.
		}
		await delay(250);
	}
	throw new Error("Wiser test server did not become ready within 45 seconds");
}

async function runSetupCommand(command, args, environment, onProcess) {
	const child = spawn(command, args, {
		cwd: root,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	onProcess(child);
	child.stdout.on("data", (chunk) => detail(`setup stdout ${chunk}`));
	child.stderr.on("data", (chunk) => detail(`setup stderr ${chunk}`));
	try {
		const { exitCode, signalCode } = await new Promise((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) =>
				resolveExit({ exitCode: code, signalCode: signal }),
			);
		});
		if (exitCode !== 0) {
			throw new Error(
				`${command} ${args.join(" ")} exited with ${exitCode ?? signalCode}`,
			);
		}
	} finally {
		onProcess(undefined);
	}
}

function deferred() {
	let release;
	const promise = new Promise((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release: () => release() };
}

function processGroupExists(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return false;
		throw error;
	}
}

function signalProcessGroup(processGroupId, signal) {
	try {
		process.kill(-processGroupId, signal);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return;
		throw error;
	}
}

async function waitForProcessGroupExit(processGroupId, timeoutMilliseconds) {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		if (!processGroupExists(processGroupId)) return true;
		await delay(50);
	}
	return !processGroupExists(processGroupId);
}

async function stopServer(serverProcess) {
	if (!serverProcess.pid || !processGroupExists(serverProcess.pid)) return;
	signalProcessGroup(serverProcess.pid, "SIGTERM");
	if (await waitForProcessGroupExit(serverProcess.pid, 5_000)) return;
	signalProcessGroup(serverProcess.pid, "SIGKILL");
	if (!(await waitForProcessGroupExit(serverProcess.pid, 5_000))) {
		throw new Error(`Wiser test server process group ${serverProcess.pid} did not stop`);
	}
}

async function authenticate(browser, baseUrl) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
	await page.getByLabel("Email").fill(mailboxId);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
	const storageState = await context.storageState();
	await context.close();
	return storageState;
}

async function openMobileSidebar(page) {
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const close = page.getByRole("button", { name: "Close sidebar" });
		if (await close.isVisible()) return;
		try {
			await page
				.getByRole("button", { name: "Toggle sidebar" })
				.click({ timeout: 3_000 });
			await close.waitFor({ timeout: 3_000 });
			await page.waitForTimeout(500);
			if (await close.isVisible()) return;
		} catch (error) {
			detail(`mobile sidebar hydration attempt ${attempt}: ${error}`);
		}
		await page.waitForTimeout(750);
	}
	throw new Error("Mobile Sidebar did not remain open after client hydration");
}

async function openCreateFolderDialog(page) {
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const dialog = page.getByRole("dialog", { name: "Create folder" });
		if (await dialog.isVisible()) return dialog;
		try {
			await page
				.getByRole("button", { name: "Create new folder" })
				.click({ timeout: 3_000 });
			await dialog.waitFor({ timeout: 3_000 });
			return dialog;
		} catch (error) {
			detail(`create dialog hydration attempt ${attempt}: ${error}`);
		}
		await page.waitForTimeout(750);
	}
	throw new Error("Create folder dialog did not open after client hydration");
}

async function verifyViewport({ browser, baseUrl, storageState, name, viewport }) {
	const context = await browser.newContext({ viewport, storageState });
	const page = await context.newPage();
	page.setDefaultTimeout(10_000);
	const unexpectedBrowserErrors = [];
	const postBodies = [];
	let postCount = 0;
	let folderReads = 0;
	let created = false;
	const postResponseGates = [deferred(), deferred()];

	page.on("console", (message) => {
		if (message.type() !== "error") return;
		const expected = [
			"status of 503 (Service Unavailable)",
			"Failed to fetch manifest patches",
			"Mutation failed: ApiError: Folder service temporarily unavailable",
		];
		if (!expected.some((fragment) => message.text().includes(fragment))) {
			unexpectedBrowserErrors.push(`console: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) =>
		unexpectedBrowserErrors.push(`page: ${error.message}`),
	);

	await page.route("**/api/v1/mailboxes/*/folders", async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		if (pathname !== `/api/v1/mailboxes/${mailboxId}/folders`) {
			await route.continue();
			return;
		}
		if (request.method() === "GET") {
			folderReads += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(
					created
						? [{ id: "folder-client-projects", name: "Client Projects", unreadCount: 0 }]
						: [],
				),
			});
			return;
		}
		if (request.method() !== "POST") {
			await route.continue();
			return;
		}

		postCount += 1;
		postBodies.push(request.postDataJSON());
		const responseGate = postResponseGates[postCount - 1];
		assert.ok(responseGate, `Unexpected folder POST ${postCount}`);
		await responseGate.promise;
		if (postCount === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "Folder service temporarily unavailable" }),
			});
			return;
		}

		created = true;
		await route.fulfill({
			status: 201,
			contentType: "application/json",
			body: JSON.stringify({
				id: "folder-client-projects",
				name: "Client Projects",
				unreadCount: 0,
			}),
		});
	});

	try {
		await page.goto(
			`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
			{ waitUntil: "networkidle" },
		);
		await page.waitForTimeout(1_000);
		if (name === "mobile") {
			await openMobileSidebar(page);
		}

		const dialog = await openCreateFolderDialog(page);
		const input = dialog.getByLabel("Folder name");
		await input.fill("Client Projects");
		await dialog.getByRole("button", { name: "Create" }).click();
		await dialog.getByRole("button", { name: "Creating" }).waitFor();
		assert.equal(await input.inputValue(), "Client Projects");
		assert.equal(await input.isDisabled(), true);
		assert.equal(
			await dialog.getByRole("button", { name: "Cancel" }).isDisabled(),
			true,
		);
		await page.keyboard.press("Escape");
		assert.equal(await dialog.isVisible(), true);

		const pendingBox = await dialog.boundingBox();
		assert.ok(pendingBox);
		assert.ok(pendingBox.x >= 0 && pendingBox.y >= 0);
		assert.ok(pendingBox.x + pendingBox.width <= viewport.width);
		assert.ok(pendingBox.y + pendingBox.height <= viewport.height);

		postResponseGates[0].release();
		await page.getByText("Folder service temporarily unavailable").waitFor();
		assert.equal(await dialog.isVisible(), true);
		assert.equal(await input.inputValue(), "Client Projects");
		assert.equal(await input.isEnabled(), true);
		assert.equal(
			await dialog.getByRole("button", { name: "Create" }).isEnabled(),
			true,
		);
		if (name === "mobile") {
			const createBox = await dialog
				.getByRole("button", { name: "Create" })
				.boundingBox();
			const cancelBox = await dialog
				.getByRole("button", { name: "Cancel" })
				.boundingBox();
			assert.ok(createBox && cancelBox);
			assert.ok(createBox.width >= pendingBox.width - 48);
			assert.ok(cancelBox.width >= pendingBox.width - 48);
		}
		await page.screenshot({
			path: join(logDirectory, `folder-create-${runStamp}-${name}-failure.png`),
			fullPage: true,
		});

		await dialog.getByRole("button", { name: "Create" }).click();
		await dialog.getByRole("button", { name: "Creating" }).waitFor();
		assert.equal(await input.inputValue(), "Client Projects");
		assert.equal(await input.isDisabled(), true);
		postResponseGates[1].release();
		await page.getByText("Created Client Projects").waitFor();
		await dialog.waitFor({ state: "hidden" });
		await page.getByText("Client Projects", { exact: true }).waitFor();
		await page.screenshot({
			path: join(logDirectory, `folder-create-${runStamp}-${name}-success.png`),
			fullPage: true,
		});

		assert.deepEqual(postBodies, [
			{ name: "Client Projects" },
			{ name: "Client Projects" },
		]);
		assert.ok(
			folderReads >= 2,
			`Expected an invalidation refetch, received ${folderReads}`,
		);
		assert.deepEqual(unexpectedBrowserErrors, []);
		const geometry = await page.evaluate(() => ({
			viewport: window.innerWidth,
			document: document.scrollingElement?.scrollWidth ?? 0,
		}));
		assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));

		detail(`${name} ${JSON.stringify({ postBodies, folderReads, geometry })}`);
	} catch (error) {
		detail(`${name} diagnostic URL ${page.url()}`);
		detail(`${name} diagnostic body ${(await page.locator("body").innerText()).slice(0, 4_000)}`);
		await page.screenshot({
			path: join(logDirectory, `folder-create-${runStamp}-${name}-diagnostic.png`),
			fullPage: true,
		});
		throw error;
	} finally {
		await context.close();
	}
}

async function main() {
	progress("Folder creation Playwright verification starting");
	progress(`Detailed log: ${logFilePath}`);
	let stateDirectory;
	let browser;
	let serverProcess;
	let setupProcess;
	let cleanupInFlight;

	const throwIfInterrupted = () => {
		if (interruptedSignal) {
			throw new Error(`Playwright verification interrupted by ${interruptedSignal}`);
		}
	};
	const cleanup = () => {
		if (cleanupInFlight) return cleanupInFlight;
		cleanupInFlight = (async () => {
			const browserToClose = browser;
			const serverToStop = serverProcess;
			const setupToStop = setupProcess;
			browser = undefined;
			serverProcess = undefined;
			setupProcess = undefined;

			const [browserResult, serverResult, setupResult] = await Promise.allSettled([
				browserToClose ? browserToClose.close() : Promise.resolve(),
				serverToStop ? stopServer(serverToStop) : Promise.resolve(),
				setupToStop ? stopServer(setupToStop) : Promise.resolve(),
			]);
			const failures = [browserResult, serverResult, setupResult]
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason);
			const processGroupsStopped =
				serverResult.status === "fulfilled" && setupResult.status === "fulfilled";
			if (
				stateDirectory &&
				processGroupsStopped &&
				!serverProcess &&
				!setupProcess
			) {
				try {
					await rm(stateDirectory, { recursive: true, force: true });
					stateDirectory = undefined;
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, "Playwright verification cleanup failed");
			}
		})().finally(() => {
			cleanupInFlight = undefined;
		});
		return cleanupInFlight;
	};
	const drainCleanup = async () => {
		const failures = [];
		do {
			try {
				await cleanup();
			} catch (error) {
				failures.push(error);
			}
		} while (browser || serverProcess || setupProcess);
		if (failures.length > 0) {
			throw new AggregateError(failures, "Playwright verification cleanup drain failed");
		}
	};
	const handleSignal = (signal) => {
		if (interruptedSignal) return;
		interruptedSignal = signal;
		detail(`received ${signal}; cleaning up isolated Playwright resources`);
		void drainCleanup().catch((error) =>
			detail(`signal cleanup failed: ${error instanceof Error ? error.stack : error}`),
		);
	};
	const handleSigint = () => handleSignal("SIGINT");
	const handleSigterm = () => handleSignal("SIGTERM");
	process.once("SIGINT", handleSigint);
	process.once("SIGTERM", handleSigterm);

	try {
		throwIfInterrupted();
		stateDirectory = await mkdtemp(join(tmpdir(), "mail-portal-folder-create-"));
		throwIfInterrupted();
		const port = await freePort();
		throwIfInterrupted();
		const baseUrl = `http://127.0.0.1:${port}`;
		progress("[1/5] Preparing an isolated local database");
		await runSetupCommand(
			"npx",
			[
				"wrangler",
				"d1",
				"migrations",
				"apply",
				"DB",
				"--local",
				"--config",
				playwrightConfigPath,
				"--persist-to",
				stateDirectory,
			],
			localEnvironment({
				CI: "1",
				WRANGLER_LOG_PATH: join(logDirectory, `wrangler-${runStamp}.log`),
			}),
			(process) => {
				setupProcess = process;
			},
		);
		throwIfInterrupted();
		progress("[2/5] Starting an isolated Wiser runtime");
		serverProcess = spawn(
			"npm",
			["exec", "--", "react-router", "dev", "--host", "127.0.0.1", "--port", String(port)],
			{
				cwd: root,
				env: localEnvironment({
					MAIL_PORTAL_PLAYWRIGHT_STATE: stateDirectory,
					MAIL_PORTAL_PLAYWRIGHT_CONFIG: playwrightConfigPath,
					WRANGLER_LOG_PATH: join(logDirectory, `wrangler-${runStamp}.log`),
				}),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		serverProcess.stdout.on("data", (chunk) => detail(`server stdout ${chunk}`));
		serverProcess.stderr.on("data", (chunk) => detail(`server stderr ${chunk}`));
		await waitForServer(baseUrl, serverProcess);
		throwIfInterrupted();

		browser = await chromium.launch({ headless: true });
		throwIfInterrupted();
		progress("[3/5] Bootstrapping the isolated local session");
		const storageState = await authenticate(browser, baseUrl);
		progress("[4/5] Verifying mobile failure, retry, success, and layout");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "mobile",
			viewport: { width: 390, height: 844 },
		});
		progress("[5/5] Verifying desktop failure, retry, success, and layout");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "desktop",
			viewport: { width: 1440, height: 900 },
		});
		progress("PASS: custom folder creation is truthful and recoverable at both widths");
	} finally {
		try {
			await drainCleanup();
		} finally {
			process.removeListener("SIGINT", handleSigint);
			process.removeListener("SIGTERM", handleSigterm);
		}
		throwIfInterrupted();
	}
}

main().catch((error) => {
	detail(error instanceof Error ? error.stack ?? error.message : String(error));
	console.error(`FAIL: custom folder Playwright verification failed. See ${logFilePath}`);
	process.exitCode = interruptedSignal
		? 128 + constants.signals[interruptedSignal]
		: 1;
});
