import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const logDirectory = join(root, "script-logs");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logFilePath = join(logDirectory, `attachment-retry-playwright-${runStamp}.log`);
const mailboxId = "playwright-attachment@wiserchat.ai";
const password = "LocalMailPortal!2026";
const playwrightConfigPath = join(
	root,
	"scripts",
	"wrangler-attachment-retry-playwright.jsonc",
);
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

function formatFailure(error, indent = "") {
	const primary = error instanceof Error ? error.stack ?? error.message : String(error);
	if (!(error instanceof AggregateError)) return `${indent}${primary}`;
	const nested = error.errors.map((failure, index) =>
		formatFailure(failure, `${indent}  [${index + 1}] `)
	);
	return [`${indent}${primary}`, ...nested].join("\n");
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
	let rejectProcessError;
	const processError = new Promise((_, reject) => { rejectProcessError = reject; });
	const onError = (error) => rejectProcessError(error);
	serverProcess.once("error", onError);
	try {
		await Promise.race([
			processError,
			(async () => {
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
						// The isolated local Worker has not bound its loopback port yet.
					}
					await delay(250);
				}
				throw new Error("Wiser test server did not become ready within 45 seconds");
			})(),
		]);
	} finally {
		serverProcess.removeListener("error", onError);
	}
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

async function processGroupMembers(processGroupId) {
	const child = spawn("ps", ["-axo", "pid=,pgid="], {
		env: localEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exitCode = await new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Process-group inspection did not finish within 2 seconds"));
		}, 2_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
	if (exitCode !== 0) {
		throw new Error(`Process-group inspection failed with ${exitCode}: ${stderr.trim()}`);
	}
	return stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, group]) => Number.isInteger(pid) && group === processGroupId)
		.map(([pid]) => pid);
}

function signalProcesses(processIds, signal) {
	for (const processId of processIds) {
		try {
			process.kill(processId, signal);
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ESRCH") continue;
			throw error;
		}
	}
}

async function stopProcessGroupByMembers(processGroupId) {
	let members = await processGroupMembers(processGroupId);
	if (members.length === 0) return;
	signalProcesses(members, "SIGTERM");
	const termDeadline = Date.now() + 5_000;
	while (Date.now() < termDeadline) {
		members = await processGroupMembers(processGroupId);
		if (members.length === 0) return;
		await delay(50);
	}
	signalProcesses(members, "SIGKILL");
	const killDeadline = Date.now() + 5_000;
	while (Date.now() < killDeadline) {
		members = await processGroupMembers(processGroupId);
		if (members.length === 0) return;
		await delay(50);
	}
	throw new Error(
		`Wiser test server process group ${processGroupId} retained members ${members.join(", ")}`,
	);
}

async function within(milliseconds, label, operation) {
	let timeout;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function stopServer(serverProcess) {
	if (!serverProcess.pid) return;
	try {
		if (!processGroupExists(serverProcess.pid)) return;
	} catch (error) {
		if (!(error && typeof error === "object" && error.code === "EPERM")) throw error;
		// Sandbox policy can deny negative-PID probes on macOS. Enumerate the
		// exact process group and signal every member, then prove none remain.
		await stopProcessGroupByMembers(serverProcess.pid);
		return;
	}
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
			await page.getByRole("button", { name: "Toggle sidebar" }).click({ timeout: 3_000 });
			await close.waitFor({ timeout: 3_000 });
			return;
		} catch (error) {
			detail(`mobile sidebar hydration attempt ${attempt}: ${error}`);
			await page.waitForTimeout(750);
		}
	}
	throw new Error("Mobile Sidebar did not open after client hydration");
}

async function openCompose(page, mobile) {
	const dialog = page.getByRole("dialog").filter({ hasText: "New message" });
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		try {
			if (await dialog.isVisible()) return dialog;
			if (mobile) await openMobileSidebar(page);
			await page
				.getByRole("complementary")
				.getByRole("button", { name: "Compose", exact: true })
				.click({ timeout: 3_000 });
			await dialog.waitFor({ timeout: 3_000 });
			return dialog;
		} catch (error) {
			detail(`compose hydration attempt ${attempt}: ${error}`);
			await page.waitForTimeout(750);
		}
	}
	throw new Error("Compose did not open after client hydration");
}

function observeBrowserErrors(page) {
	const events = { consoleErrors: [], pageErrors: [], requestFailures: [] };
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		const text = message.text();
		events.consoleErrors.push(text);
		detail(`browser console error ${text}`);
	});
	page.on("pageerror", (error) => {
		events.pageErrors.push(error.message);
		detail(`browser page error ${error.message}`);
	});
	page.on("requestfailed", (request) => {
		const failure = { url: request.url(), errorText: request.failure()?.errorText ?? "unknown" };
		events.requestFailures.push(failure);
		detail(`browser request failed ${JSON.stringify(failure)}`);
	});
	return events;
}

async function installCommittedResponseLoss(page) {
	const requests = [];
	await page.route("**/attachment-uploads/*", async (route) => {
		const request = route.request();
		if (request.method() !== "PUT") {
			await route.continue();
			return;
		}
		assert.ok(requests.length < 2, "unexpected third attachment upload request");
		const bytes = request.postDataBuffer();
		assert.ok(bytes);
		const upstream = await route.fetch();
		const responseJson = await upstream.json();
		const record = {
			url: request.url(),
			method: request.method(),
			bytes: Buffer.from(bytes),
			upstreamStatus: upstream.status(),
			responseJson,
		};
		requests.push(record);
		detail(`intercepted attachment request ${JSON.stringify({
			url: record.url,
			method: record.method,
			bytes: record.bytes.byteLength,
			upstreamStatus: record.upstreamStatus,
			responseJson,
		})}`);
		if (requests.length === 1) {
			assert.equal(upstream.status(), 201);
			await route.abort("connectionreset");
			return;
		}
		await route.fulfill({ response: upstream });
	});
	return requests;
}

async function assertRetryIdentity(requests, expectedBytes) {
	assert.equal(requests.length, 2);
	assert.deepEqual(requests.map((request) => request.method), ["PUT", "PUT"]);
	assert.equal(requests[0].url, requests[1].url);
	assert.deepEqual(requests[0].bytes, expectedBytes);
	assert.deepEqual(requests[1].bytes, expectedBytes);
	assert.deepEqual(requests.map((request) => request.upstreamStatus), [201, 200]);
	const uploadId = new URL(requests[0].url).pathname.split("/").at(-1);
	assert.ok(uploadId);
	assert.deepEqual(requests.map((request) => request.responseJson.uploadId), [uploadId, uploadId]);
	assert.deepEqual(requests.map((request) => request.responseJson.replayed), [false, true]);
	return uploadId;
}

function assertExpectedLostConnection(browserEvents, expectedUrl) {
	assert.deepEqual(browserEvents.pageErrors, []);
	const uploadFailures = browserEvents.requestFailures.filter((failure) =>
		new URL(failure.url).pathname.includes("/attachment-uploads/"),
	);
	assert.deepEqual(uploadFailures, [
		{ url: expectedUrl, errorText: "net::ERR_CONNECTION_RESET" },
	]);
	const unexpectedRequestFailures = browserEvents.requestFailures.filter((failure) => {
		if (new URL(failure.url).pathname.includes("/attachment-uploads/")) return false;
		return !(
			failure.errorText === "net::ERR_ABORTED" &&
			/\/api\/v1\/mailboxes\/[^/]+\/settings$/.test(new URL(failure.url).pathname)
		);
	});
	assert.deepEqual(unexpectedRequestFailures, []);
	const unexpectedConsoleErrors = browserEvents.consoleErrors.filter((message) =>
		!message.includes("net::ERR_CONNECTION_RESET") &&
		!message.includes("Failed to fetch manifest patches")
	);
	assert.deepEqual(unexpectedConsoleErrors, []);
}

async function assertVisibleComposeRecovery(dialog, row, footerControl, viewport) {
	await row.scrollIntoViewIfNeeded();
	await delay(500);
	const [dialogBox, rowBox, footerBox] = await Promise.all([
		dialog.boundingBox(),
		row.boundingBox(),
		footerControl.boundingBox(),
	]);
	assert.ok(dialogBox && rowBox && footerBox);
	assert.ok(dialogBox.x >= 0 && dialogBox.y >= 0);
	assert.ok(dialogBox.x + dialogBox.width <= viewport.width);
	assert.ok(dialogBox.y + dialogBox.height <= viewport.height);
	assert.ok(rowBox.y >= dialogBox.y && rowBox.y + rowBox.height <= footerBox.y);
	return { dialogBox, rowBox, footerBox };
}

function composeRecoveryClip({ dialogBox, rowBox, footerBox }, viewport) {
	const y = Math.max(dialogBox.y, rowBox.y - 16);
	return {
		x: dialogBox.x,
		y,
		width: Math.min(dialogBox.width, viewport.width - dialogBox.x),
		height: Math.min(footerBox.y + footerBox.height, viewport.height) - y,
	};
}

async function assertNoHorizontalOverflow(page) {
	const geometry = await page.evaluate(() => ({
		viewport: window.innerWidth,
		document: document.scrollingElement?.scrollWidth ?? 0,
	}));
	assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));
	return geometry;
}

async function verifyCompose({ context, baseUrl, name, viewport }) {
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	const browserEvents = observeBrowserErrors(page);
	const requests = await installCommittedResponseLoss(page);
	const draftBodies = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/drafts")
		) {
			draftBodies.push(request.postDataJSON());
		}
	});
	const filename = `compose-${name}-proposal.pdf`;
	const bytes = Buffer.from(`compose attachment bytes for ${name}`);
	try {
		await page.goto(
			`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
			{ waitUntil: "networkidle" },
		);
		const dialog = await openCompose(page, name === "mobile");
		await dialog.getByLabel("Choose files to attach").setInputFiles({
			name: filename,
			mimeType: "application/pdf",
			buffer: bytes,
		});
		const retry = dialog.getByRole("button", { name: `Retry ${filename}` });
		await retry.waitFor();
		const row = dialog.getByRole("listitem").filter({ hasText: filename });
		const saveDraft = dialog.getByRole("button", { name: "Save draft" });
		await assertVisibleComposeRecovery(dialog, row, saveDraft, viewport);
		const retryBox = await retry.boundingBox();
		assert.ok(retryBox && retryBox.height >= 44);
		assert.equal(await saveDraft.isDisabled(), true);
		assert.equal(
			await dialog.getByRole("button", { name: "Fix attachments", exact: true }).isDisabled(),
			true,
		);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-compose-failure.png`),
		});

		await retry.click();
		await retry.waitFor({ state: "hidden" });
		const size = dialog.getByText(`${bytes.length} B`, { exact: true });
		await size.waitFor();
		await assertRetryIdentity(requests, bytes);
		const recoveryGeometry = await assertVisibleComposeRecovery(
			dialog,
			row,
			saveDraft,
			viewport,
		);
		assert.equal(await saveDraft.isEnabled(), true);
		assert.equal(
			await dialog.getByRole("button", { name: "Send", exact: true }).isEnabled(),
			true,
		);
		assert.equal(await dialog.getByRole("button", { name: "Send options" }).isEnabled(), true);
		const firstSaveResponse = page.waitForResponse((response) =>
			response.request().method() === "POST" &&
			new URL(response.url()).pathname.endsWith("/drafts"),
		);
		await saveDraft.click();
		assert.equal((await firstSaveResponse).status(), 201);
		await dialog.getByText("Saved", { exact: true }).waitFor();
		await row.waitFor();
		assert.equal(await retry.isVisible(), false);
		assert.equal(await size.isVisible(), true);
		assert.equal(draftBodies[0]?.attachments?.[0]?.kind, "upload");

		await dialog.getByLabel("Subject", { exact: true }).fill(`Claim scope ${name}`);
		const secondSaveResponse = page.waitForResponse((response) =>
			response.request().method() === "POST" &&
			new URL(response.url()).pathname.endsWith("/drafts"),
		);
		await saveDraft.click();
		assert.equal((await secondSaveResponse).status(), 201);
		assert.equal(draftBodies[1]?.attachments?.[0]?.kind, "existing");
		assert.equal(typeof draftBodies[1]?.attachments?.[0]?.emailId, "string");
		assert.equal(typeof draftBodies[1]?.attachments?.[0]?.attachmentId, "string");
		assert.equal(await retry.isVisible(), false);
		assert.equal(await size.isVisible(), true);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-compose-success.png`),
			clip: composeRecoveryClip(recoveryGeometry, viewport),
		});
		const geometry = await assertNoHorizontalOverflow(page);
		assertExpectedLostConnection(browserEvents, requests[0].url);
		detail(`${name} compose ${JSON.stringify({ geometry, requests: requests.map((r) => ({ url: r.url, upstreamStatus: r.upstreamStatus })) })}`);
	} catch (error) {
		detail(`${name} compose diagnostic URL ${page.url()}`);
		detail(`${name} compose diagnostic body ${(await page.locator("body").innerText()).slice(0, 4_000)}`);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-compose-diagnostic.png`),
			fullPage: true,
		});
		throw error;
	} finally {
		await page.close();
	}
}

async function dispatchSyntheticFileEvent(locator, eventType, filename, mimeType) {
	return locator.evaluate((element, input) => {
		const file = new File([`locked ${input.filename}`], input.filename, {
			type: input.mimeType,
		});
		const transfer = new DataTransfer();
		transfer.items.add(file);
		let event;
		if (input.eventType === "change") {
			Object.defineProperty(element, "files", {
				configurable: true,
				value: transfer.files,
			});
			event = new Event("change", { bubbles: true, cancelable: true });
		} else {
			event = new Event(input.eventType, { bubbles: true, cancelable: true });
			Object.defineProperty(event, input.eventType === "paste" ? "clipboardData" : "dataTransfer", {
				value: transfer,
			});
			if (input.eventType === "drop") {
				Object.defineProperties(event, {
					clientX: { value: 12 },
					clientY: { value: 12 },
				});
			}
		}
		const dispatched = element.dispatchEvent(event);
		return { defaultPrevented: event.defaultPrevented, dispatched };
	}, { eventType, filename, mimeType });
}

async function assertLockedComposeFileTransfers(dialog, uploadRequests, prefix) {
	const attachmentInput = dialog.getByLabel("Choose files to attach");
	const inlineImageInput = dialog.getByLabel("Choose images to insert");
	const form = dialog.locator('form[data-compose-shortcut-surface="primary"]');
	const editor = dialog.getByLabel("Message body");
	const attachmentList = dialog.getByRole("list", { name: "Attachments" });
	const editorBefore = await editor.innerHTML();
	const uploadCountBefore = uploadRequests.length;

	assert.equal(await attachmentInput.isDisabled(), true);
	assert.equal(await inlineImageInput.isDisabled(), true);
	assert.equal(
		await dialog.locator("button").filter({ hasText: "Attach files" }).isDisabled(),
		true,
	);
	assert.equal(
		await dialog.locator('button[aria-label="Insert image"]').isDisabled(),
		true,
	);

	await dispatchSyntheticFileEvent(
		attachmentInput,
		"change",
		`${prefix}-picker.pdf`,
		"application/pdf",
	);
	const transferResults = await Promise.all([
		dispatchSyntheticFileEvent(form, "paste", `${prefix}-outer-paste.pdf`, "application/pdf"),
		dispatchSyntheticFileEvent(form, "drop", `${prefix}-outer-drop.pdf`, "application/pdf"),
		dispatchSyntheticFileEvent(editor, "paste", `${prefix}-editor-paste.png`, "image/png"),
		dispatchSyntheticFileEvent(editor, "drop", `${prefix}-editor-drop.png`, "image/png"),
	]);
	await dispatchSyntheticFileEvent(
		inlineImageInput,
		"change",
		`${prefix}-inline-picker.png`,
		"image/png",
	);
	await delay(150);

	for (const result of transferResults) {
		assert.equal(result.defaultPrevented, true);
		assert.equal(result.dispatched, false);
	}
	assert.equal(uploadRequests.length, uploadCountBefore);
	assert.equal(await attachmentList.count(), 0);
	assert.equal(await editor.innerHTML(), editorBefore);
	assert.equal(await editor.locator("img").count(), 0);
	assert.equal(await attachmentInput.inputValue(), "");
	assert.equal(await inlineImageInput.inputValue(), "");
}

async function seedPersistedCompose(page, baseUrl, name) {
	await page.goto(
		`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
		{ waitUntil: "networkidle" },
	);
	const dialog = await openCompose(page, name === "mobile");
	await dialog.getByLabel("To", { exact: true }).fill("buyer@example.com");
	await dialog.getByLabel("Subject", { exact: true }).fill(`Terminal attachment lock ${name}`);
	await dialog.getByLabel("Message body", { exact: true }).fill("Hello from the attachment lock verification.");
	await dialog.getByRole("button", { name: "Save draft" }).click();
	await dialog.getByText("Saved", { exact: true }).waitFor();
	return dialog;
}

async function verifyComposeTerminalLock({ context, baseUrl, name, mode }) {
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	const uploadRequests = [];
	page.on("request", (request) => {
		if (
			request.method() === "PUT" &&
			new URL(request.url()).pathname.includes("/attachment-uploads/")
		) uploadRequests.push(request.url());
	});
	let releaseDraft;
	const draftGate = new Promise((resolveDraft) => { releaseDraft = resolveDraft; });
	let markDraftIntercepted;
	const draftIntercepted = new Promise((resolveDraft) => { markDraftIntercepted = resolveDraft; });
	const draftBodies = [];
	try {
		const dialog = await seedPersistedCompose(page, baseUrl, name);
		await page.route("**/drafts", async (route) => {
			if (route.request().method() !== "POST") {
				await route.continue();
				return;
			}
			draftBodies.push(route.request().postDataJSON());
			markDraftIntercepted();
			await draftGate;
			const response = await route.fetch();
			await route.fulfill({ response });
		});
		await dialog.getByLabel("Subject", { exact: true }).fill(`Terminal attachment lock ${name} revised`);

		let sentRequest;
		let sentRequestPromise;
		if (mode === "send") {
			let markSentRequest;
			sentRequestPromise = new Promise((resolveSend) => { markSentRequest = resolveSend; });
			await page.route("**/emails", async (route) => {
					if (route.request().method() !== "POST") {
						await route.continue();
						return;
					}
					sentRequest = route.request();
					await route.fulfill({
						status: 202,
						contentType: "application/json",
						body: JSON.stringify({
							deliveryId: `delivery-${name}`,
							id: `mail-${name}`,
							status: "queued",
							undoUntil: new Date(Date.now() + 10_000).toISOString(),
							scheduledFor: null,
							replayed: false,
							outcome: "enqueued",
						}),
					});
					markSentRequest();
				});
			await dialog.getByRole("button", { name: "Send", exact: true }).click();
		} else {
			await dialog.getByRole("button", { name: "Close compose" }).click();
			const closeDialog = page.getByRole("dialog").filter({ hasText: "Save before closing?" });
			await closeDialog.getByRole("button", { name: "Save and close" }).click();
		}

		await within(12_000, `${mode} draft interception`, draftIntercepted);
		await assertLockedComposeFileTransfers(
			dialog,
			uploadRequests,
			`${name}-${mode}`,
		);
		assert.deepEqual(draftBodies[0]?.attachments, []);
		releaseDraft();
		if (sentRequestPromise) {
			await within(12_000, "terminal-lock send request", sentRequestPromise);
			assert.deepEqual(sentRequest.postDataJSON().attachments, []);
		}
		await dialog.waitFor({ state: "hidden" });
		assert.equal(uploadRequests.length, 0);
		detail(`${name} compose ${mode} terminal lock blocked every file ingress path`);
	} finally {
		releaseDraft?.();
		await page.unrouteAll({ behavior: "wait" });
		await page.close();
	}
}

async function verifyBulk({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	const browserEvents = observeBrowserErrors(page);
	const requests = await installCommittedResponseLoss(page);
	const filename = `bulk-${name}-proposal.pdf`;
	const bytes = Buffer.from(`bulk attachment bytes for ${name}`);
	try {
		await page.goto(`${baseUrl}/bulk`, { waitUntil: "networkidle" });
		await page.locator("#attach").setInputFiles({
			name: filename,
			mimeType: "application/pdf",
			buffer: bytes,
		});
		const attachmentStatus = page.locator("#attachStatus[role='status'][aria-live='polite']");
		await attachmentStatus.getByText(`${filename} could not be uploaded. Retry or remove it.`).waitFor();
		const list = page.getByRole("list", { name: "Attachments" });
		await list.waitFor();
		assert.equal(await list.locator("#attachStatus").count(), 0);
		assert.equal(await attachmentStatus.getByRole("button").count(), 0);
		const retry = list.getByRole("button", { name: `Retry ${filename}` });
		await retry.waitFor();
		const retryBox = await retry.boundingBox();
		assert.ok(retryBox && retryBox.height >= 44);
		assert.equal(await page.getByRole("button", { name: "Send all" }).isDisabled(), true);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-bulk-failure.png`),
			fullPage: true,
		});

		await retry.click();
		await retry.waitFor({ state: "hidden" });
		await attachmentStatus.getByText(`${filename} is ready.`).waitFor();
		const uploadId = await assertRetryIdentity(requests, bytes);

		await page.getByLabel(/Recipients CSV/).setInputFiles({
			name: "recipients.csv",
			mimeType: "text/csv",
			buffer: Buffer.from("email,company\nbuyer@example.com,Acme\n"),
		});
		await page.getByLabel("2. Subject").fill("Proposal for {{company}}");
		await page.getByLabel(/^Body/).fill("Hello {{company}}");
		const send = page.getByRole("button", { name: "Send all" });
		await assert.doesNotReject(() => send.waitFor({ state: "visible" }));
		assert.equal(await send.isEnabled(), true);
		const reserveRequestPromise = page.waitForRequest((request) =>
			request.method() === "POST" && /\/bulk\/operations\/[^/]+\/reserve$/.test(new URL(request.url()).pathname),
		);
		await send.click();
		const reserveRequest = await reserveRequestPromise;
		const reserveBody = reserveRequest.postDataJSON();
		assert.deepEqual(reserveBody.attachmentUploadIds, [uploadId]);
		detail(`bulk reserve request ${JSON.stringify({ url: reserveRequest.url(), attachmentUploadIds: reserveBody.attachmentUploadIds })}`);
		await page.getByText(`Attachments (1): ${filename}.`, { exact: false }).waitFor();
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-bulk-success.png`),
			fullPage: true,
		});
		const geometry = await assertNoHorizontalOverflow(page);
		assertExpectedLostConnection(browserEvents, requests[0].url);
		detail(`${name} bulk ${JSON.stringify({ geometry, requests: requests.map((r) => ({ url: r.url, upstreamStatus: r.upstreamStatus })) })}`);
	} catch (error) {
		detail(`${name} bulk diagnostic URL ${page.url()}`);
		detail(`${name} bulk diagnostic body ${(await page.locator("body").innerText()).slice(0, 4_000)}`);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-bulk-diagnostic.png`),
			fullPage: true,
		});
		throw error;
	} finally {
		await page.close();
	}
}

async function verifyBulkInFlightRemoval({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	const browserEvents = observeBrowserErrors(page);
	const filename = `bulk-${name}-stalled.pdf`;
	let interceptedUrl;
	let releaseRoute;
	const routeGate = new Promise((resolveRoute) => { releaseRoute = resolveRoute; });
	await page.route("**/attachment-uploads/*", async (route) => {
		interceptedUrl = route.request().url();
		detail(`intercepted stalled attachment request ${interceptedUrl}`);
		await routeGate;
		await route.abort("connectionreset").catch((error) =>
			detail(`stalled attachment route already ended ${error}`),
		);
	});
	try {
		await page.goto(`${baseUrl}/bulk`, { waitUntil: "networkidle" });
		await page.getByLabel(/Recipients CSV/).setInputFiles({
			name: "recipients.csv",
			mimeType: "text/csv",
			buffer: Buffer.from("email\nbuyer@example.com\n"),
		});
		await page.getByLabel("2. Subject").fill("Stalled upload recovery");
		await page.getByLabel(/^Body/).fill("Hello");
		const send = page.getByRole("button", { name: "Send all" });
		assert.equal(await send.isEnabled(), true);
		const interceptedRequest = page.waitForRequest((request) =>
			request.method() === "PUT" &&
			new URL(request.url()).pathname.includes("/attachment-uploads/"),
			{ timeout: 12_000 },
		);
		const uploadStarted = page.locator("#attach").setInputFiles({
			name: filename,
			mimeType: "application/pdf",
			buffer: Buffer.from("stalled attachment"),
		});
		await interceptedRequest;
		const list = page.getByRole("list", { name: "Attachments" });
		const row = list.getByRole("listitem").filter({ hasText: filename });
		await row.getByText("uploading…", { exact: true }).waitFor();
		const remove = row.getByRole("button", { name: `Remove ${filename}` });
		const removeBox = await remove.boundingBox();
		assert.ok(removeBox && removeBox.height >= 44);
		assert.equal(await send.isDisabled(), true);
		await page.screenshot({
			path: join(logDirectory, `attachment-retry-${runStamp}-${name}-bulk-uploading.png`),
			fullPage: true,
		});
		await remove.click();
		await row.waitFor({ state: "hidden" });
		const removedStatus = page.locator("#attachStatus").getByText(`${filename} was removed.`);
		await removedStatus.waitFor();
		assert.equal(await list.getByRole("listitem").count(), 0);
		assert.equal(await send.isEnabled(), true);
		releaseRoute();
		await uploadStarted;
		await delay(100);
		assert.equal(await row.isVisible(), false);
		assert.equal(await list.getByRole("listitem").count(), 0);
		assert.equal(await removedStatus.isVisible(), true);
		assert.equal(await send.isEnabled(), true);
		assert.ok(interceptedUrl);
		assert.deepEqual(browserEvents.pageErrors, []);
		assert.equal(browserEvents.requestFailures.length, 1);
		assert.equal(browserEvents.requestFailures[0]?.url, interceptedUrl);
		assert.ok(
			["net::ERR_ABORTED", "net::ERR_CONNECTION_RESET", "net::ERR_FAILED"].includes(
				browserEvents.requestFailures[0]?.errorText,
			),
		);
		const unexpectedConsoleErrors = browserEvents.consoleErrors.filter((message) =>
			!message.includes("ERR_ABORTED") &&
			!message.includes("ERR_CONNECTION_RESET") &&
			!message.includes("Failed to fetch manifest patches"),
		);
		assert.deepEqual(unexpectedConsoleErrors, []);
	} finally {
		releaseRoute?.();
		await page.unrouteAll({ behavior: "wait" });
		await page.close();
	}
}

async function waitForBulkAttachmentsToSettle(page, expectedRows) {
	await within(20_000, "bulk attachment settlement", (async () => {
		while (true) {
			const state = await page.locator("#attachList").evaluate((list) => ({
				rows: list.querySelectorAll(".bulk-attachment").length,
				uploading: Array.from(list.querySelectorAll(".bulk-attachment-meta"))
					.some((element) => element.textContent === "uploading…"),
			}));
			if (state.rows === expectedRows && !state.uploading) return;
			await delay(50);
		}
	})());
}

async function verifyBulkRetryCapacity({ context, baseUrl, pressure }) {
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	const failureFilename = `bulk-${pressure}-retry-target.pdf`;
	const attempts = [];
	try {
		await page.route("**/attachment-uploads/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const filename = url.searchParams.get("filename") ?? "attachment.bin";
			const bytes = request.postDataBuffer();
			assert.ok(bytes);
			const attempt = {
				url: request.url(),
				filename,
				bytes: Buffer.from(bytes),
			};
			attempts.push(attempt);
			const targetAttempts = attempts.filter((candidate) =>
				candidate.filename === failureFilename
			);
			if (filename === failureFilename && targetAttempts.length === 1) {
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "Injected first-attempt loss" }),
				});
				return;
			}
			const uploadId = decodeURIComponent(url.pathname.split("/").at(-1));
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({
					uploadId,
					filename,
					mimetype: url.searchParams.get("type") ?? "application/octet-stream",
					size: bytes.byteLength,
					replayed: false,
				}),
			});
		});
		await page.goto(`${baseUrl}/bulk`, { waitUntil: "networkidle" });
		await page.getByLabel(/Recipients CSV/).setInputFiles({
			name: "capacity-recipients.csv",
			mimeType: "text/csv",
			buffer: Buffer.from("email\nbuyer@example.com\n"),
		});
		await page.getByLabel("2. Subject").fill(`Bulk ${pressure} retry capacity`);
		await page.getByLabel(/^Body/).fill("Hello");
		const targetBytes = pressure === "total"
			? Buffer.alloc(1024 * 1024, 1)
			: Buffer.from("retry target");
		await page.locator("#attach").setInputFiles({
			name: failureFilename,
			mimeType: "application/pdf",
			buffer: targetBytes,
		});
		const list = page.getByRole("list", { name: "Attachments" });
		const targetRow = list.getByRole("listitem").filter({ hasText: failureFilename });
		await targetRow.getByRole("button", { name: `Retry ${failureFilename}` }).waitFor();

		const readyFiles = pressure === "count"
			? Array.from({ length: 10 }, (_, index) => ({
					name: `count-ready-${index + 1}.pdf`,
					mimeType: "application/pdf",
					buffer: Buffer.from([index + 1]),
				}))
			: [
					{ name: "total-ready-10-a.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024, 2) },
					{ name: "total-ready-10-b.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024, 3) },
					{ name: "total-ready-5.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024, 4) },
				];
		await page.locator("#attach").setInputFiles(readyFiles);
		await waitForBulkAttachmentsToSettle(page, readyFiles.length + 1);
		assert.equal(await page.getByRole("button", { name: "Send all" }).isDisabled(), true);

		const attemptsBeforeBlockedRetry = attempts.length;
		await targetRow.getByRole("button", { name: `Retry ${failureFilename}` }).click();
		const expectedPressure = pressure === "count"
			? "You can attach at most 10 files."
			: "This file would exceed the total attachment limit.";
		await page.locator("#attachStatus").getByText(
			`${failureFilename} cannot be retried yet. ${expectedPressure}`,
			{ exact: true },
		).waitFor();
		await delay(150);
		assert.equal(attempts.length, attemptsBeforeBlockedRetry);

		const removableFilename = pressure === "count"
			? readyFiles[0].name
			: "total-ready-5.pdf";
		await list.getByRole("button", { name: `Remove ${removableFilename}` }).click();
		await targetRow.getByRole("button", { name: `Retry ${failureFilename}` }).click();
		await targetRow.getByRole("button", { name: `Retry ${failureFilename}` }).waitFor({
			state: "hidden",
		});
		await page.locator("#attachStatus").getByText(
			`${failureFilename} is ready.`,
			{ exact: true },
		).waitFor();
		const targetAttempts = attempts.filter((attempt) =>
			attempt.filename === failureFilename
		);
		assert.equal(targetAttempts.length, 2);
		assert.equal(targetAttempts[0].url, targetAttempts[1].url);
		assert.deepEqual(targetAttempts[0].bytes, targetBytes);
		assert.deepEqual(targetAttempts[1].bytes, targetBytes);
		assert.equal(await list.getByRole("listitem").count(), readyFiles.length);
		assert.equal(await page.getByRole("button", { name: "Send all" }).isEnabled(), true);
		detail(`desktop bulk ${pressure} pressure blocks Retry without changing its identity`);
	} finally {
		await page.unrouteAll({ behavior: "wait" });
		await page.close();
	}
}

async function verifyOutboundDeliveryActions({ context, baseUrl, name, viewport }) {
	const page = await context.newPage();
	page.setDefaultTimeout(12_000);
	const browserEvents = observeBrowserErrors(page);
	const now = "2026-07-16T08:00:00.000Z";
	const email = (id, subject) => ({
		id,
		thread_id: `thread-${id}`,
		folder_id: "outbox",
		subject,
		sender: mailboxId,
		recipient: "recipient@example.com",
		date: now,
		read: true,
		starred: false,
		snippet: "Outbound delivery recovery state",
		thread_count: 1,
		thread_unread_count: 0,
		labels: [],
	});
	const emails = [
		email("outbound-queued", "Queued retry cancellation"),
		email("outbound-failed", "Retryable provider rejection"),
		email("outbound-unknown", "Ambiguous provider acceptance"),
		email("outbound-integrity", "Attachment integrity failure"),
	];
	const delivery = (id, emailId, status, extra = {}) => ({
		id,
		emailId,
		mailboxId,
		status,
		kind: "compose",
		createdAt: now,
		updatedAt: now,
		availableAt: now,
		undoUntil: now,
		attemptCount: status === "queued" ? 1 : 2,
		maxAttempts: 4,
		...extra,
	});
	const deliveries = [
		delivery("delivery-queued", "outbound-queued", "retrying", {
			lastErrorCode: "ses_throttled",
			lastErrorMessage: "The provider asked us to retry later.",
		}),
		delivery("delivery-failed", "outbound-failed", "failed", {
			lastErrorCode: "ses_rejected",
			lastErrorMessage: "The provider rejected this attempt.",
			failedAt: now,
		}),
		delivery("delivery-unknown", "outbound-unknown", "unknown", {
			lastErrorCode: "ses_transport_ambiguous",
			lastErrorMessage: "The provider may already have accepted this email.",
			unknownAt: now,
		}),
		delivery("delivery-integrity", "outbound-integrity", "failed", {
			lastErrorCode: "attachment_content_mismatch",
			lastErrorMessage: "Rebuild this message before sending it again.",
			failedAt: now,
		}),
	];
	const mutationRequests = [];
	let duplicateRiskDialog;
	page.on("dialog", async (dialog) => {
		duplicateRiskDialog = dialog.message();
		await dialog.accept();
	});
	await page.route("**/api/v1/mailboxes/*/emails?*", async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ emails, totalCount: emails.length }),
		});
	});
	const handleOutboundRoute = async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ deliveries }),
			});
			return;
		}
		const deliveryId = url.pathname.split("/").at(-2);
		const action = url.pathname.split("/").at(-1);
		mutationRequests.push({
			deliveryId,
			action,
			body: request.postData() ? request.postDataJSON() : undefined,
		});
		const current = deliveries.find((item) => item.id === deliveryId);
		assert.ok(current);
		if (action === "cancel") {
			Object.assign(current, {
				status: "failed",
				failedAt: now,
				lastErrorCode: "ses_throttled",
			});
		} else {
			Object.assign(current, {
				status: "retrying",
				nextAttemptAt: "2026-07-16T08:01:00.000Z",
			});
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				delivery: current,
				...(action === "cancel" ? { retryCancellationRestored: true } : {}),
			}),
		});
	};
	await page.route(
		"**/api/v1/mailboxes/*/outbound-deliveries*",
		handleOutboundRoute,
	);
	await page.route(
		"**/api/v1/mailboxes/*/outbound-deliveries/*/*",
		handleOutboundRoute,
	);
	try {
		await page.goto(
			`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/outbox`,
			{ waitUntil: "networkidle" },
		);
		const row = (id) => page.locator(`[data-email-id="${id}"]`);
		for (const id of emails.map((item) => item.id)) await row(id).waitFor();

		const cancel = row("outbound-queued").getByRole("button", { name: "Cancel send" });
		const retry = row("outbound-failed").getByRole("button", { name: "Retry send" });
		const retryUnknown = row("outbound-unknown").getByRole("button", {
			name: "Retry with duplicate risk",
		});
		for (const control of [cancel, retry, retryUnknown]) {
			await control.waitFor();
			const box = await control.boundingBox();
			assert.ok(box && box.height >= 44 && box.width >= 44, JSON.stringify(box));
		}
		assert.equal(
			await row("outbound-integrity").getByRole("button", { name: /retry/i }).count(),
			0,
		);
		await row("outbound-integrity").getByText(
			"Rebuild this message before sending it again.",
			{ exact: true },
		).waitFor();
		const initialGeometry = await assertNoHorizontalOverflow(page);
		await page.screenshot({
			path: join(logDirectory, `outbound-delivery-${runStamp}-${name}-states.png`),
			fullPage: true,
		});

		await cancel.click();
		await page.getByText(
			"Retry cancelled; previous delivery state restored",
			{ exact: true },
		).waitFor();
		await retry.click();
		await page.getByText("Send queued for retry", { exact: true }).waitFor();
		await retryUnknown.click();
		await page.getByText("Send queued for retry", { exact: true }).waitFor();

		assert.match(duplicateRiskDialog ?? "", /may already have accepted/i);
		assert.deepEqual(mutationRequests, [
			{ deliveryId: "delivery-queued", action: "cancel", body: undefined },
			{
				deliveryId: "delivery-failed",
				action: "retry",
				body: { acknowledgeDuplicateRisk: false },
			},
			{
				deliveryId: "delivery-unknown",
				action: "retry",
				body: { acknowledgeDuplicateRisk: true },
			},
		]);
		assert.deepEqual(browserEvents.pageErrors, []);
		assert.deepEqual(browserEvents.requestFailures, []);
		const unexpectedConsoleErrors = browserEvents.consoleErrors.filter(
			(message) => !message.includes("Failed to fetch manifest patches"),
		);
		assert.deepEqual(unexpectedConsoleErrors, []);
		const finalGeometry = await assertNoHorizontalOverflow(page);
		detail(`${name} outbound delivery controls ${JSON.stringify({
			initialGeometry,
			finalGeometry,
			mutationRequests,
			duplicateRiskDialog,
			viewport,
		})}`);
	} finally {
		await page.unrouteAll({ behavior: "wait" });
		await page.close();
	}
}

async function verifyViewport({ browser, baseUrl, storageState, name, viewport }) {
	const context = await browser.newContext({ viewport, storageState });
	try {
		await verifyOutboundDeliveryActions({ context, baseUrl, name, viewport });
		await verifyCompose({ context, baseUrl, name, viewport });
		await verifyComposeTerminalLock({ context, baseUrl, name, mode: "send" });
		await verifyComposeTerminalLock({ context, baseUrl, name, mode: "save-and-close" });
		await verifyBulk({ context, baseUrl, name, viewport });
		await verifyBulkInFlightRemoval({ context, baseUrl, name });
		if (name === "desktop") {
			await verifyBulkRetryCapacity({ context, baseUrl, pressure: "count" });
			await verifyBulkRetryCapacity({ context, baseUrl, pressure: "total" });
		}
	} finally {
		await context.close();
	}
}

async function main() {
	progress("Attachment retry Playwright verification starting");
	progress(`Detailed log: ${logFilePath}`);
	detail(`verification process pid ${process.pid}`);
	let stateDirectory;
	let browser;
	let serverProcess;
	let setupProcess;
	let cleanupInFlight;
	let signalCleanupInFlight;
	let signalCleanupKeepAlive;
	let acquisitionInFlight;
	const unhandledRejections = [];
	const handleUnhandledRejection = (reason) => {
		if (interruptedSignal) {
			detail(`ignored interrupted route rejection: ${reason instanceof Error ? reason.stack : reason}`);
			return;
		}
		unhandledRejections.push(reason);
		detail(`unhandled verification rejection: ${reason instanceof Error ? reason.stack : reason}`);
	};

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
			const [browserResult, serverResult, setupResult] = await Promise.allSettled([
				browserToClose
					? within(5_000, "Chromium close", browserToClose.close())
					: Promise.resolve(),
				serverToStop ? stopServer(serverToStop) : Promise.resolve(),
				setupToStop ? stopServer(setupToStop) : Promise.resolve(),
			]);
			const failures = [browserResult, serverResult, setupResult]
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason);
			if (browserResult.status === "fulfilled" && browser === browserToClose) browser = undefined;
			if (serverResult.status === "fulfilled" && serverProcess === serverToStop) serverProcess = undefined;
			if (setupResult.status === "fulfilled" && setupProcess === setupToStop) setupProcess = undefined;
			if (stateDirectory && !browser && !serverProcess && !setupProcess) {
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
		let lastFailure;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				await cleanup();
			} catch (error) {
				lastFailure = error;
			}
			if (!browser && !serverProcess && !setupProcess && !stateDirectory) return;
		}
		throw new AggregateError(
			[
				...(lastFailure ? [lastFailure] : []),
				new Error("Isolated Playwright resources remained after three cleanup attempts"),
			],
			"Playwright verification cleanup drain failed",
		);
	};
	const handleSignal = (signal) => {
		if (signalCleanupInFlight) return;
		interruptedSignal = signal;
		progress(`Interrupted by ${signal}; cleaning up isolated Playwright resources`);
		signalCleanupKeepAlive = setInterval(() => undefined, 1_000);
		signalCleanupInFlight = (async () => {
			if (acquisitionInFlight) {
				await acquisitionInFlight.catch((error) => {
					detail(`resource acquisition ended during ${signal}: ${error instanceof Error ? error.stack : error}`);
				});
			}
			await cleanup();
		})().catch((error) => {
			detail(`signal cleanup attempt failed: ${error instanceof Error ? error.stack : error}`);
		});
	};
	const handleSigint = () => handleSignal("SIGINT");
	const handleSigterm = () => handleSignal("SIGTERM");
	const handleSighup = () => handleSignal("SIGHUP");
	process.on("SIGINT", handleSigint);
	process.on("SIGTERM", handleSigterm);
	process.on("SIGHUP", handleSighup);
	process.on("unhandledRejection", handleUnhandledRejection);

	let verificationFailure;
	let cleanupFailure;
	try {
		throwIfInterrupted();
		stateDirectory = mkdtempSync(join(tmpdir(), "mail-portal-attachment-retry-"));
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
				WRANGLER_LOG_PATH: join(logDirectory, `wrangler-attachment-${runStamp}.log`),
			}),
			(process) => {
				setupProcess = process;
			},
		);
		throwIfInterrupted();
		progress("[2/5] Starting an isolated Wiser runtime");
		throwIfInterrupted();
		serverProcess = spawn(
			"npm",
			["exec", "--", "react-router", "dev", "--host", "127.0.0.1", "--port", String(port)],
			{
				cwd: root,
				env: localEnvironment({
					MAIL_PORTAL_PLAYWRIGHT_STATE: stateDirectory,
					MAIL_PORTAL_PLAYWRIGHT_CONFIG: playwrightConfigPath,
					WRANGLER_LOG_PATH: join(logDirectory, `wrangler-attachment-${runStamp}.log`),
				}),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		serverProcess.stdout.on("data", (chunk) => detail(`server stdout ${chunk}`));
		serverProcess.stderr.on("data", (chunk) => detail(`server stderr ${chunk}`));
		throwIfInterrupted();
		await waitForServer(baseUrl, serverProcess);
		throwIfInterrupted();
		const browserAcquisition = chromium.launch({
			headless: true,
			timeout: 15_000,
			handleSIGHUP: false,
			handleSIGINT: false,
			handleSIGTERM: false,
		})
			.then((launchedBrowser) => {
				browser = launchedBrowser;
				return launchedBrowser;
			});
		acquisitionInFlight = browserAcquisition;
		try {
			await browserAcquisition;
		} finally {
			if (acquisitionInFlight === browserAcquisition) acquisitionInFlight = undefined;
		}
		throwIfInterrupted();
		progress("[3/5] Bootstrapping the isolated local session");
		const storageState = await authenticate(browser, baseUrl);
		throwIfInterrupted();
		progress("[4/5] Verifying mobile compose and bulk recovery");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "mobile",
			viewport: { width: 390, height: 844 },
		});
		progress("[5/5] Verifying desktop compose and bulk recovery");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "desktop",
			viewport: { width: 1440, height: 900 },
		});
	} catch (error) {
		verificationFailure = error;
	} finally {
		try {
			await signalCleanupInFlight;
			await drainCleanup();
			if (interruptedSignal) {
				progress(`Cleanup completed for ${interruptedSignal}`);
			}
		} catch (error) {
			cleanupFailure = error;
		} finally {
			if (signalCleanupKeepAlive) clearInterval(signalCleanupKeepAlive);
			process.removeListener("SIGINT", handleSigint);
			process.removeListener("SIGTERM", handleSigterm);
			process.removeListener("SIGHUP", handleSighup);
			process.removeListener("unhandledRejection", handleUnhandledRejection);
		}
	}
	if (verificationFailure && cleanupFailure) {
		throw new AggregateError(
			[verificationFailure, cleanupFailure],
			"Playwright verification and cleanup both failed",
		);
	}
	if (verificationFailure) throw verificationFailure;
	if (cleanupFailure) throw cleanupFailure;
	throwIfInterrupted();
	if (unhandledRejections.length > 0) {
		throw new AggregateError(
			unhandledRejections,
			"Playwright verification had unhandled asynchronous failures",
		);
	}
	progress("PASS: compose and bulk attachment retries are exact at both widths");
}

main().catch((error) => {
	detail(formatFailure(error));
	if (interruptedSignal) {
		console.error(`INTERRUPTED: attachment retry Playwright verification stopped safely. See ${logFilePath}`);
		process.exitCode = 128 + constants.signals[interruptedSignal];
		return;
	}
	console.error(`FAIL: attachment retry Playwright verification failed. See ${logFilePath}`);
	process.exitCode = 1;
});
