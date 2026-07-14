import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	handleArchiveConversation,
	handleSetConversationRead,
	handleTrashConversation,
} from "./conversation-actions.ts";

const base = "/api/v1/mailboxes/team@example.com/conversations/conversation-1";

function appWithStub(stub: Record<string, unknown>) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "user@example.com",
			role: "MEMBER",
			mailbox: "user@example.com",
		});
		await next();
	});
	const route = "/api/v1/mailboxes/:mailboxId/conversations/:conversationId";
	app.post(`${route}/read`, handleSetConversationRead);
	app.post(`${route}/archive`, handleArchiveConversation);
	app.post(`${route}/trash`, handleTrashConversation);
	return app;
}

test("sets read state only for the conversation messages represented in the current folder", async () => {
	const app = appWithStub({
		async setConversationRead(
			conversationId: string,
			folderId: string,
			read: boolean,
			actor: unknown,
		) {
			assert.equal(conversationId, "conversation-1");
			assert.equal(folderId, "inbox");
			assert.equal(read, false);
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return { status: "updated", affectedCount: 3 };
		},
	});
	const response = await app.request(`http://local${base}/read`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ folderId: "inbox", read: false }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "updated", affectedCount: 3 });
});

test("archives only the represented current-folder messages with actor attribution", async () => {
	const app = appWithStub({
		async archiveConversation(
			conversationId: string,
			folderId: string,
			representativeEmailId: string,
			actor: unknown,
		) {
			assert.equal(conversationId, "conversation-1");
			assert.equal(folderId, "inbox");
			assert.equal(representativeEmailId, "message-2");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return { status: "archived", affectedCount: 2 };
		},
	});
	const response = await app.request(`http://local${base}/archive`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ folderId: "inbox", representativeEmailId: "message-2" }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "archived", affectedCount: 2 });
});

test("trash applies to represented Sent messages while retaining actor attribution", async () => {
	const app = appWithStub({
		async trashConversation(
			conversationId: string,
			folderId: string,
			representativeEmailId: string,
			actor: unknown,
		) {
			assert.equal(conversationId, "conversation-1");
			assert.equal(folderId, "sent");
			assert.equal(representativeEmailId, "message-2");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return { status: "trashed", affectedCount: 2 };
		},
	});
	const response = await app.request(`http://local${base}/trash`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ folderId: "sent", representativeEmailId: "message-2" }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "trashed", affectedCount: 2 });
});

test("rejects nonsensical conversation actions before mailbox mutation", async () => {
	const app = appWithStub({});
	const [readSent, archiveSent, trashDraft] = await Promise.all([
		app.request(`http://local${base}/read`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "sent", read: true }),
		}),
		app.request(`http://local${base}/archive`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "sent", representativeEmailId: "message-2" }),
		}),
		app.request(`http://local${base}/trash`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "draft", representativeEmailId: "message-2" }),
		}),
	]);
	assert.equal(readSent.status, 409);
	assert.equal(archiveSent.status, 409);
	assert.equal(trashDraft.status, 409);
});

test("requires the representative Message anchor for conversation moves", async () => {
	const app = appWithStub({});
	const [archive, trash] = await Promise.all([
		app.request(`http://local${base}/archive`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "inbox" }),
		}),
		app.request(`http://local${base}/trash`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "inbox" }),
		}),
	]);
	assert.equal(archive.status, 400);
	assert.equal(trash.status, 400);
});

test("returns a conflict when canonical folder policy rejects a display-name alias", async () => {
	const app = appWithStub({
		async archiveConversation(
			_conversationId: string,
			_folderId: string,
			_representativeEmailId: string,
			_actor: unknown,
		) {
			return { status: "invalid_action", affectedCount: 0 };
		},
	});
	const response = await app.request(`http://local${base}/archive`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ folderId: "Sent", representativeEmailId: "message-2" }),
	});

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "This conversation move is unavailable in this folder",
	});
});
