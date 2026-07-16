import assert from "node:assert/strict";
import test from "node:test";
import type { EnqueueOutboundCommand } from "./outbound-delivery-contract.ts";
import {
	outboundCommandFingerprint,
	outboundReplyIntentFingerprint,
} from "./outbound-command-fingerprint.ts";

function command(
	overrides: Partial<EnqueueOutboundCommand> = {},
): EnqueueOutboundCommand {
	return {
		idempotencyKey: "operation-1",
		source: "ui",
		actor: { kind: "user", id: "user-1" },
		requestedAt: "2026-07-16T01:00:00.000Z",
		undoUntil: "2026-07-16T01:00:10.000Z",
		scheduledFor: "2026-07-16T02:00:00.000Z",
		snapshot: {
			mailboxId: " Team@Example.com ",
			kind: "compose",
			to: [" Client@Example.com "],
			cc: [],
			bcc: [],
			from: " Team@Example.com ",
			subject: "Proposal",
			html: "<p>Hello</p>",
			text: "Hello",
			threadId: "generated-thread-1",
			attachmentIds: ["generated-attachment-1"],
		},
		...overrides,
	};
}

test("outbound fingerprints ignore generated execution identity and normalize addresses", async () => {
	const first = await outboundCommandFingerprint(command(), ["upload-1"]);
	const second = await outboundCommandFingerprint(
		command({
			idempotencyKey: "operation-2",
			requestedAt: "2026-07-16T01:01:00.000Z",
			undoUntil: "2026-07-16T01:01:10.000Z",
			scheduledFor: "2026-07-16T04:00:00.000+02:00",
			snapshot: {
				...command().snapshot,
				mailboxId: "team@example.com",
				from: "team@example.com",
				to: ["client@example.com"],
				threadId: "generated-thread-2",
				attachmentIds: ["generated-attachment-2"],
			},
		}),
		["upload-1"],
	);
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.equal(second, first);
});

test("outbound fingerprints bind every stable logical-intent dimension", async () => {
	const baseline = command();
	const fingerprint = await outboundCommandFingerprint(baseline, ["upload-1"]);
	const variants: Array<[string, EnqueueOutboundCommand, string[]]> = [
		["actor", command({ actor: { kind: "user", id: "user-2" } }), ["upload-1"]],
		["source", command({ source: "api" }), ["upload-1"]],
		["schedule", command({ scheduledFor: "2026-07-16T03:00:00.000Z" }), ["upload-1"]],
		["recipient", command({ snapshot: { ...baseline.snapshot, to: ["other@example.com"] } }), ["upload-1"]],
		["subject", command({ snapshot: { ...baseline.snapshot, subject: "Changed" } }), ["upload-1"]],
		["body", command({ snapshot: { ...baseline.snapshot, html: "<p>Changed</p>" } }), ["upload-1"]],
		["attachment", baseline, ["upload-2"]],
	];
	for (const [label, variant, attachments] of variants) {
		assert.notEqual(
			await outboundCommandFingerprint(variant, attachments),
			fingerprint,
			label,
		);
	}
});

test("reply fingerprints bind caller-owned threading and source Draft version", async () => {
	const snapshot = {
		...command().snapshot,
		kind: "reply" as const,
		draftId: "draft-1",
		draftVersion: 3,
		threadId: "thread-1",
		inReplyTo: "message-1@example.com",
		references: ["message-0@example.com", "message-1@example.com"],
	};
	const baseline = await outboundCommandFingerprint(
		command({ snapshot }),
		["draft-attachment-1"],
	);
	assert.notEqual(
		await outboundCommandFingerprint(
			command({ snapshot: { ...snapshot, threadId: "thread-2" } }),
			["draft-attachment-1"],
		),
		baseline,
	);
	assert.notEqual(
		await outboundCommandFingerprint(
			command({ snapshot: { ...snapshot, draftVersion: 4 } }),
			["draft-attachment-1"],
		),
		baseline,
	);
});

test("explicit compose thread identity is bound while generated identity remains excluded", async () => {
	const generatedA = command({
		snapshot: { ...command().snapshot, kind: "compose", threadId: "generated-a" },
	});
	const generatedB = command({
		snapshot: { ...generatedA.snapshot, threadId: "generated-b" },
	});

	assert.equal(
		await outboundCommandFingerprint(generatedA, []),
		await outboundCommandFingerprint(generatedB, []),
	);
	assert.notEqual(
		await outboundCommandFingerprint(generatedA, [], {
			callerThreadId: "caller-thread-a",
		}),
		await outboundCommandFingerprint(generatedB, [], {
			callerThreadId: "caller-thread-b",
		}),
	);
});

test("reply and forward source email identity is bound", async () => {
	assert.notEqual(
		await outboundCommandFingerprint(command(), [], {
			sourceEmailId: "source-email-a",
		}),
		await outboundCommandFingerprint(command(), [], {
			sourceEmailId: "source-email-b",
		}),
	);
});

test("reply intent fingerprint ignores mutable source-derived threading", async () => {
	const snapshot = {
		...command().snapshot,
		kind: "reply" as const,
		threadId: "thread-a",
		inReplyTo: "message-a@example.com",
		references: ["message-a@example.com"],
	};
	const baseline = command({ snapshot });
	const changedSourceProjection = command({
		snapshot: {
			...snapshot,
			threadId: "thread-b",
			inReplyTo: "message-b@example.com",
			references: ["message-b@example.com"],
		},
	});

	assert.equal(
		await outboundReplyIntentFingerprint(baseline, ["upload-1"], "source-1"),
		await outboundReplyIntentFingerprint(
			changedSourceProjection,
			["upload-1"],
			"source-1",
		),
	);
	assert.notEqual(
		await outboundReplyIntentFingerprint(baseline, ["upload-1"], "source-1"),
		await outboundReplyIntentFingerprint(
			command({ snapshot: { ...snapshot, subject: "Changed" } }),
			["upload-1"],
			"source-1",
		),
	);
	assert.notEqual(
		await outboundReplyIntentFingerprint(baseline, ["upload-1"], "source-1"),
		await outboundReplyIntentFingerprint(baseline, ["upload-1"], "source-2"),
	);
});
