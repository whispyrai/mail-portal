import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxRow } from "../db/users-schema.ts";
import {
	createMailboxAccess,
	type MailboxAccessRow,
	type MailboxAccessStore,
} from "./mailbox-access.ts";
import type { User } from "./users.ts";

function user(id: string, role: User["role"] = "AGENT", isActive = true): User {
	return {
		id,
		email: `${id}@wiserchat.ai`,
		password_hash: "hash",
		password_salt: "salt",
		session_version: 1,
		role,
		is_active: isActive ? 1 : 0,
		mailbox_address: `${id}@wiserchat.ai`,
		mcp_token_hash: null,
		recovery_email: null,
		created_at: 1,
		updated_at: 1,
	};
}

function mailbox(
	id: string,
	type: MailboxRow["type"],
	ownerUserId: string | null,
	isActive = true,
): MailboxRow {
	return {
		id,
		address: `${id}@wiserchat.ai`,
		type,
		owner_user_id: ownerUserId,
		is_active: isActive ? 1 : 0,
		created_at: 1,
		updated_at: 1,
	};
}

function memoryStore(input: {
	users: User[];
	mailboxes: MailboxRow[];
	memberships?: Array<{ mailboxId: string; userId: string }>;
}): MailboxAccessStore {
	const memberships = input.memberships ?? [];
	const accessRow = (mailbox: MailboxRow, userId: string): MailboxAccessRow => ({
		...mailbox,
		membership_user_id:
			memberships.find(
				(membership) =>
					membership.mailboxId === mailbox.id && membership.userId === userId,
			)?.userId ?? null,
	});

	return {
		async getUser(userId) {
			return input.users.find((candidate) => candidate.id === userId);
		},
		async listMailboxAccessRows(userId) {
			return input.mailboxes.map((candidate) => accessRow(candidate, userId));
		},
		async getMailboxAccessRow(userId, mailboxId) {
			const candidate = input.mailboxes.find((item) => item.id === mailboxId);
			return candidate ? accessRow(candidate, userId) : undefined;
		},
		async getMailbox(mailboxId) {
			return input.mailboxes.find((candidate) => candidate.id === mailboxId);
		},
		async listMailboxes() {
			return input.mailboxes;
		},
		async listMembershipMailboxIds() {
			return memberships.map((membership) => ({
				mailbox_id: membership.mailboxId,
			}));
		},
		async listMailboxMembers(mailboxId) {
			return memberships
				.filter((membership) => membership.mailboxId === mailboxId)
				.map((membership) => input.users.find((item) => item.id === membership.userId))
				.filter((item): item is User => Boolean(item))
				.map(({ id, email, role, is_active }) => ({ id, email, role, is_active }));
		},
		async addMailbox(candidate) {
			if (input.mailboxes.some((item) => item.id === candidate.id)) return false;
			input.mailboxes.push(candidate);
			return true;
		},
		async setMailboxActive(mailboxId, isActive) {
			const candidate = input.mailboxes.find((item) => item.id === mailboxId);
			if (!candidate) return false;
			candidate.is_active = isActive ? 1 : 0;
			return true;
		},
		async addMembership(mailboxId, userId) {
			if (
				memberships.some(
					(membership) =>
						membership.mailboxId === mailboxId && membership.userId === userId,
				)
			) {
				return false;
			}
			memberships.push({ mailboxId, userId });
			return true;
		},
		async removeMembership(mailboxId, userId) {
			const index = memberships.findIndex(
				(membership) =>
					membership.mailboxId === mailboxId && membership.userId === userId,
			);
			if (index === -1) return false;
			memberships.splice(index, 1);
			return true;
		},
	};
}

test("Personal Mailbox content is available only to its active owner", async () => {
	const owner = user("owner");
	const admin = user("admin", "ADMIN");
	const personal = mailbox("personal", "PERSONAL", owner.id);
	const access = createMailboxAccess(
		memoryStore({ users: [owner, admin], mailboxes: [personal] }),
	);

	assert.equal(await access.canAccessMailbox(owner.id, personal.id), true);
	assert.equal(await access.canAccessMailbox(admin.id, personal.id), false);
	assert.deepEqual(await access.listAccessibleMailboxes(admin.id), []);
});

test("Shared Mailbox content is available to explicit active members, not admins or nonmembers", async () => {
	const member = user("member");
	const nonmember = user("nonmember");
	const admin = user("admin", "ADMIN");
	const shared = mailbox("shared", "SHARED", null);
	const access = createMailboxAccess(
		memoryStore({
			users: [member, nonmember, admin],
			mailboxes: [shared],
			memberships: [{ mailboxId: shared.id, userId: member.id }],
		}),
	);

	assert.equal(await access.canAccessMailbox(member.id, shared.id), true);
	assert.equal(await access.canAccessMailbox(nonmember.id, shared.id), false);
	assert.equal(await access.canAccessMailbox(admin.id, shared.id), false);
	assert.deepEqual(await access.listAccessibleMailboxes(member.id), [shared]);
	assert.equal(
		await access.canManageMailboxSettings(member.id, shared.id),
		false,
	);
	assert.equal(await access.canManageMailboxSettings(admin.id, shared.id), true);
});

test("Personal Mailbox owners can manage settings without granting admins content access", async () => {
	const owner = user("owner");
	const admin = user("admin", "ADMIN");
	const personal = mailbox("personal", "PERSONAL", owner.id);
	const access = createMailboxAccess(
		memoryStore({ users: [owner, admin], mailboxes: [personal] }),
	);

	assert.equal(await access.canManageMailboxSettings(owner.id, personal.id), true);
	assert.equal(await access.canManageMailboxSettings(admin.id, personal.id), false);
	assert.equal(await access.canAccessMailbox(admin.id, personal.id), false);
});

test("Inactive users and inactive mailboxes are never accessible", async () => {
	const inactiveMember = user("inactive-member", "AGENT", false);
	const activeMember = user("active-member");
	const shared = mailbox("shared", "SHARED", null);
	const inactiveShared = mailbox("inactive-shared", "SHARED", null, false);
	const access = createMailboxAccess(
		memoryStore({
			users: [inactiveMember, activeMember],
			mailboxes: [shared, inactiveShared],
			memberships: [
				{ mailboxId: shared.id, userId: inactiveMember.id },
				{ mailboxId: inactiveShared.id, userId: activeMember.id },
			],
		}),
	);

	assert.equal(await access.canAccessMailbox(inactiveMember.id, shared.id), false);
	assert.equal(
		await access.canAccessMailbox(activeMember.id, inactiveShared.id),
		false,
	);
	assert.deepEqual(await access.listAccessibleMailboxes(inactiveMember.id), []);
	assert.deepEqual(await access.listAccessibleMailboxes(activeMember.id), []);
});

test("An active admin can add and remove active Shared Mailbox members", async () => {
	const admin = user("admin", "ADMIN");
	const member = user("member");
	const shared = mailbox("shared", "SHARED", null);
	const access = createMailboxAccess(
		memoryStore({ users: [admin, member], mailboxes: [shared] }),
	);

	await access.addSharedMailboxMember(admin.id, shared.id, member.id);
	assert.equal(await access.canAccessMailbox(member.id, shared.id), true);

	await access.removeSharedMailboxMember(admin.id, shared.id, member.id);
	assert.equal(await access.canAccessMailbox(member.id, shared.id), false);
});

test("Registering a Shared Mailbox does not grant its administrator content access", async () => {
	const admin = user("admin", "ADMIN");
	const mailboxes: MailboxRow[] = [];
	const access = createMailboxAccess(memoryStore({ users: [admin], mailboxes }));

	const registered = await access.registerSharedMailbox(
		admin.id,
		"support@wiserchat.ai",
	);

	assert.equal(registered.type, "SHARED");
	assert.equal(await access.canAccessMailbox(admin.id, registered.id), false);
	assert.deepEqual(await access.listSharedMailboxMembers(admin.id, registered.id), []);
});

test("Membership management rejects non-admins, inactive users, and Personal Mailboxes", async () => {
	const admin = user("admin", "ADMIN");
	const agent = user("agent");
	const inactiveMember = user("inactive-member", "AGENT", false);
	const shared = mailbox("shared", "SHARED", null);
	const personal = mailbox("personal", "PERSONAL", agent.id);
	const access = createMailboxAccess(
		memoryStore({
			users: [admin, agent, inactiveMember],
			mailboxes: [shared, personal],
		}),
	);

	await assert.rejects(
		() => access.addSharedMailboxMember(agent.id, shared.id, agent.id),
		/active administrator/,
	);
	await assert.rejects(
		() => access.addSharedMailboxMember(admin.id, shared.id, inactiveMember.id),
		/must be active/,
	);
	await assert.rejects(
		() => access.addSharedMailboxMember(admin.id, personal.id, agent.id),
		/Shared Mailboxes/,
	);
});
