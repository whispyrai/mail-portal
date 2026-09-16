import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MessageViewerReport } from "../../shared/message-viewer-diagnostics.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { messageViewerDiagnosticsRoutes } from "./message-viewer-diagnostics.ts";

const report: MessageViewerReport = {
	messageId: "sent-1",
	folderId: "sent",
	bodyExternal: false,
	outcome: "never_reported",
	trigger: "settled",
	elapsedMs: 5000,
	retries: 4,
	firstReportMs: null,
	reportedHeight: null,
	frameTextLength: null,
	bodyLength: 900,
	sanitizedLength: 880,
	sanitizedTextLength: 120,
	frameClientWidth: 640,
	frameClientHeight: 100,
	frameDisplayed: true,
	remoteImagesBlocked: false,
	inlineImageCount: 0,
	documentVisibility: "visible",
	viewportWidth: 1440,
	viewportHeight: 800,
	devicePixelRatio: 2,
	build: "https://mail.example/assets/EmailPanel-abc.js",
};

function app(withSession = true) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		if (withSession) c.set("session", {
			sub: "actor-1", email: "actor@example.com", role: "AGENT", mailbox: "team@example.com",
		});
		await next();
	});
	root.route("/", messageViewerDiagnosticsRoutes);
	return root;
}

function post(body: string, withSession = true) {
	return app(withSession).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/message-viewer-reports",
		{ method: "POST", body, headers: { "User-Agent": "TeamLaptop/1.0" } },
	);
}

function captureConsole<T>(run: () => Promise<T>) {
	const lines: Array<{ level: string; args: unknown[] }> = [];
	const original = { log: console.log, warn: console.warn };
	console.log = (...args: unknown[]) => lines.push({ level: "log", args });
	console.warn = (...args: unknown[]) => lines.push({ level: "warn", args });
	return run().finally(() => Object.assign(console, original)).then((result) => ({ result, lines }));
}

test("a failed render is logged as a warning with who, which mailbox and which browser", async () => {
	const { result, lines } = await captureConsole(() => post(JSON.stringify(report)));
	assert.equal(result.status, 204);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].level, "warn");
	assert.equal(lines[0].args[0], "[message-viewer] never_reported");
	assert.deepEqual(lines[0].args[1], {
		operation: "message_viewer_report",
		mailboxId: "team@example.com",
		userId: "actor-1",
		userEmail: "actor@example.com",
		userAgent: "TeamLaptop/1.0",
		...report,
	});
});

test("a healthy render is logged at info level", async () => {
	const { result, lines } = await captureConsole(() =>
		post(JSON.stringify({ ...report, outcome: "rendered", frameTextLength: 120 })),
	);
	assert.equal(result.status, 204);
	assert.equal(lines[0].level, "log");
	assert.equal(lines[0].args[0], "[message-viewer] rendered");
});

test("malformed, oversized, content-bearing and anonymous reports are refused unlogged", async () => {
	const cases: Array<[string, boolean, number]> = [
		["not json", true, 400],
		[JSON.stringify({ ...report, outcome: "maybe" }), true, 400],
		[JSON.stringify({ ...report, body: "private text" }), true, 400],
		[JSON.stringify({ ...report, retries: -1 }), true, 400],
		[JSON.stringify({ ...report, build: "x".repeat(5000) }), true, 413],
		[JSON.stringify(report), false, 401],
	];
	for (const [body, withSession, status] of cases) {
		const { result, lines } = await captureConsole(() => post(body, withSession));
		assert.equal(result.status, status, body.slice(0, 40));
		assert.equal(lines.length, 0);
	}
});
