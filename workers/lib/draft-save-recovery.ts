import type { Env } from "../types.ts";
import type { ActivityActor } from "./activity.ts";
import {
	cleanupStoredAttachmentObjects,
	completeAttachmentPromotion,
	rollbackAttachmentPromotion,
	type AttachmentPromotion,
} from "./attachments.ts";

type DraftAttachment = { id: string; filename: string };
type AuthoritativeDraft = {
	id: string;
	folder_id: string;
	draft_version: number;
	attachments: DraftAttachment[];
};
type RecoveryStub = {
	getAttachment(id: string): Promise<{
		filename: string;
		mimetype: string;
		size: number;
		email_id: string;
	} | null>;
	getEmail(id: string): Promise<AuthoritativeDraft | null>;
	queueAttachmentCleanup?: (
		emailId: string,
		keys: string[],
		actor?: ActivityActor,
	) => Promise<void>;
};

export async function reconcileAmbiguousDraftSave(input: {
	bucket: Env["BUCKET"];
	stub: RecoveryStub;
	draftId: string;
	expectedCommittedVersion: number;
	promotion: AttachmentPromotion;
	replacedAttachments: DraftAttachment[];
	actor: ActivityActor;
}): Promise<
	| { status: "committed"; draft: AuthoritativeDraft }
	| { status: "not_committed" }
	| { status: "indeterminate" }
> {
	let draft: AuthoritativeDraft | null;
	try {
		draft = await input.stub.getEmail(input.draftId);
	} catch {
		return { status: "indeterminate" };
	}
	const expectedAttachmentIds = input.promotion.storedMetadata
		.map((attachment) => attachment.id)
		.sort();
	const actualAttachmentIds = draft?.attachments
		.map((attachment) => attachment.id)
		.sort() ?? [];
	const committed = Boolean(
		draft &&
			draft.folder_id === "draft" &&
			draft.draft_version === input.expectedCommittedVersion &&
			expectedAttachmentIds.length === actualAttachmentIds.length &&
			expectedAttachmentIds.every((id, index) => id === actualAttachmentIds[index]),
	);
	if (!committed || !draft) {
		if (
			draft &&
			expectedAttachmentIds.some((id) => actualAttachmentIds.includes(id))
		) {
			return { status: "indeterminate" };
		}
		await rollbackAttachmentPromotion(
			input.bucket,
			input.stub,
			input.draftId,
			input.promotion,
			input.actor,
		);
		return { status: "not_committed" };
	}
	await completeAttachmentPromotion(
		input.bucket,
		input.stub,
		input.draftId,
		input.promotion,
		input.actor,
	);
	await cleanupStoredAttachmentObjects(
		input.bucket,
		input.stub,
		input.draftId,
		input.replacedAttachments,
		input.actor,
	);
	return { status: "committed", draft };
}
