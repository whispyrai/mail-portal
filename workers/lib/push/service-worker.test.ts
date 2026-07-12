// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const serviceWorkerSource = readFileSync(
	new URL("../../../public/sw.js", import.meta.url),
	"utf8",
);

test("push display uses the exact Message identity as its stable notification tag", () => {
	assert.match(serviceWorkerSource, /tag:\s*notificationTag/);
	assert.match(serviceWorkerSource, /typeof data\.emailId === "string"/);
});

type WindowClientDouble = {
	url: string;
	focus: () => Promise<void>;
	navigate?: (url: string) => Promise<unknown>;
};

function notificationClickHandlerFor(
	client: WindowClientDouble,
	matchAll: () => Promise<WindowClientDouble[]> = async () => [client],
) {
	const handlers = new Map<string, (event: unknown) => void>();
	const openedUrls: string[] = [];
	const self = {
		location: { origin: "https://mail.example.test" },
		clients: {
			claim: async () => undefined,
			matchAll,
			openWindow: async (url: string) => {
				openedUrls.push(url);
			},
		},
		registration: { showNotification: async () => undefined },
		skipWaiting: () => undefined,
		addEventListener: (name: string, handler: (event: unknown) => void) => {
			handlers.set(name, handler);
		},
	};

	runInNewContext(serviceWorkerSource, {
		self,
		console: { error: () => undefined, warn: () => undefined },
	});
	const handler = handlers.get("notificationclick");
	assert.ok(handler, "service worker registers a notificationclick handler");
	return { handler, openedUrls };
}

test("notification click opens a new window when same-origin navigation returns null", async () => {
	let navigationUrl = "";
	const { handler, openedUrls } = notificationClickHandlerFor({
		url: "https://mail.example.test/inbox",
		focus: async () => undefined,
		navigate: async (url) => {
			navigationUrl = url;
			return null;
		},
	});
	let work: Promise<unknown> | undefined;

	handler({
		notification: {
			close: () => undefined,
			data: { clickUrl: "/mail/abc" },
		},
		waitUntil: (promise: Promise<unknown>) => {
			work = promise;
		},
	});
	assert.ok(work, "notification work is registered with waitUntil");
	await work;

	assert.equal(navigationUrl, "/mail/abc");
	assert.deepEqual(openedUrls, ["/mail/abc"]);
});

test("notification click opens a new window when same-origin navigation rejects", async () => {
	const { handler, openedUrls } = notificationClickHandlerFor({
		url: "https://mail.example.test/inbox",
		focus: async () => undefined,
		navigate: async () => {
			throw new Error("window closed during navigation");
		},
	});
	let work: Promise<unknown> | undefined;

	handler({
		notification: {
			close: () => undefined,
			data: { clickUrl: "/mail/def" },
		},
		waitUntil: (promise: Promise<unknown>) => {
			work = promise;
		},
	});
	assert.ok(work, "notification work is registered with waitUntil");
	await work;

	assert.deepEqual(openedUrls, ["/mail/def"]);
});

test("notification click opens a new window when client lookup rejects", async () => {
	const { handler, openedUrls } = notificationClickHandlerFor(
		{
			url: "https://mail.example.test/inbox",
			focus: async () => undefined,
		},
		async () => {
			throw new Error("client registry unavailable");
		},
	);
	let work: Promise<unknown> | undefined;

	handler({
		notification: {
			close: () => undefined,
			data: { clickUrl: "/mail/ghi" },
		},
		waitUntil: (promise: Promise<unknown>) => {
			work = promise;
		},
	});
	assert.ok(work, "notification work is registered with waitUntil");
	await work;

	assert.deepEqual(openedUrls, ["/mail/ghi"]);
});
