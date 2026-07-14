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

test("staging upload sends the stable identity and original file through PUT", async () => {
	const uploadId = "95f6a780-cb27-4df2-a9da-49347f7c3d22";
	const file = new File([new Uint8Array([1, 2, 3])], "Q3 plan.pdf", {
		type: "application/pdf",
	});
	const controller = new AbortController();
	let requestedUrl = "";
	let requestedInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		requestedUrl = String(input);
		requestedInit = init;
		return Promise.resolve(new Response(JSON.stringify({
			uploadId,
			filename: "Q3 plan.pdf",
			mimetype: "application/pdf",
			size: 3,
			replayed: false,
		}), {
			status: 201,
			headers: { "content-type": "application/json" },
		}));
	};
	try {
		assert.deepEqual(
			await api.uploadAttachment("mailbox/1", uploadId, file, controller.signal),
			{
				uploadId,
				filename: "Q3 plan.pdf",
				mimetype: "application/pdf",
				size: 3,
				replayed: false,
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(
		requestedUrl,
		`/api/v1/mailboxes/mailbox%2F1/attachment-uploads/${uploadId}?filename=Q3+plan.pdf&type=application%2Fpdf`,
	);
	assert.equal(requestedInit?.method, "PUT");
	assert.equal(requestedInit?.body, file);
	assert.equal(requestedInit?.signal, controller.signal);
	assert.equal(new Headers(requestedInit?.headers).get("content-type"), "application/pdf");
});

test("staging upload rejects a response for a different upload identity", async () => {
	const requestedUploadId = "95f6a780-cb27-4df2-a9da-49347f7c3d22";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
		uploadId: "895dbb44-e8ba-45d1-8d75-c88fbc61cb35",
		filename: "report.pdf",
		mimetype: "application/pdf",
		size: 3,
		replayed: false,
	}), {
		status: 201,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.uploadAttachment(
				"mailbox/1",
				requestedUploadId,
				new File([new Uint8Array([1, 2, 3])], "report.pdf"),
			),
			/The attachment upload response could not be confirmed/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("staging upload rejects malformed success metadata", async () => {
	const uploadId = "95f6a780-cb27-4df2-a9da-49347f7c3d22";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
		uploadId,
		filename: "report.pdf",
		mimetype: "application/pdf",
		size: -1,
		replayed: "no",
	}), {
		status: 200,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.uploadAttachment(
				"mailbox/1",
				uploadId,
				new File([new Uint8Array([1, 2, 3])], "report.pdf"),
			),
			/The attachment upload response could not be confirmed/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("draft save rejects success without an authoritative attachment scope", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
		id: "draft-1",
		draft_version: 1,
		attachments: [],
	}), {
		status: 201,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.saveDraft("mailbox/1", { body: "Draft" }),
			/The saved draft attachment identity could not be confirmed/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
