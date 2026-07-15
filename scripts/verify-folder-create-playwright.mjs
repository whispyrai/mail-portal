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
  return { promise, release: (value) => release(value) };
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH")
      return false;
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
    throw new Error(
      `Wiser test server process group ${serverProcess.pid} did not stop`);
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

async function assertPendingDialogLocked({
  page,
  dialog,
  viewport,
  primary,
  secondary,
}) {
  const box = await dialog.boundingBox();
  assert.ok(box);
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.width <= viewport.width);
  assert.ok(box.y + box.height <= viewport.height);
  assert.equal(await primary.isDisabled(), true);
  assert.equal(await secondary.isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  const outside =
    box.x > 4
      ? { x: 2, y: Math.min(viewport.height - 2, box.y + box.height / 2) }
      : box.y > 4
        ? { x: Math.min(viewport.width - 2, box.x + box.width / 2), y: 2 }
        : { x: viewport.width - 2, y: viewport.height - 2 };
  await page.mouse.click(outside.x, outside.y);
  assert.equal(await dialog.isVisible(), true);
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.scrollingElement?.scrollWidth ?? 0,
  }));
  detail(
    `pending dialog geometry ${JSON.stringify({ box, viewport, geometry, outside })}`,
  );
  assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));
  return box;
}

async function assertMobileFullWidthActions(dialog, actions, dialogBox) {
  for (const action of actions) {
    const box = await action.boundingBox();
    assert.ok(box);
    assert.ok(box.width >= dialogBox.width - 80);
  }
}

async function responseJson(response) {
  assert.ok(response.ok(), `${response.status()} ${await response.text()}`);
  return response.json();
}

async function mutateThroughApi(page, url, method, data) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(url, {
    method,
    headers: { Origin: origin, Referer: page.url() },
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(
    response.ok(),
    `${method} ${url}: ${response.status()} ${await response.text()}`,
  );
  return response.status() === 204 ? undefined : response.json();
}

async function verifyLabelReplay(page, mailboxId, viewportName) {
  const labelName = `Recovery label ${viewportName}`;
  const viewport = page.viewportSize();
  assert.ok(viewport);
  const gates = [deferred(), deferred()];
  const requests = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const responseJson = await upstream.json();
    requests.push({
      body: request.postDataJSON(),
      status: upstream.status(),
      responseJson,
    });
    await gates[requests.length - 1].promise;
    if (requests.length === 1) {
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
  };
  await page.route(`**/api/v1/mailboxes/${mailboxId}/labels`, handler);
  try {
    if (viewportName === "mobile") await openMobileSidebar(page);
    await page.getByRole("button", { name: "Manage mailbox labels" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage mailbox labels" });
    await dialog.waitFor();
    const input = dialog.getByLabel("New label");
    const color = dialog.getByLabel("Color").first();
    await input.fill(labelName);
    await color.selectOption("purple");
    await dialog.getByRole("button", { name: "Create" }).click();
    const pendingCreate = dialog.getByRole("button", { name: "Creating" });
    const done = dialog.getByRole("button", { name: "Done" });
    await pendingCreate.waitFor();
    assert.equal(await input.isDisabled(), true);
    assert.equal(await color.isDisabled(), true);
    const pendingBox = await assertPendingDialogLocked({
      page,
      dialog,
      viewport,
      primary: pendingCreate,
      secondary: done,
    });
    if (viewportName === "mobile") {
      await assertMobileFullWidthActions(
        dialog,
        [pendingCreate, done],
        pendingBox,
      );
    }
    gates[0].release();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    assert.equal(await input.inputValue(), labelName);
    assert.equal(await color.inputValue(), "purple");
    await input.fill(`  ${labelName.replace(" ", "   ")}  `);
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await page.screenshot({
      path: join(
        logDirectory,
        `label-create-${runStamp}-${viewportName}-failure.png`,
      ),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("button", { name: "Creating" }).waitFor();
    gates[1].release();
    await page.getByText(`Recovered ${labelName}`).waitFor();
    const editorName = dialog.locator(`input[value="${labelName}"]`);
    await editorName.waitFor();
    assert.equal(await editorName.inputValue(), labelName);
    assert.equal(await editorName.count(), 1);
    const list = await responseJson(
      await page.request.get(
        `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/labels`,
      ),
    );
    assert.equal(
      list.labels.filter(
        (label) =>
          label.id === requests[0].responseJson.label.id &&
          label.name === labelName,
      ).length,
      1,
    );
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.status),
      [201, 200],
    );
    assert.deepEqual(
      requests.map((request) => request.responseJson.replayed),
      [false, true],
    );
    assert.equal(
      requests[1].responseJson.label.id,
      requests[0].responseJson.label.id,
    );
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.equal(requests[0].body.name, labelName);
    assert.equal(requests[0].body.color, "purple");
    await page.screenshot({
      path: join(
        logDirectory,
        `label-create-${runStamp}-${viewportName}-success.png`,
      ),
      fullPage: true,
    });
  } finally {
    await page.unroute(`**/api/v1/mailboxes/${mailboxId}/labels`, handler);
  }
}

async function verifySavedViewReplay(page, mailboxId, viewportName) {
  const viewName = `Inbox recovery ${viewportName}`;
  const viewport = page.viewportSize();
  assert.ok(viewport);
  const routePattern = "**/api/v1/mailboxes/*/saved-views";
  const gates = [deferred(), deferred()];
  const requests = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const responseJson = await upstream.json();
    requests.push({
      body: request.postDataJSON(),
      status: upstream.status(),
      responseJson,
    });
    await gates[requests.length - 1].promise;
    if (requests.length === 1) {
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
  };
  await page.route(routePattern, handler);
  try {
    const closeSidebar = page.getByRole("button", { name: "Close sidebar" });
    if (await closeSidebar.isVisible()) {
      const viewport = page.viewportSize();
      assert.ok(viewport);
      await page.mouse.click(
        viewport.width - 12,
        Math.floor(viewport.height / 2),
      );
      await closeSidebar.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Save current view" }).click();
    const dialog = page.getByRole("dialog", { name: "Save current view" });
    await dialog.waitFor();
    const input = dialog.getByLabel("View name");
    const defaultName = await input.inputValue();
    await input.fill("Discarded clean edit");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Save current view" }).click();
    await dialog.waitFor();
    assert.equal(await input.inputValue(), defaultName);
    await input.fill(viewName);
    await dialog.getByRole("button", { name: "Save view" }).click();
    const pendingSave = dialog.getByRole("button", { name: "Saving…" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await pendingSave.waitFor();
    assert.equal(await input.isDisabled(), true);
    const pendingBox = await assertPendingDialogLocked({
      page,
      dialog,
      viewport,
      primary: pendingSave,
      secondary: cancel,
    });
    if (viewportName === "mobile") {
      await assertMobileFullWidthActions(
        dialog,
        [pendingSave, cancel],
        pendingBox,
      );
    }
    gates[0].release();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    assert.equal(await input.inputValue(), viewName);
    await cancel.click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Save current view" }).click();
    await dialog.waitFor();
    assert.equal(await input.inputValue(), viewName);
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await input.fill(`${viewName}   `);
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(
        logDirectory,
        `saved-view-create-${runStamp}-${viewportName}-failure.png`,
      ),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Save view" }).click();
    await dialog.getByRole("button", { name: "Saving…" }).waitFor();
    gates[1].release();
    await page.getByText("Saved view recovered").waitFor();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.status),
      [201, 200],
    );
    assert.deepEqual(
      requests.map((request) => request.responseJson.replayed),
      [false, true],
    );
    assert.equal(requests[1].responseJson.id, requests[0].responseJson.id);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.equal(requests[0].body.name, viewName);
    if (viewportName === "mobile") await openMobileSidebar(page);
    const savedViewLink = page
      .locator("aside")
      .getByText(viewName, { exact: true });
    await savedViewLink.waitFor();
    assert.equal(await savedViewLink.count(), 1);
    const list = await responseJson(
      await page.request.get(
        `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views`,
      ),
    );
    assert.equal(
      list.views.filter(
        (view) =>
          view.id === requests[0].responseJson.id && view.name === viewName,
      ).length,
      1,
    );
    const closeSidebarAfterList = page.getByRole("button", {
      name: "Close sidebar",
    });
    if (await closeSidebarAfterList.isVisible()) {
      await page.mouse.click(
        viewport.width - 12,
        Math.floor(viewport.height / 2),
      );
      await closeSidebarAfterList.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Save current view" }).click();
    await dialog.waitFor();
    assert.equal(await input.inputValue(), defaultName);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.screenshot({
      path: join(
        logDirectory,
        `saved-view-create-${runStamp}-${viewportName}-success.png`,
      ),
      fullPage: true,
    });
  } finally {
    await page.unroute(routePattern, handler);
  }
}

async function verifyFolderLifecycle(page, mailboxId, viewportName) {
  const originalName = `Folder lifecycle ${viewportName}`;
  const replacementName = `${originalName} replacement`;
  const mode = viewportName === "mobile" ? "superseded" : "unavailable";
  const pattern = `**/api/v1/mailboxes/${mailboxId}/folders`;
  const committed = deferred();
  const releaseAbort = deferred();
  const requests = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const json = await upstream.json();
    requests.push({
      body: request.postDataJSON(),
      status: upstream.status(),
      json,
    });
    if (requests.length === 1) {
      committed.release(json);
      await releaseAbort.promise;
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
  };
  await page.route(pattern, handler);
  try {
    if (viewportName === "mobile") await openMobileSidebar(page);
    const dialog = await openCreateFolderDialog(page);
    const input = dialog.getByLabel("Folder name");
    await input.fill(originalName);
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("button", { name: "Creating" }).waitFor();
    const resource = await committed.promise;
    const resourceUrl = `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders/${encodeURIComponent(resource.id)}`;
    if (mode === "superseded") {
      await mutateThroughApi(page, resourceUrl, "PUT", {
        name: `${originalName} renamed`,
      });
    } else {
      await mutateThroughApi(page, resourceUrl, "DELETE");
    }
    releaseAbort.release();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog
      .getByRole("alert")
      .filter({
        hasText: mode === "superseded" ? "later renamed" : "later deleted",
      })
      .waitFor();
    assert.equal(await input.inputValue(), originalName);
    const listAfterLifecycle = await responseJson(
      await page.request.get(
        `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`,
      ),
    );
    const original = listAfterLifecycle.filter(
      (folder) => folder.id === resource.id,
    );
    if (mode === "superseded") {
      assert.equal(original.length, 1);
      assert.equal(original[0].name, `${originalName} renamed`);
    } else {
      assert.equal(original.length, 0);
    }
    assert.equal(
      listAfterLifecycle.filter((folder) => folder.name === originalName)
        .length,
      0,
    );
    await input.fill(replacementName);
    await dialog.getByRole("button", { name: "Create" }).click();
    await page.getByText(`Created ${replacementName}`).waitFor();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      requests.map((request) => request.status),
      [201, 409, 201],
    );
    assert.equal(requests[1].json.code, `creation_${mode}`);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.notEqual(requests[2].body.operationId, requests[0].body.operationId);
    assert.equal(requests[2].body.name, replacementName);
  } finally {
    await page.unroute(pattern, handler);
  }
}

async function verifyLabelLifecycle(page, mailboxId, viewportName) {
  const originalName = `Label lifecycle ${viewportName}`;
  const replacementName = `${originalName} replacement`;
  const mode = viewportName === "mobile" ? "unavailable" : "superseded";
  const pattern = `**/api/v1/mailboxes/${mailboxId}/labels`;
  const committed = deferred();
  const releaseAbort = deferred();
  const requests = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const json = await upstream.json();
    requests.push({
      body: request.postDataJSON(),
      status: upstream.status(),
      json,
    });
    if (requests.length === 1) {
      committed.release(json);
      await releaseAbort.promise;
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
  };
  await page.route(pattern, handler);
  try {
    if (viewportName === "mobile") await openMobileSidebar(page);
    await page.getByRole("button", { name: "Manage mailbox labels" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage mailbox labels" });
    await dialog.waitFor();
    const input = dialog.getByLabel("New label");
    const color = dialog.getByLabel("Color").first();
    await input.fill(originalName);
    await color.selectOption("teal");
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("button", { name: "Creating" }).waitFor();
    const resource = (await committed.promise).label;
    const resourceUrl = `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/labels/${encodeURIComponent(resource.id)}`;
    if (mode === "superseded") {
      await mutateThroughApi(page, resourceUrl, "PUT", {
        name: `${originalName} changed`,
        color: "orange",
      });
    } else {
      await mutateThroughApi(page, resourceUrl, "DELETE");
    }
    releaseAbort.release();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog
      .getByRole("alert")
      .filter({
        hasText: mode === "superseded" ? "later changed" : "later deleted",
      })
      .waitFor();
    const listAfterLifecycle = await responseJson(
      await page.request.get(
        `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/labels`,
      ),
    );
    const original = listAfterLifecycle.labels.filter(
      (label) => label.id === resource.id,
    );
    if (mode === "superseded") {
      assert.equal(original.length, 1);
      assert.equal(original[0].name, `${originalName} changed`);
      assert.equal(original[0].color, "orange");
    } else {
      assert.equal(original.length, 0);
    }
    assert.equal(
      listAfterLifecycle.labels.filter((label) => label.name === originalName)
        .length,
      0,
    );
    await input.fill(replacementName);
    await dialog.getByRole("button", { name: "Create" }).click();
    await page.getByText(`Created ${replacementName}`).waitFor();
    assert.deepEqual(
      requests.map((request) => request.status),
      [201, 409, 201],
    );
    assert.equal(requests[1].json.code, `creation_${mode}`);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.notEqual(requests[2].body.operationId, requests[0].body.operationId);
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await page.unroute(pattern, handler);
  }
}

async function verifySavedViewLifecycle(page, mailboxId, viewportName) {
  const originalName = `View lifecycle ${viewportName}`;
  const replacementName = `${originalName} replacement`;
  const mode = viewportName === "mobile" ? "superseded" : "unavailable";
  const pattern = "**/api/v1/mailboxes/*/saved-views";
  const committed = deferred();
  const releaseAbort = deferred();
  const requests = [];
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const json = await upstream.json();
    requests.push({
      body: request.postDataJSON(),
      status: upstream.status(),
      json,
    });
    if (requests.length === 1) {
      committed.release(json);
      await releaseAbort.promise;
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
  };
  await page.route(pattern, handler);
  try {
    const closeSidebar = page.getByRole("button", { name: "Close sidebar" });
    if (await closeSidebar.isVisible()) {
      const viewport = page.viewportSize();
      assert.ok(viewport);
      await page.mouse.click(
        viewport.width - 12,
        Math.floor(viewport.height / 2),
      );
      await closeSidebar.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Save current view" }).click();
    const dialog = page.getByRole("dialog", { name: "Save current view" });
    await dialog.waitFor();
    const input = dialog.getByLabel("View name");
    await input.fill(originalName);
    await dialog.getByRole("button", { name: "Save view" }).click();
    await dialog.getByRole("button", { name: "Saving…" }).waitFor();
    const resource = await committed.promise;
    const resourceUrl = `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views/${encodeURIComponent(resource.id)}`;
    if (mode === "superseded") {
      const { operationId: _operationId, ...definition } = requests[0].body;
      await mutateThroughApi(page, resourceUrl, "PUT", {
        ...definition,
        name: `${originalName} changed`,
      });
    } else {
      await mutateThroughApi(page, resourceUrl, "DELETE");
    }
    releaseAbort.release();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    await dialog.getByRole("button", { name: "Save view" }).click();
    await dialog
      .getByRole("alert")
      .filter({
        hasText: mode === "superseded" ? "later changed" : "later deleted",
      })
      .waitFor();
    const listAfterLifecycle = await responseJson(
      await page.request.get(
        `${new URL(page.url()).origin}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views`,
      ),
    );
    const original = listAfterLifecycle.views.filter(
      (view) => view.id === resource.id,
    );
    if (mode === "superseded") {
      assert.equal(original.length, 1);
      assert.equal(original[0].name, `${originalName} changed`);
    } else {
      assert.equal(original.length, 0);
    }
    assert.equal(
      listAfterLifecycle.views.filter((view) => view.name === originalName)
        .length,
      0,
    );
    await input.fill(replacementName);
    await dialog.getByRole("button", { name: "Save view" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      requests.map((request) => request.status),
      [201, 409, 201],
    );
    assert.equal(requests[1].json.code, `creation_${mode}`);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.notEqual(requests[2].body.operationId, requests[0].body.operationId);
  } finally {
    await page.unroute(pattern, handler);
  }
}

async function verifyViewport({
  browser,
  baseUrl,
  storageState,
  name,
  viewport,
}) {
  const folderName = `Client Projects ${name}`;
  const context = await browser.newContext({ viewport, storageState });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const postBodies = [];
  const postStatuses = [];
  const replayFlags = [];
  const postResponseJson = [];
  let postCount = 0;
  let folderReads = 0;
  const postResponseGates = [deferred(), deferred()];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      errorText: request.failure()?.errorText ?? "",
    }),
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
      await route.continue();
      return;
    }
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }

    postCount += 1;
    postBodies.push(request.postDataJSON());
    const upstream = await route.fetch();
    const responseJson = await upstream.json();
    postStatuses.push(upstream.status());
    replayFlags.push(responseJson.replayed);
    postResponseJson.push(responseJson);
    const responseGate = postResponseGates[postCount - 1];
    assert.ok(responseGate, `Unexpected folder POST ${postCount}`);
    await responseGate.promise;
    if (postCount === 1) {
      assert.equal(upstream.status(), 201);
      assert.equal(responseJson.replayed, false);
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({ response: upstream });
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
    await input.fill(folderName);
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("button", { name: "Creating" }).waitFor();
    assert.equal(
      (await input.inputValue()).trim().replace(/\s+/g, " "),
      folderName,
    );
    assert.equal(await input.isDisabled(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "Cancel" }).isDisabled(),
      true,
    );
    const pendingBox = await assertPendingDialogLocked({
      page,
      dialog,
      viewport,
      primary: dialog.getByRole("button", { name: "Creating" }),
      secondary: dialog.getByRole("button", { name: "Cancel" }),
    });

    postResponseGates[0].release();
    await page
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await input.inputValue(), folderName);
    assert.equal(await input.isEnabled(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "Create" }).isEnabled(),
      true,
    );
    await input.fill(`  ${folderName.replace(" ", "   ")}  `);
    await page
      .getByRole("alert")
      .filter({ hasText: "couldn’t confirm" })
      .waitFor();
    if (name === "mobile") {
      await assertMobileFullWidthActions(
        dialog,
        [
          dialog.getByRole("button", { name: "Create" }),
          dialog.getByRole("button", { name: "Cancel" }),
        ],
        pendingBox,
      );
    }
    await page.screenshot({
      path: join(logDirectory, `folder-create-${runStamp}-${name}-failure.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.getByRole("button", { name: "Creating" }).waitFor();
    assert.equal(
      (await input.inputValue()).trim().replace(/\s+/g, " "),
      folderName,
    );
    assert.equal(await input.isDisabled(), true);
    postResponseGates[1].release();
    await page.getByText(`Recovered ${folderName}`).waitFor();
    await dialog.waitFor({ state: "hidden" });
    const folderLink = page
      .locator("aside")
      .getByText(folderName, { exact: true });
    await folderLink.waitFor();
    assert.equal(await folderLink.count(), 1);
    const folderList = await responseJson(
      await page.request.get(
        `${baseUrl}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`,
      ),
    );
    assert.equal(
      folderList.filter(
        (folder) =>
          folder.id === postResponseJson[0].id && folder.name === folderName,
      ).length,
      1,
    );
    await page.screenshot({
      path: join(logDirectory, `folder-create-${runStamp}-${name}-success.png`),
      fullPage: true,
    });
    await page.unroute("**/api/v1/mailboxes/*/folders");
    await verifyFolderLifecycle(page, mailboxId, name);
    await verifyLabelReplay(page, mailboxId, name);
    await verifyLabelLifecycle(page, mailboxId, name);
    await verifySavedViewReplay(page, mailboxId, name);
    await verifySavedViewLifecycle(page, mailboxId, name);

    assert.equal(postBodies.length, 2);
    assert.equal(postBodies[0].name, folderName);
    assert.deepEqual(postBodies[1], postBodies[0]);
    assert.match(postBodies[0].operationId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(postStatuses, [201, 200]);
    assert.deepEqual(replayFlags, [false, true]);
    assert.equal(postResponseJson[1].id, postResponseJson[0].id);
    assert.ok(
      folderReads >= 2,
      `Expected an invalidation refetch, received ${folderReads}`,
    );
    assert.deepEqual(pageErrors, []);
    const resetMutationErrors = consoleErrors.filter((message) =>
      message.startsWith("Mutation failed: TypeError: Failed to fetch\n"),
    );
    assert.equal(resetMutationErrors.length, 6, JSON.stringify(consoleErrors));
    const lifecycleResourceErrors = consoleErrors.filter(
      (message) =>
        message ===
        "Failed to load resource: the server responded with a status of 409 (Conflict)",
    );
    assert.equal(
      lifecycleResourceErrors.length,
      3,
      JSON.stringify(consoleErrors),
    );
    const resetResourceErrors = consoleErrors.filter(
      (message) =>
        message === "Failed to load resource: net::ERR_CONNECTION_RESET",
    );
    assert.equal(resetResourceErrors.length, 6, JSON.stringify(consoleErrors));
    const lifecycleMutationErrors = consoleErrors.filter(
      (message) =>
        message.startsWith(
          "Mutation failed: ApiError: The folder was created and later",
        ) ||
        message.startsWith(
          "Mutation failed: ApiError: The label was created and later",
        ) ||
        message.startsWith(
          "Mutation failed: SavedViewApiError: The saved view was created and later",
        ),
    );
    assert.equal(
      lifecycleMutationErrors.length,
      3,
      JSON.stringify(consoleErrors),
    );
    const expectedConsoleErrors = new Set([
      ...resetMutationErrors,
      ...resetResourceErrors,
      ...lifecycleResourceErrors,
      ...lifecycleMutationErrors,
    ]);
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) =>
        !expectedConsoleErrors.has(message) &&
        !message.includes("Failed to fetch manifest patches"),
    );
    assert.deepEqual(unexpectedConsoleErrors, []);
    assert.equal(requestFailures.length, 6, JSON.stringify(requestFailures));
    assert.deepEqual(
      requestFailures.map((failure) => new URL(failure.url).pathname).sort(),
      [
        `/api/v1/mailboxes/${mailboxId}/folders`,
        `/api/v1/mailboxes/${mailboxId}/folders`,
        `/api/v1/mailboxes/${mailboxId}/labels`,
        `/api/v1/mailboxes/${mailboxId}/labels`,
        `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views`,
        `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/saved-views`,
      ].sort(),
    );
    assert.equal(
      requestFailures.every((failure) =>
        failure.errorText.includes("ERR_CONNECTION_RESET"),
      ),
      true,
      JSON.stringify(requestFailures),
    );
    const geometry = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.scrollingElement?.scrollWidth ?? 0,
    }));
    assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));

    detail(
      `${name} ${JSON.stringify({ postBodies, postStatuses, replayFlags, folderReads, geometry, requestFailures })}`,
    );
  } catch (error) {
    detail(
      `${name} diagnostic error ${error instanceof Error ? error.stack : error}`,
    );
    detail(`${name} diagnostic URL ${page.url()}`);
		detail(`${name} diagnostic body ${(await page.locator("body").innerText()).slice(0, 4_000)}`);
		await page.screenshot({
			path: join(logDirectory, `folder-create-${runStamp}-${name}-diagnostic.png`,
      ),
      fullPage: true,
    });
    throw error;
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function main() {
  progress("Folder, Label, and Saved View replay verification starting");
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
		serverProcess.stderr.on("data", (chunk) => detail(`server stderr ${chunk}`),
    );
    await waitForServer(baseUrl, serverProcess);
    throwIfInterrupted();

    browser = await chromium.launch({ headless: true });
    throwIfInterrupted();
    progress("[3/5] Bootstrapping the isolated local session");
    const storageState = await authenticate(browser, baseUrl);
    progress("[4/5] Verifying mobile committed-response recovery and layout");
    await verifyViewport({
      browser,
      baseUrl,
      storageState,
      name: "mobile",
      viewport: { width: 390, height: 844 },
    });
    progress("[5/5] Verifying desktop committed-response recovery and layout");
    await verifyViewport({
      browser,
      baseUrl,
      storageState,
      name: "desktop",
      viewport: { width: 1440, height: 900 },
    });
    progress(
      "PASS: Folder, Label, and Saved View creation are truthful and recoverable at both widths",
    );
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
  detail(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  console.error(
    `FAIL: resource create replay verification failed. See ${logFilePath}`);
	process.exitCode = interruptedSignal
		? 128 + constants.signals[interruptedSignal]
		: 1;
});
