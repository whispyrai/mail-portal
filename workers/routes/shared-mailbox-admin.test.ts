import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import {
	MailboxAccessError,
	type SharedMailboxManagementAccess,
} from "../lib/mailbox-access.ts";
import type { Env } from "../types.ts";
import {
	createSharedMailboxAdminApp,
	type SharedMailboxAdminContext,
} from "./shared-mailbox-admin.ts";

const adminSession: SessionClaims = {
	sub: "usr_admin",
	email: "admin@wiserchat.ai",
	role: "ADMIN",
	mailbox: "admin@wiserchat.ai",
};

function managementAccess(
	overrides: Partial<SharedMailboxManagementAccess> = {},
): SharedMailboxManagementAccess {
	return {
		async requireMailboxAdministrator() {},
		async listManagedMailboxes() {
			return [];
		},
		async registerSharedMailbox() {
			return {
				id: "support@wiserchat.ai",
				address: "support@wiserchat.ai",
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
				created_at: 1,
				updated_at: 1,
			};
		},
		async listSharedMailboxMembers() {
			return [];
		},
		async addSharedMailboxMember() {
			return {
				id: "usr_member",
				email: "member@wiserchat.ai",
				role: "AGENT",
				is_active: 1,
			};
		},
		async removeSharedMailboxMember() {},
		async deactivateMailbox() {},
		...overrides,
	};
}

function testApp(input?: {
	session?: SessionClaims | null;
	access?: SharedMailboxManagementAccess;
	mailboxExists?: boolean;
	revokeMemberSideEffects?: (mailboxId: string, userId: string) => Promise<void>;
}) {
	const app = new Hono<SharedMailboxAdminContext>();
	app.use("*", async (c, next) => {
		if (input?.session !== null) {
			c.set("session", input?.session ?? adminSession);
		}
		await next();
	});
	app.route(
		"/api/v1/admin",
		createSharedMailboxAdminApp({
			access: () => input?.access ?? managementAccess(),
			mailboxMetadataExists: async () => input?.mailboxExists ?? true,
			revokeMemberSideEffects: input?.revokeMemberSideEffects
				? async (_env, mailboxId, userId) =>
					input.revokeMemberSideEffects!(mailboxId, userId)
				: undefined,
		}),
	);
	return app;
}

async function jsonRequest(
	app: Hono<SharedMailboxAdminContext>,
	path: string,
	init?: RequestInit,
) {
	return app.request(`http://mail.wiserchat.ai${path}`, init, {} as Env);
}

test("Shared Mailbox management requires authentication", async () => {
	const response = await jsonRequest(
		testApp({ session: null }),
		"/api/v1/admin/mailboxes",
	);

	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("Shared Mailbox management rejects a user who is not a live administrator", async () => {
	const access = managementAccess({
		async listManagedMailboxes() {
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/mailboxes",
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Only an active administrator can manage mailboxes",
	});
});

test("Registration authorizes the live administrator before revealing R2 metadata", async () => {
	const access = managementAccess({
		async requireMailboxAdministrator() {
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		},
	});
	const response = await jsonRequest(
		testApp({ access, mailboxExists: false }),
		"/api/v1/admin/shared-mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address: "missing@wiserchat.ai" }),
		},
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Only an active administrator can manage mailboxes",
	});
});

test("An administrator can list management metadata without mailbox content", async () => {
	const access = managementAccess({
		async listManagedMailboxes(adminUserId) {
			assert.equal(adminUserId, adminSession.sub);
			return [
				{
					id: "support@wiserchat.ai",
					address: "support@wiserchat.ai",
					type: "SHARED",
					owner_user_id: null,
					is_active: 1,
					created_at: 1,
					updated_at: 1,
					member_count: 3,
				},
			];
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/mailboxes",
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		mailboxes: [
			{
				id: "support@wiserchat.ai",
				address: "support@wiserchat.ai",
				type: "SHARED",
				isActive: true,
				ownerUserId: null,
				memberCount: 3,
			},
		],
	});
});

test("admin revocation suppresses in-flight mailbox management metadata", async () => {
	let adminChecks = 0;
	const access = managementAccess({
		async requireMailboxAdministrator() {
			adminChecks += 1;
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		},
		async listManagedMailboxes() {
			return [{
				id: "private@wiserchat.ai",
				address: "private@wiserchat.ai",
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
				created_at: 1,
				updated_at: 1,
				member_count: 3,
			}];
		},
	});

	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/mailboxes",
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Only an active administrator can manage mailboxes",
	});
	assert.equal(adminChecks, 1);
});

test("admin revocation wins over an in-flight mailbox metadata failure", async () => {
	const access = managementAccess({
		async requireMailboxAdministrator() {
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		},
		async listManagedMailboxes() {
			throw new Error("private mailbox metadata failure");
		},
	});

	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/mailboxes",
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Only an active administrator can manage mailboxes",
	});
});

test("An administrator can register existing R2 mailbox metadata as Shared", async () => {
	let registeredBy: string | undefined;
	let registeredAddress: string | undefined;
	const access = managementAccess({
		async registerSharedMailbox(adminUserId, address) {
			registeredBy = adminUserId;
			registeredAddress = address;
			return {
				id: address,
				address,
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
				created_at: 1,
				updated_at: 1,
			};
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address: "SUPPORT@WISERCHAT.AI" }),
		},
	);

	assert.equal(response.status, 201);
	assert.equal(registeredBy, adminSession.sub);
	assert.equal(registeredAddress, "support@wiserchat.ai");
	assert.deepEqual(await response.json(), {
		id: "support@wiserchat.ai",
		address: "support@wiserchat.ai",
		type: "SHARED",
		isActive: true,
		ownerUserId: null,
	});
});

test("Registration returns not found when R2 mailbox metadata does not exist", async () => {
	const response = await jsonRequest(
		testApp({ mailboxExists: false }),
		"/api/v1/admin/shared-mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address: "missing@wiserchat.ai" }),
		},
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), {
		error: "Mailbox metadata was not found",
	});
});

test("Registration returns conflict when the mailbox is already registered", async () => {
	const access = managementAccess({
		async registerSharedMailbox() {
			throw new MailboxAccessError(
				"CONFLICT",
				"Mailbox is already registered",
			);
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address: "support@wiserchat.ai" }),
		},
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Mailbox is already registered",
	});
});

test("An administrator can list Shared Mailbox members", async () => {
	const access = managementAccess({
		async listSharedMailboxMembers(adminUserId, mailboxId) {
			assert.equal(adminUserId, adminSession.sub);
			assert.equal(mailboxId, "support@wiserchat.ai");
			return [
				{
					id: "usr_member",
					email: "member@wiserchat.ai",
					role: "AGENT",
					is_active: 1,
				},
			];
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members",
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		members: [
			{
				id: "usr_member",
				email: "member@wiserchat.ai",
				role: "AGENT",
				isActive: true,
			},
		],
	});
});

test("admin revocation suppresses an in-flight Shared member roster", async () => {
	const access = managementAccess({
		async requireMailboxAdministrator() {
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		},
		async listSharedMailboxMembers() {
			return [{
				id: "private-user",
				email: "private-user@wiserchat.ai",
				role: "AGENT",
				is_active: 1,
			}];
		},
	});

	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members",
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Only an active administrator can manage mailboxes",
	});
});

test("An administrator can add an active user as a member", async () => {
	const response = await jsonRequest(
		testApp(),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "usr_member" }),
		},
	);

	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), {
		id: "usr_member",
		email: "member@wiserchat.ai",
		role: "AGENT",
		isActive: true,
	});
});

test("Adding an inactive user returns conflict", async () => {
	const access = managementAccess({
		async addSharedMailboxMember() {
			throw new MailboxAccessError(
				"CONFLICT",
				"A Shared Mailbox member must be active",
			);
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "usr_inactive" }),
		},
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "A Shared Mailbox member must be active",
	});
});

test("An administrator can remove a Shared Mailbox member", async () => {
	let removed: string | undefined;
	let disconnected: string | undefined;
	const access = managementAccess({
		async removeSharedMailboxMember(_adminUserId, _mailboxId, userId) {
			removed = userId;
		},
	});
	const response = await jsonRequest(
		testApp({
			access,
			revokeMemberSideEffects: async (mailboxId, userId) => {
				disconnected = `${mailboxId}:${userId}`;
			},
		}),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members/usr_member",
		{ method: "DELETE" },
	);

	assert.equal(response.status, 204);
	assert.equal(removed, "usr_member");
	assert.equal(disconnected, "support@wiserchat.ai:usr_member");
	assert.equal(await response.text(), "");
});

test("Removing a user who is not a member returns not found", async () => {
	const access = managementAccess({
		async removeSharedMailboxMember() {
			throw new MailboxAccessError(
				"NOT_FOUND",
				"Shared Mailbox member was not found",
			);
		},
	});
	const response = await jsonRequest(
		testApp({ access }),
		"/api/v1/admin/shared-mailboxes/support%40wiserchat.ai/members/usr_missing",
		{ method: "DELETE" },
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), {
		error: "Shared Mailbox member was not found",
	});
});
