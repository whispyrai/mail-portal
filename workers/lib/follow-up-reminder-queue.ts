export interface FollowUpReplyQueueItem {
	inboundMessageId: string;
	mailboxAddress: string;
	conversationKey: string;
	inboundMessageDate: string;
	attempts: number;
}

export interface FollowUpReplyQueueRepository {
	nextDue(now: number): Promise<FollowUpReplyQueueItem | null>;
	remove(inboundMessageId: string): Promise<void>;
	retry(input: {
		inboundMessageId: string;
		attempts: number;
		nextAttemptAt: number;
		lastError: string;
	}): Promise<void>;
	nextAttemptAt(): Promise<number | null>;
}

export function followUpReplyRetryAt(now: number, attempts: number) {
	return now + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 12)));
}

export async function processOneFollowUpReplyCompletion(input: {
	repository: FollowUpReplyQueueRepository;
	complete(item: FollowUpReplyQueueItem): Promise<unknown>;
	now: number;
}) {
	const item = await input.repository.nextDue(input.now);
	if (!item) return input.repository.nextAttemptAt();
	try {
		await input.complete(item);
		await input.repository.remove(item.inboundMessageId);
	} catch (error) {
		const attempts = item.attempts + 1;
		await input.repository.retry({
			inboundMessageId: item.inboundMessageId,
			attempts,
			nextAttemptAt: followUpReplyRetryAt(input.now, attempts),
			lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
		});
	}
	return input.repository.nextAttemptAt();
}
