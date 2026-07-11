import type { OutboundDelivery } from "~/types";

export function shouldLoadOutboundState(folder: string | undefined): boolean {
	return folder === "outbox" || folder === "sent";
}

export function visibleOutboxEmails<T extends { id: string }>(
	emails: T[],
	deliveryByEmailId: ReadonlyMap<
		string,
		Pick<OutboundDelivery, "status" | "cancelRecoveryPending"> |
			{ status: string; cancelRecoveryPending?: boolean }
	>,
): T[] {
	return emails.filter((email) => {
		const status = deliveryByEmailId.get(email.id)?.status;
		const delivery = deliveryByEmailId.get(email.id);
		return (
			status !== "sent" &&
			(status !== "cancelled" || delivery?.cancelRecoveryPending === true)
		);
	});
}

export function outboxFolderView<T extends { id: string }>(
	emails: T[],
	deliveryByEmailId: ReadonlyMap<string, { status: string; cancelRecoveryPending?: boolean }>,
	totalCount: number,
): { emails: T[]; totalCount: number } {
	return {
		emails: visibleOutboxEmails(emails, deliveryByEmailId),
		totalCount,
	};
}
