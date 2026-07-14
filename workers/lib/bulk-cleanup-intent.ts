export type BulkCleanupIntent = {
	id: string;
	ownerId: string;
	keys: string[];
	dueAt: number;
	leaseToken: string | null;
	leaseExpiresAt: number | null;
	attempts: number;
	createdAt: number;
	verifyAt?: number;
	deleteConfirmedAt?: number;
	protectAdmissionKey?: string;
	protectGeneration?: number;
	protectDeliveryKey?: string;
	protectEmailId?: string;
	protectPreparationKey?: string;
};

function actionableAt(intent: BulkCleanupIntent): number {
	return intent.leaseToken !== null && intent.leaseExpiresAt !== null
		? intent.leaseExpiresAt
		: intent.dueAt;
}

export function planBulkCleanupClaim(
	entries: ReadonlyArray<readonly [string, BulkCleanupIntent]>,
	now: number,
	leaseToken: string,
	leaseMs: number,
): { key: string; intent: BulkCleanupIntent } | null {
	const due = entries
		.filter(([, intent]) => actionableAt(intent) <= now)
		.sort((left, right) => {
			const time = actionableAt(left[1]) - actionableAt(right[1]);
			return time !== 0 ? time : left[0].localeCompare(right[0]);
		})[0];
	if (!due) return null;
	return {
		key: due[0],
		intent: {
			...due[1],
			leaseToken,
			leaseExpiresAt: now + leaseMs,
			attempts: due[1].attempts + 1,
		},
	};
}

export function completeBulkCleanupClaim(
	intent: BulkCleanupIntent,
	leaseToken: string,
): boolean {
	return intent.leaseToken === leaseToken;
}

export function retryBulkCleanupClaim(
	intent: BulkCleanupIntent,
	leaseToken: string,
	now: number,
	retryMs: number,
): BulkCleanupIntent | null {
	if (intent.leaseToken !== leaseToken) return null;
	return {
		...intent,
		dueAt: now + retryMs,
		leaseToken: null,
		leaseExpiresAt: null,
	};
}

export function bulkCleanupNextAt(
	intents: readonly BulkCleanupIntent[],
): number | null {
	return intents.reduce<number | null>((next, intent) => {
		const candidate = actionableAt(intent);
		return next === null || candidate < next ? candidate : next;
	}, null);
}

export function bulkCleanupBacklogCount(
	intents: readonly BulkCleanupIntent[],
	now: number,
	windowMs: number,
): number {
	const cutoff = now + windowMs;
	return intents.filter((intent) => actionableAt(intent) <= cutoff).length;
}
