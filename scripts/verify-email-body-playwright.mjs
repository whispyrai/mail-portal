import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const artifactDirectory = join(root, "script-logs");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logFilePath = join(artifactDirectory, `email-body-playwright-${runStamp}.log`);
const wranglerLogPath = join(artifactDirectory, `wrangler-email-body-${runStamp}.log`);
const configPath = join(root, "scripts", "wrangler-email-body-playwright.jsonc");
const mailboxId = "playwright-email-body@wiserchat.ai";
const password = "LocalMailPortal!2026";
const selectedId = "selected-external";
const replyId = "older-external";
const threadId = "email-body-thread";
const subject = "Quarterly launch decision";
const selectedPreview = "SELECTED PREVIEW MUST NEVER REPLACE THE COMPLETE MESSAGE";
const replyPreview = "OLDER PREVIEW MUST NEVER REPLACE THE COMPLETE MESSAGE";
const selectedFullBody = "AUTHORITATIVE SELECTED BODY FOR FORWARDING";
const replyFullBody = "AUTHORITATIVE OLDER MESSAGE BODY";

mkdirSync(artifactDirectory, { recursive: true });

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

function formatFailure(error) {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deferred() {
	let resolvePromise;
	const promise = new Promise((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function pollValue(readValue, acceptValue, label, timeoutMilliseconds = 15_000) {
	const deadline = Date.now() + timeoutMilliseconds;
	let value;
	while (Date.now() < deadline) {
		value = await readValue();
		if (acceptValue(value)) return value;
		await delay(50);
	}
	throw new Error(`${label} did not reach the expected state; last value: ${String(value)}`);
}

function localEnvironment(overrides = {}) {
	const environment = {};
	for (const name of [
		"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME",
		"SHELL", "LANG", "LC_ALL", "TERM", "NO_COLOR",
	]) {
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
		server.close((error) => error ? reject(error) : resolveClose()),
	);
	return address.port;
}

async function runSetupCommand(args, environment) {
	const child = spawn("npx", args, {
		cwd: root,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => detail(`setup stdout ${chunk}`));
	child.stderr.on("data", (chunk) => detail(`setup stderr ${chunk}`));
	const result = await new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode, signalCode) => resolveExit({ exitCode, signalCode }));
	});
	if (result.exitCode !== 0) {
		throw new Error(`Database setup exited with ${result.exitCode ?? result.signalCode}`);
	}
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
			const response = await fetch(`${baseUrl}/login`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
		} catch {
			// The isolated local runtime has not bound its port yet.
		}
		await delay(250);
	}
	throw new Error("Wiser test server did not become ready within 45 seconds");
}

async function stopServer(serverProcess) {
	if (!serverProcess?.pid || serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGTERM");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return;
		serverProcess.kill("SIGTERM");
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && serverProcess.exitCode === null) await delay(50);
	if (serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGKILL");
	} catch (error) {
		if (!(error && typeof error === "object" && error.code === "ESRCH")) {
			serverProcess.kill("SIGKILL");
		}
	}
}

function fixtureEmail({ id, sender, date, preview }) {
	return {
		id,
		conversation_id: threadId,
		thread_id: threadId,
		folder_id: "inbox",
		subject,
		sender,
		recipient: mailboxId,
		date,
		read: true,
		starred: false,
		body: `<p>${preview}</p>`,
		body_external: true,
		attachments: [],
		labels: [],
	};
}

const selectedEmail = {
	...fixtureEmail({
		id: selectedId,
		sender: "alice@example.com",
		date: "2026-07-15T10:00:00.000Z",
		preview: selectedPreview,
	}),
	thread_count: 2,
	thread_unread_count: 0,
	participants: "alice@example.com, bob@example.com",
	snippet: selectedPreview,
};

const olderEmail = fixtureEmail({
	id: replyId,
	sender: "bob@example.com",
	date: "2026-07-14T10:00:00.000Z",
	preview: replyPreview,
});

async function authenticate(browser, baseUrl) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
	await page.getByLabel("Email").fill(mailboxId);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
	await page.goto(
		`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
		{ waitUntil: "domcontentloaded" },
	);
	await delay(3_000);
	const storageState = await context.storageState();
	await context.close();
	return storageState;
}

async function installMailFixture(page, handleBody) {
	const mailboxPrefix = `/api/v1/mailboxes/${mailboxId}`;
	await page.route("**/api/v1/mailboxes/**", async (route) => {
		const request = route.request();
		const path = decodeURIComponent(new URL(request.url()).pathname);
		if (request.method() !== "GET") {
			detail(`fixture continue ${request.method()} ${path}`);
			await route.continue();
			return;
		}
		if (path === `${mailboxPrefix}/emails`) {
			detail(`fixture fulfill list ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: [selectedEmail], totalCount: 1 }),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}/body`) {
			detail(`fixture handle selected body ${path}`);
			await handleBody({ route, messageId: selectedId });
			return;
		}
		if (path === `${mailboxPrefix}/emails/${replyId}/body`) {
			detail(`fixture handle older body ${path}`);
			await handleBody({ route, messageId: replyId });
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}`) {
			detail(`fixture fulfill metadata ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(selectedEmail),
			});
			return;
		}
		if (path === `${mailboxPrefix}/threads/${threadId}`) {
			detail(`fixture fulfill thread ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([selectedEmail, olderEmail]),
			});
			return;
		}
		detail(`fixture continue GET ${path}`);
		await route.continue();
	});
}

async function openConversation(page, baseUrl) {
	const inboxUrl = `${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await page.goto(inboxUrl, { waitUntil: "domcontentloaded" });
		const open = page.getByRole("button", { name: `Open conversation ${subject}` });
		try {
			await open.waitFor({ timeout: 8_000 });
			await open.click();
			await page.getByRole("heading", { name: subject }).waitFor();
			return;
		} catch (error) {
			detail(`open conversation attempt ${attempt} at ${page.url()}: ${formatFailure(error)}`);
			if (attempt === 3) throw error;
			await delay(1_000);
		}
	}
}

function observeBrowser(page, scenario) {
	page.on("console", (message) => {
		if (message.type() === "error") detail(`${scenario} console error ${message.text()}`);
	});
	page.on("pageerror", (error) => detail(`${scenario} page error ${formatFailure(error)}`));
}

async function captureDiagnostic(page, name, scenario, error) {
	detail(`${name} ${scenario} failed at ${page.url()}: ${formatFailure(error)}`);
	detail(`${name} ${scenario} body ${(await page.locator("body").innerText()).slice(0, 6_000)}`);
	await page.screenshot({
		path: join(artifactDirectory, `email-body-${runStamp}-${name}-${scenario}-diagnostic.png`),
		fullPage: true,
	});
}

async function assertNoHorizontalOverflow(page) {
	const geometry = await page.evaluate(() => ({
		viewport: window.innerWidth,
		document: document.scrollingElement?.scrollWidth ?? 0,
	}));
	assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));
}

async function assertAuthoritativeIframe(page, messageId, expectedBody, forbiddenPreview) {
	const iframe = page
		.locator(`[data-intelligence-message-id="${messageId}"]`)
		.getByTitle("Email content");
	await iframe.waitFor();
	const srcdoc = await pollValue(
		() => iframe.getAttribute("srcdoc"),
		(value) => typeof value === "string" && value.includes(expectedBody),
		`authoritative body for ${messageId}`,
	);
	assert.match(srcdoc, new RegExp(expectedBody));
	assert.doesNotMatch(srcdoc, new RegExp(forbiddenPreview));
}

async function verifyDelayedSelected({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} delayed-selected`);
	const gate = deferred();
	let selectedRequests = 0;
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId !== selectedId) {
				await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
				return;
			}
			selectedRequests += 1;
			await gate.promise;
			await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
		});
		await openConversation(page, baseUrl);
		await page.getByText("alice@example.com", { exact: true }).first().waitFor();
		await page.getByRole("status").filter({
			hasText: "Loading complete message from alice@example.com…",
		}).waitFor();
		const unavailableForward = page.getByRole("button", {
			name: "Forward unavailable: Loading complete message",
		});
		assert.equal(await unavailableForward.isDisabled(), true);
		assert.equal(selectedRequests, 1);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-loading.png`),
		});

		gate.resolve();
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		assert.equal(selectedRequests, 1);
		const forward = page.getByRole("button", { name: "Forward", exact: true });
		assert.equal(await forward.isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-loaded.png`),
		});
		await forward.click();
		const editor = page.getByLabel("Message body", { exact: true });
		await editor.waitFor();
		const editorHtml = await pollValue(
			() => editor.innerHTML(),
			(value) => value.includes(selectedFullBody),
			"Forward composer authoritative body",
		);
		assert.match(editorHtml, new RegExp(selectedFullBody));
		assert.doesNotMatch(editorHtml, new RegExp(selectedPreview));
		assert.equal(selectedRequests, 1);
		await assertNoHorizontalOverflow(page);
		detail(`${name} delayed selected body used one request and Forward used authoritative content`);
	} catch (error) {
		await captureDiagnostic(page, name, "delayed-selected", error);
		throw error;
	} finally {
		gate.resolve();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyCollapseCancellation({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} collapse-cancellation`);
	const replyGate = deferred();
	let selectedRequests = 0;
	let replyRequests = 0;
	const replyFailure = deferred();
	page.on("requestfailed", (request) => {
		if (decodeURIComponent(new URL(request.url()).pathname).endsWith(`/emails/${replyId}/body`)) {
			replyFailure.resolve(request.failure()?.errorText ?? "unknown");
		}
	});
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId === selectedId) {
				selectedRequests += 1;
				await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
				return;
			}
			replyRequests += 1;
			await replyGate.promise;
			await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
		});
		await openConversation(page, baseUrl);
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		const older = page.locator(`[data-intelligence-message-id="${replyId}"]`);
		await older.waitFor();
		await older.getByRole("button").first().click();
		await older.getByText("Loading complete message from bob@example.com…").waitFor();
		assert.equal(replyRequests, 1);
		await older.getByRole("button", { name: "Collapse message" }).first().click();
		const errorText = await Promise.race([
			replyFailure.promise,
			delay(5_000).then(() => "timeout"),
		]);
		assert.equal(errorText, "net::ERR_ABORTED");
		assert.equal(selectedRequests, 1);
		assert.equal(replyRequests, 1);
		assert.equal(await page.getByRole("button", { name: "Forward", exact: true }).isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-collapse-abort.png`),
		});
		await assertNoHorizontalOverflow(page);
		detail(`${name} collapse aborted only the older body request`);
	} catch (error) {
		await captureDiagnostic(page, name, "collapse-cancellation", error);
		throw error;
	} finally {
		replyGate.resolve();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyRetryRecovery({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} retry-recovery`);
	let selectedRequests = 0;
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId !== selectedId) {
				await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
				return;
			}
			selectedRequests += 1;
			if (selectedRequests === 1) {
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({
						error: "Complete message body is temporarily unavailable",
						code: "BODY_OBJECT_UNAVAILABLE",
					}),
				});
				return;
			}
			await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
		});
		await openConversation(page, baseUrl);
		const alert = page.getByRole("alert").filter({ hasText: "Complete message unavailable" });
		await alert.waitFor();
		await alert.getByText(
			"The complete message from alice@example.com could not be loaded.",
			{ exact: true },
		).waitFor();
		assert.equal(
			await page
				.locator(`[data-intelligence-message-id="${selectedId}"]`)
				.getByTitle("Email content")
				.count(),
			0,
		);
		const unavailableForward = page.getByRole("button", {
			name: "Forward unavailable: Complete message unavailable",
		});
		assert.equal(await unavailableForward.isDisabled(), true);
		assert.equal(selectedRequests, 1);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-error.png`),
		});
		await alert.getByRole("button", {
			name: "Retry loading complete message from alice@example.com",
		}).click();
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		assert.equal(selectedRequests, 2);
		assert.equal(await page.getByRole("button", { name: "Forward", exact: true }).isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-recovered.png`),
		});
		await assertNoHorizontalOverflow(page);
		detail(`${name} retry recovered on the second explicit request without preview fallback`);
	} catch (error) {
		await captureDiagnostic(page, name, "retry-recovery", error);
		throw error;
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyViewport({ browser, baseUrl, storageState, name, viewport }) {
	progress(`Verifying ${name} at ${viewport.width}x${viewport.height}`);
	const context = await browser.newContext({ storageState, viewport });
	try {
		await verifyDelayedSelected({ context, baseUrl, name });
		await verifyCollapseCancellation({ context, baseUrl, name });
		await verifyRetryRecovery({ context, baseUrl, name });
	} finally {
		await context.close();
	}
}

async function main() {
	progress(`Email body Playwright verification started. Detailed log: ${logFilePath}`);
	let stateDirectory;
	let serverProcess;
	let browser;
	try {
		stateDirectory = mkdtempSync(join(tmpdir(), "mail-portal-email-body-"));
		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		progress("[1/5] Preparing an isolated local database");
		await runSetupCommand(
			[
				"wrangler", "d1", "migrations", "apply", "DB", "--local",
				"--config", configPath, "--persist-to", stateDirectory,
			],
			localEnvironment({ CI: "1", WRANGLER_LOG_PATH: wranglerLogPath }),
		);
		progress("[2/5] Starting an isolated Wiser runtime");
		serverProcess = spawn(
			"npm",
			["exec", "--", "react-router", "dev", "--host", "127.0.0.1", "--port", String(port)],
			{
				cwd: root,
				env: localEnvironment({
					MAIL_PORTAL_PLAYWRIGHT_STATE: stateDirectory,
					MAIL_PORTAL_PLAYWRIGHT_CONFIG: configPath,
					WRANGLER_LOG_PATH: wranglerLogPath,
				}),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		serverProcess.stdout.on("data", (chunk) => detail(`server stdout ${chunk}`));
		serverProcess.stderr.on("data", (chunk) => detail(`server stderr ${chunk}`));
		await waitForServer(baseUrl, serverProcess);
		browser = await chromium.launch({ headless: true, timeout: 15_000 });
		progress("[3/5] Bootstrapping the isolated authenticated session");
		const storageState = await authenticate(browser, baseUrl);
		progress("[4/5] Running mobile-first verification");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "mobile",
			viewport: { width: 390, height: 844 },
		});
		progress("[5/5] Running desktop verification");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "desktop",
			viewport: { width: 1440, height: 900 },
		});
		progress("PASS: authoritative email bodies are exact, cancellable, retryable, and Forward-safe at both widths");
	} finally {
		await browser?.close();
		await stopServer(serverProcess);
		if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	detail(formatFailure(error));
	console.error(`FAIL: email body Playwright verification failed. See ${logFilePath}`);
	process.exitCode = 1;
});
