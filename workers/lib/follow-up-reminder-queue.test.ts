import assert from "node:assert/strict";
import test from "node:test";
import {
	processOneFollowUpReplyCompletion,
	type FollowUpReplyQueueItem,
	type FollowUpReplyQueueRepository,
} from "./follow-up-reminder-queue.ts";

function fixture() {
	const rows = new Map<string, FollowUpReplyQueueItem & { nextAttemptAt: number }>();
	const repository: FollowUpReplyQueueRepository = {
		async nextDue(now) {
			return [...rows.values()]
				.filter((row) => row.nextAttemptAt <= now)
				.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0] ?? null;
		},
		async remove(id) {
			rows.delete(id);
		},
		async retry(input) {
			const row = rows.get(input.inboundMessageId)!;
			rows.set(input.inboundMessageId, {
				...row,
				attempts: input.attempts,
				nextAttemptAt: input.nextAttemptAt,
			});
		},
		async nextAttemptAt() {
			return [...rows.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)[0]?.nextAttemptAt ?? null;
		},
	};
	return { rows, repository };
}

const item: FollowUpReplyQueueItem & { nextAttemptAt: number } = {
	inboundMessageId: "message-1",
	mailboxAddress: "shared@example.com",
	conversationKey: "thread-1",
	inboundMessageDate: "2026-07-11T12:00:00.000Z",
	attempts: 0,
	nextAttemptAt: 100,
};

test("durable reply completion retries a transient failure then removes the signal", async () => {
	const { rows, repository } = fixture();
	rows.set(item.inboundMessageId, item);
	let calls = 0;
	const complete = async () => {
		calls += 1;
		if (calls === 1) throw new Error("temporary D1 outage");
	};
	const retryAt = await processOneFollowUpReplyCompletion({ repository, complete, now: 100 });
	assert.equal(rows.get(item.inboundMessageId)?.attempts, 1);
	assert.equal(retryAt, 2100);
	assert.equal(await processOneFollowUpReplyCompletion({ repository, complete, now: 2100 }), null);
	assert.equal(calls, 2);
	assert.equal(rows.size, 0);
});

test("a duplicate persisted signal remains one idempotent queue item", async () => {
	const { rows, repository } = fixture();
	rows.set(item.inboundMessageId, item);
	rows.set(item.inboundMessageId, { ...item, conversationKey: "ignored-duplicate" });
	let calls = 0;
	await processOneFollowUpReplyCompletion({
		repository,
		complete: async () => { calls += 1; },
		now: 100,
	});
	assert.equal(calls, 1);
	assert.equal(rows.size, 0);
});
