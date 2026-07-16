import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import {
	storeParsedEmail as storeParsedEmailProduction,
	type EmailStorageDependencies,
} from "./store-email.ts";
import type { InboundProjectionCommand } from "./inbound-projection-contract.ts";
import { liveInboundProjectionOptions } from "./live-inbound-projection.ts";
import { resolveUnambiguousThreadReference } from "./thread-reference.ts";

async function storeParsedEmail(
	dependencies: Parameters<typeof storeParsedEmailProduction>[0],
	parsed: Parameters<typeof storeParsedEmailProduction>[1],
	options: Parameters<typeof storeParsedEmailProduction>[2],
) {
	return storeParsedEmailProduction(dependencies, parsed, {
		recipientMemoryOrigin: "admin_import",
		...options,
	});
}

function dependencies() {
	const created: Array<Record<string, unknown>> = [];
	const storedAttachments: Array<Array<Record<string, unknown>>> = [];
	const storedKeys: string[] = [];
	const value: EmailStorageDependencies = {
		bucket: {
				async put(key, content) {
					storedKeys.push(key);
					const size = typeof content === "string"
						? new TextEncoder().encode(content).byteLength
						: content instanceof ReadableStream
							? (await new Response(content).arrayBuffer()).byteLength
							: content.byteLength;
					return { size };
				},
			async delete() {},
		},
		mailbox: {
			async createEmail(_folder, email, attachments) {
				created.push(email);
				storedAttachments.push(attachments);
			},
			async resolveCanonicalThreadId(ids) {
				return resolveUnambiguousThreadReference(ids, created.map((email) => ({
					id: String(email.id),
					messageId: typeof email.message_id === "string" ? email.message_id : null,
					threadId: typeof email.thread_id === "string" ? email.thread_id : null,
				})));
			},
			async getEmail() { return null; },
		},
	};
	return { value, created, storedAttachments, storedKeys };
}

function parsed(overrides: Partial<Email> = {}): Email {
	return {
		subject: "Renewal",
		from: { address: "customer@example.com" },
		to: [{ address: "team@example.com" }],
		attachments: [],
		headers: [],
		...overrides,
	} as Email;
}

test("heuristic same-subject threading never gains Snooze wake authority", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed(), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "mail_1",
		wakeSnoozedOnReply: true,
	});
	assert.equal(state.created[0]!.thread_id, "mail_1");
	assert.equal(state.created[0]!.snooze_wake_thread_id, null);
});

test("storeParsedEmail persists only normalized control-safe structured sender names", async () => {
	const valid = dependencies();
	await storeParsedEmail(valid.value, parsed({
		from: { address: "person@example.com", name: "  Person   Name  " },
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "valid-name",
	});
	assert.equal(valid.created[0]?.sender_name, "Person Name");

	const unsafe = dependencies();
	await storeParsedEmail(unsafe.value, parsed({
		from: { address: "person@example.com", name: "Deceptive\u202EName" },
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "unsafe-name",
	});
	assert.equal(unsafe.created[0]?.sender_name, null);
});

test("live RFC reply identity may wake its exact stored thread", async () => {
		const state = dependencies();
		const commands: InboundProjectionCommand[] = [];
		state.value.mailbox.createInboundEmail = async (command) => {
			commands.push(command);
			state.created.push(command.email);
			state.storedAttachments.push(command.attachments);
			return { status: "stored" };
		};
		await storeParsedEmailProduction(state.value, parsed({
			messageId: "<raw-original@example.com>",
		}), liveInboundProjectionOptions({
			brand: "wiser",
			mailboxId: "team@example.com",
			date: "2026-07-11T09:00:00.000Z",
			messageId: "internal-original",
		}));
		const signal = await storeParsedEmailProduction(state.value, parsed({
			inReplyTo: "<raw-original@example.com>",
		}), liveInboundProjectionOptions({
			brand: "wiser",
			mailboxId: "team@example.com",
			date: "2026-07-11T10:00:00.000Z",
			messageId: "internal-reply",
		}));
		assert.equal(state.created[0]!.message_id, "raw-original@example.com");
		assert.equal(state.created[1]!.thread_id, "internal-original");
		assert.equal(state.created[1]!.snooze_wake_thread_id, "internal-original");
		assert.equal(commands.length, 2);
		assert.equal(commands[1]?.folder, "inbox");
		assert.equal(commands[1]?.mailboxAddress, "team@example.com");
		assert.equal(commands[1]?.allowTerminalRecovery, false);
		assert.deepEqual(commands[1]?.attachments, []);
		assert.deepEqual(commands[1]?.bodyObjects, []);
		assert.equal(commands[1]?.email.id, "internal-reply");
		assert.equal(commands[1]?.email.read, false);
		assert.equal(commands[1]?.email.recipient_memory_origin, "live_inbound");
		assert.equal(commands[1]?.email.automation_trigger, "live_inbound");
		assert.equal(
			commands[1]?.email.follow_up_reply_mailbox_address,
			"team@example.com",
		);
		assert.deepEqual(commands[1]?.email.push_notification.data, {
			emailId: "internal-reply",
			mailboxId: "team@example.com",
		});
	assert.deepEqual(signal, {
		conversationKey: "internal-original",
		inboundMessageId: "internal-reply",
		inboundMessageDate: "2026-07-11T10:00:00.000Z",
	});
});

test("live projection surfaces active derived-content deletion as a retryable conflict", async () => {
	const state = dependencies();
	state.value.mailbox.createInboundEmail = async () => ({
		status: "cleanup_conflict",
	});
	await assert.rejects(
		() =>
			storeParsedEmailProduction(
				state.value,
				parsed(),
				liveInboundProjectionOptions({
					brand: "wiser",
					mailboxId: "team@example.com",
					date: "2026-07-15T10:00:00.000Z",
					messageId: "cleanup-conflict",
				}),
			),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "INBOUND_DERIVED_CONTENT_CLEANUP_CONFLICT",
	);
});

test("imports never wake Snoozed mail even when they carry a derived thread ID", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed({
		inReplyTo: "<authoritative-thread>",
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "mail_1",
		threadId: "import-thread",
	});
	assert.equal(state.created[0]!.thread_id, "import-thread");
	assert.equal(state.created[0]!.snooze_wake_thread_id, null);
	assert.equal(state.created[0]!.follow_up_reply_mailbox_address, null);
});

test("conflicting RFC References and direct parent fail closed", async () => {
	const state = dependencies();
	for (const [id, raw] of [["root", "raw-root"], ["direct", "raw-direct"]]) {
		await storeParsedEmail(state.value, parsed({ messageId: `<${raw}>` }), {
			folder: "inbox",
			date: "2026-07-11T09:00:00.000Z",
			messageId: id,
		});
	}
	await storeParsedEmail(state.value, parsed({
		references: "<raw-root> <raw-direct>",
		inReplyTo: "<raw-direct>",
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "reply",
		wakeSnoozedOnReply: true,
	});
	assert.equal(state.created[2]!.thread_id, "reply");
	assert.equal(state.created[2]!.snooze_wake_thread_id, null);
});

test("a direct parent survives a References chain longer than the lookup bound", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed({ messageId: "<raw-parent>" }), {
		folder: "inbox",
		date: "2026-07-11T09:00:00.000Z",
		messageId: "parent",
	});
	await storeParsedEmail(state.value, parsed({
		references: Array.from({ length: 60 }, (_, index) => `<unknown-${index}>`).join(" "),
		inReplyTo: "<raw-parent>",
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "reply",
		wakeSnoozedOnReply: true,
	});
	assert.equal(state.created[1]!.thread_id, "parent");
	assert.equal(state.created[1]!.snooze_wake_thread_id, "parent");
});

test("multiple distinct app thread tokens fail closed to a new conversation", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed({
		references: "<thread-one@example.com> <thread-two@example.com>",
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "ambiguous",
		wakeSnoozedOnReply: true,
	});
	assert.equal(state.created[0]!.thread_id, "ambiguous");
	assert.equal(state.created[0]!.snooze_wake_thread_id, null);
});

test("ingest preserves legitimate inline CID and erases ordinary CID", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed({
		attachments: [
			{
				filename: "diagram.png",
				mimeType: "image/png",
				content: new Uint8Array([1]).buffer,
				disposition: "inline",
				contentId: "diagram@example.com",
			},
			{
				filename: "proposal.pdf",
				mimeType: "application/pdf",
				content: new Uint8Array([2]).buffer,
				disposition: "attachment",
				contentId: "legacy-ordinary@example.com",
			},
		],
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "mail-with-attachments",
	});

	assert.equal(state.storedAttachments[0]?.[0]?.content_id, "diagram@example.com");
	assert.equal(state.storedAttachments[0]?.[1]?.content_id, null);
});

test("ingest records UTF-8 byte size for string attachment content", async () => {
	const state = dependencies();
	const content = "عقد موقّع";
	await storeParsedEmail(state.value, parsed({
		attachments: [{
			filename: "contract.txt",
			mimeType: "text/plain",
			content,
			disposition: "attachment",
		}],
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "unicode-attachment",
	});
	assert.equal(
		state.storedAttachments[0]?.[0]?.size,
		new TextEncoder().encode(content).byteLength,
	);
});

test("ingest bounds multi-byte attachment storage beneath the exact R2 key limit", async () => {
	const state = dependencies();
	await storeParsedEmail(state.value, parsed({
		attachments: [{
			filename: `${"📄".repeat(400)}.pdf`,
			mimeType: "application/pdf",
			content: new Uint8Array([1]).buffer,
			disposition: "attachment",
		}],
	}), {
		folder: "inbox",
		date: "2026-07-11T10:00:00.000Z",
		messageId: "unicode-storage",
			recipientMemoryOrigin: "admin_import",
	});
	const stored = state.storedAttachments[0]?.[0];
	assert.equal(typeof stored?.filename, "string");
	assert.ok([...(stored?.filename as string)].length <= 255);
	assert.match(stored?.filename as string, /\.pdf$/);
	assert.ok(new TextEncoder().encode(state.storedKeys[0] ?? "").byteLength <= 1_024);
});
