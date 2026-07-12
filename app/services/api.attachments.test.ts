import assert from "node:assert/strict";
import test from "node:test";
import api from "./api.ts";

const validItem = {
	id: "file/1",
	emailId: "email/1",
	filename: "report.pdf",
	mimetype: "application/pdf",
	size: 10,
	kind: "pdf",
	message: {
		subject: "Report",
		sender: "sender@example.com",
		date: "2026-07-12T10:00:00.000Z",
		folderId: "inbox",
		folderName: "Inbox",
	},
};

test("attachment workbench list and detail use the mailbox metadata API", async () => {
	const requested: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => {
		requested.push(String(input));
		const body = String(input).endsWith("/file%2F1")
			? validItem
			: { items: [], nextCursor: null };
		return Promise.resolve(new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
	};
	try {
		await api.listMailboxAttachments("mailbox/1", {
			limit: 25,
			q: "board deck",
			kind: "presentation",
			folder: "sent/items",
			cursor: "cursor-1",
		});
		await api.getMailboxAttachment("mailbox/1", "file/1");
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(
		requested[0],
		"/api/v1/mailboxes/mailbox%2F1/attachments?limit=25&q=board+deck&kind=presentation&folder=sent%2Fitems&cursor=cursor-1",
	);
	assert.equal(
		requested[1],
		"/api/v1/mailboxes/mailbox%2F1/attachments/file%2F1",
	);
});

test("metadata APIs reject malformed JSON before it reaches query caches", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => Promise.resolve(new Response(JSON.stringify(
		String(input).endsWith("/bad")
			? { ...validItem, extra: true }
			: { items: [{ ...validItem, size: -1 }], nextCursor: null },
	), {
		status: 200,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.listMailboxAttachments("box", { limit: 25 }),
			/invalid response/i,
		);
		await assert.rejects(
			api.getMailboxAttachment("box", "bad"),
			/invalid response/i,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("byte preview is abortable and its URL remains email-scoped", async () => {
	let requestSignal: AbortSignal | null = null;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_input, init) => {
		requestSignal = init?.signal as AbortSignal;
		return new Promise<Response>((_resolve, reject) => {
			requestSignal?.addEventListener("abort", () => {
				reject(new DOMException("Aborted", "AbortError"));
			}, { once: true });
		});
	};
	const controller = new AbortController();
	const request = api.getAttachment("box", "email/1", "file/1", {
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(request, /abort/i);
	globalThis.fetch = originalFetch;

	assert.equal(requestSignal?.aborted, true);
	assert.equal(
		api.attachmentDownloadUrl("box", "email/1", "file/1"),
		"/api/v1/mailboxes/box/emails/email%2F1/attachments/file%2F1",
	);
});
