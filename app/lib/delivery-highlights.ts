import type { Email, OutboundDelivery } from "../types/index.ts";

/**
 * Key a bounded server-selected delivery highlight by the visible conversation
 * representative. A highlight may belong to an older message in that thread.
 */
export function indexDeliveryHighlights(
	emails: readonly Email[],
	deliveries: readonly OutboundDelivery[],
) {
	const byEmailId = new Map(deliveries.map((delivery) => [delivery.emailId, delivery]));
	const priority: Record<OutboundDelivery["status"], number> = {
		bounced: 0,
		failed: 1,
		unknown: 2,
		retrying: 3,
		sending: 4,
		queued: 5,
		sent: 6,
		cancelled: 7,
	};
	const byThreadId = new Map<string, OutboundDelivery>();
	for (const delivery of deliveries) {
		if (!delivery.threadId) continue;
		const current = byThreadId.get(delivery.threadId);
		if (
			!current ||
			priority[delivery.status] < priority[current.status] ||
			(priority[delivery.status] === priority[current.status] &&
				(delivery.updatedAt ?? "") > (current.updatedAt ?? ""))
		) {
			byThreadId.set(delivery.threadId, delivery);
		}
	}
	return new Map(
		emails.flatMap((email) => {
			const delivery =
				(email.thread_id ? byThreadId.get(email.thread_id) : undefined) ??
				byEmailId.get(email.id);
			return delivery ? [[email.id, delivery] as const] : [];
		}),
	);
}
