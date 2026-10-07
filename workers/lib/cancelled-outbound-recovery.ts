import type { Env } from "../types.ts";
import type { OutboundMessageSnapshot } from "./outbound-delivery-contract.ts";
import {
	attachmentKey,
	attachmentKeyPrefix,
	storedAttachmentKey,
} from "./attachments.ts";
import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";
import { sendableRecipients } from "../../shared/recipient-addresses.ts";

export type CancelledSnapshotAttachment = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
	r2_key?: string | null;
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
	attachments: Array<{ id: string }>;
};

function lowercase(addresses: readonly string[]): string[] {
	return addresses.map((address) => address.toLowerCase());
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length &&
		left.every((value, index) => value === right[index]);
}

/**
 * True only when retaining the current source draft loses no snapshot state.
 * Threading is not compared: the draft keeps its link to the message it
 * answers, and the snapshot's In-Reply-To, References and thread id are
 * re-derived from that same link on the next send. Recipients are compared
 * as the composer sends them, one per address across To, Cc and Bcc.
 */
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
	const recipients = sendableRecipients({
		to: draft.recipient ?? "",
		cc: draft.cc ?? "",
		bcc: draft.bcc ?? "",
	});
	return (
		(draft.subject ?? "") === snapshot.subject &&
		(draft.sender ?? "").toLowerCase() === snapshot.from.toLowerCase() &&
		sameList(lowercase(recipients.to), lowercase(snapshot.to)) &&
		sameList(lowercase(recipients.cc), lowercase(snapshot.cc)) &&
		sameList(lowercase(recipients.bcc), lowercase(snapshot.bcc)) &&
		(draft.body ?? "") === (snapshot.html ?? snapshot.text ?? "") &&
		sameList(
			draft.attachments.map((attachment) => attachment.id).sort(),
			[...snapshot.sourceDraftAttachmentIds].sort(),
		)
	);
}

export function recoveredDraftId(snapshotEmailId: string): string {
	return `draft_recovered_${snapshotEmailId}`;
}

export function recoveredAttachmentId(
	snapshotAttachmentId: string,
	recoveryGeneration = 0,
): string {
	return recoveryGeneration > 0
		? `recovered_${snapshotAttachmentId}_g${recoveryGeneration}`
		: `recovered_${snapshotAttachmentId}`;
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
	options: {
		recordDestinationIntent?: (
			draftId: string,
			keys: string[],
		) => Promise<void>;
		recoveryGeneration?: number;
	} = {},
): Promise<{ draftId: string; attachments: CancelledSnapshotAttachment[] }> {
	const draftId = recoveredDraftId(snapshotEmailId);
	const planned = attachments.map((attachment) => {
		const id = recoveredAttachmentId(
			attachment.id,
			options.recoveryGeneration,
		);
		const filename = safeAttachmentStorageFilename(
			attachment.filename,
			attachmentKeyPrefix(draftId, id),
		);
		return {
			attachment,
			id,
			filename,
			destinationKey: attachmentKey(draftId, id, filename),
		};
	});
	if (planned.length > 0) {
		await options.recordDestinationIntent?.(
			draftId,
			planned.map(({ destinationKey }) => destinationKey),
		);
	}
	const copiedKeys: string[] = [];
	const recovered: CancelledSnapshotAttachment[] = [];
	try {
		for (const { attachment, id, filename, destinationKey } of planned) {
			const object = await bucket.get(storedAttachmentKey(attachment));
			if (!object) {
				throw new Error(`Missing cancelled attachment ${attachment.id}`);
			}
			await bucket.put(destinationKey, await object.arrayBuffer());
			copiedKeys.push(destinationKey);
				recovered.push({
				...attachment,
				id,
				email_id: draftId,
				filename,
				r2_key: destinationKey,
				content_id: contentIdForDisposition(
					attachment.disposition,
					attachment.content_id,
				),
			});
		}
		return { draftId, attachments: recovered };
	} catch (error) {
		if (copiedKeys.length > 0 && !options.recordDestinationIntent) {
			try {
				await bucket.delete(copiedKeys);
			} catch {
				// A later retry overwrites these deterministic, still-private keys.
			}
		}
		throw error;
	}
}
