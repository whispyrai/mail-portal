import type { Env } from "../types.ts";
import type { OutboundMessageSnapshot } from "./outbound-delivery-contract.ts";
import { attachmentKey } from "./attachments.ts";

export type CancelledSnapshotAttachment = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
};

type RecoveryBucket = Pick<Env["BUCKET"], "get" | "put" | "delete">;

type ComparableSourceDraft = {
	folder_id: string;
	draft_version: number;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	body: string | null;
	in_reply_to: string | null;
	thread_id: string | null;
	attachments: Array<{ id: string }>;
};

function addressList(value: string | null): string[] {
	return (value ?? "")
		.split(",")
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length &&
		left.every((value, index) => value === right[index]);
}

/** True only when retaining the current source draft loses no snapshot state. */
export function sourceDraftMatchesSnapshot(
	draft: ComparableSourceDraft | null,
	snapshot: OutboundMessageSnapshot,
): boolean {
	if (
		!draft ||
		draft.folder_id !== "draft" ||
		snapshot.draftVersion === undefined ||
		draft.draft_version !== snapshot.draftVersion ||
		snapshot.sourceDraftAttachmentIds === undefined
	) {
		return false;
	}
	return (
		(draft.subject ?? "") === snapshot.subject &&
		(draft.sender ?? "").toLowerCase() === snapshot.from.toLowerCase() &&
		sameList(addressList(draft.recipient), snapshot.to.map((value) => value.toLowerCase())) &&
		sameList(addressList(draft.cc), snapshot.cc.map((value) => value.toLowerCase())) &&
		sameList(addressList(draft.bcc), snapshot.bcc.map((value) => value.toLowerCase())) &&
		(draft.body ?? "") === (snapshot.html ?? snapshot.text ?? "") &&
		(draft.in_reply_to ?? undefined) === snapshot.inReplyTo &&
		(draft.thread_id ?? "") === snapshot.threadId &&
		sameList(
			draft.attachments.map((attachment) => attachment.id).sort(),
			[...snapshot.sourceDraftAttachmentIds].sort(),
		)
	);
}

export function recoveredDraftId(snapshotEmailId: string): string {
	return `draft_recovered_${snapshotEmailId}`;
}

export function recoveredAttachmentId(snapshotAttachmentId: string): string {
	return `recovered_${snapshotAttachmentId}`;
}

/**
 * Copy immutable snapshot objects to deterministic draft-owned keys. Metadata
 * is returned only after every object exists. On a partial failure we attempt
 * rollback; if R2 cleanup also fails, the same deterministic keys make retry
 * safe and idempotent without exposing an incomplete draft row.
 */
export async function prepareRecoveredDraftAttachments(
	bucket: RecoveryBucket,
	snapshotEmailId: string,
	attachments: CancelledSnapshotAttachment[],
): Promise<{ draftId: string; attachments: CancelledSnapshotAttachment[] }> {
	const draftId = recoveredDraftId(snapshotEmailId);
	const copiedKeys: string[] = [];
	const recovered: CancelledSnapshotAttachment[] = [];
	try {
		for (const attachment of attachments) {
			const object = await bucket.get(
				attachmentKey(snapshotEmailId, attachment.id, attachment.filename),
			);
			if (!object) {
				throw new Error(`Missing cancelled attachment ${attachment.id}`);
			}
			const id = recoveredAttachmentId(attachment.id);
			const destinationKey = attachmentKey(draftId, id, attachment.filename);
			await bucket.put(destinationKey, await object.arrayBuffer());
			copiedKeys.push(destinationKey);
			recovered.push({ ...attachment, id, email_id: draftId });
		}
		return { draftId, attachments: recovered };
	} catch (error) {
		if (copiedKeys.length > 0) {
			try {
				await bucket.delete(copiedKeys);
			} catch {
				// A later retry overwrites these deterministic, still-private keys.
			}
		}
		throw error;
	}
}
