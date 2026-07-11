import assert from "node:assert/strict";
import test from "node:test";
import type { EnqueueOutboundCommand } from "./outbound-delivery-contract.ts";
import { toolSendEmail, toolSendReply } from "./tools.ts";

function testEnvironment(options?: {
	original?: Record<string, unknown>;
	existingDelivery?: {
		id: string;
		emailId: string;
		status: "queued" | "sending" | "retrying" | "sent" | "bounced" | "failed" | "unknown" | "cancelled";
		undoUntil: string;
	};
}) {
	const enqueued: Array<{
		command: EnqueueOutboundCommand;
		attachments: readonly unknown[];
		emailId: string;
	}> = [];
	const stub = {
		async checkSendRateLimit() {
			return null;
		},
		async getEmail(id: string) {
			return id === "original-1" ? options?.original ?? null : null;
		},
		async getOutboundDeliveryByIdempotencyKey() {
			return options?.existingDelivery ?? null;
		},
		async enqueueOutbound(
			command: EnqueueOutboundCommand,
			attachments: readonly unknown[],
			emailId: string,
		) {
			enqueued.push({ command, attachments, emailId });
			return {
				delivery: {
					id: "delivery-1",
					emailId,
					status: "queued" as const,
					undoUntil: command.undoUntil,
				},
				replayed: false,
			};
		},
	};
	return {
		enqueued,
		env: {
			MAILBOX: {
				idFromName: () => "mailbox-id",
				get: () => stub,
			},
		} as never,
	};
}

test("MCP compose is accepted into the truthful outbox without direct delivery", async () => {
	const { env, enqueued } = testEnvironment();
	const result = await toolSendEmail(
		env,
		"TEAM@Example.com",
		{
			to: "Customer@Example.com",
			subject: "Hello",
			bodyHtml: "<p>Hello</p>",
			idempotencyKey: "mcp-compose-action-1",
		},
		{ kind: "mcp", id: "user-1" },
	);

	assert.equal(result.status, "queued");
	assert.equal(enqueued.length, 1);
	assert.equal(enqueued[0]!.command.idempotencyKey, "mcp-compose-action-1");
	assert.equal(enqueued[0]!.command.source, "mcp");
	assert.deepEqual(enqueued[0]!.command.actor, { kind: "mcp", id: "user-1" });
	assert.deepEqual(enqueued[0]!.command.snapshot, {
		mailboxId: "team@example.com",
		kind: "compose",
		to: ["customer@example.com"],
		cc: [],
		bcc: [],
		from: "team@example.com",
		subject: "Hello",
		html: "<p>Hello</p>",
		threadId: enqueued[0]!.emailId,
		attachmentIds: [],
	});
	assert.deepEqual(enqueued[0]!.attachments, []);
	assert.equal(
		Date.parse(enqueued[0]!.command.undoUntil) -
			Date.parse(enqueued[0]!.command.requestedAt),
		10_000,
	);
});

test("an MCP transport retry returns the existing truthful state without enqueueing again", async () => {
	const existingDelivery = {
		id: "delivery-existing",
		emailId: "email-existing",
		status: "sent" as const,
		undoUntil: "2026-07-11T08:00:10.000Z",
	};
	const { env, enqueued } = testEnvironment({ existingDelivery });
	const result = await toolSendEmail(
		env,
		"team@example.com",
		{
			to: "customer@example.com",
			subject: "Hello",
			bodyHtml: "<p>Hello</p>",
			idempotencyKey: "mcp-compose-action-1",
		},
		{ kind: "mcp", id: "user-1" },
	);

	assert.deepEqual(result, {
		status: "sent",
		deliveryId: "delivery-existing",
		messageId: "email-existing",
		undoUntil: "2026-07-11T08:00:10.000Z",
		replayed: true,
		message: "This send action already exists with status sent.",
	});
	assert.equal(enqueued.length, 0);
});

test("agent reply preserves threading and actor attribution in the outbox snapshot", async () => {
	const { env, enqueued } = testEnvironment({
		original: {
			id: "original-1",
			date: "2026-07-11T08:00:00.000Z",
			sender: "customer@example.com",
			recipient: "team@example.com",
			subject: "Question",
			body: "Original body",
			message_id: "customer-message@example.com",
			email_references: JSON.stringify(["root@example.com"]),
			thread_id: "thread-1",
		},
	});
	const result = await toolSendReply(
		env,
		"team@example.com",
		{
			originalEmailId: "original-1",
			to: "Customer@Example.com",
			subject: "Re: Question",
			bodyHtml: "<p>Thanks</p>",
			idempotencyKey: "agent-reply-action-1",
		},
		{ kind: "agent", id: "user-2" },
	);

	assert.equal(result.status, "queued");
	assert.equal(enqueued[0]!.command.source, "agent");
	assert.deepEqual(enqueued[0]!.command.actor, {
		kind: "agent",
		id: "user-2",
	});
	assert.equal(enqueued[0]!.command.snapshot.kind, "reply");
	assert.equal(
		enqueued[0]!.command.snapshot.inReplyTo,
		"customer-message@example.com",
	);
	assert.deepEqual(enqueued[0]!.command.snapshot.references, [
		"root@example.com",
		"customer-message@example.com",
	]);
	assert.equal(enqueued[0]!.command.snapshot.threadId, "thread-1");
	assert.match(enqueued[0]!.command.snapshot.html ?? "", /<blockquote/);
});
