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
	getDraftSaveOutcome(
		saveKey: string,
		fingerprint: string,
	): Promise<{
		status: "missing" | "key_conflict" | "claimed" | "committed" | "aborted";
		draftId?: string;
		committedVersion?: number | null;
		claimToken?: string | null;
		draft?: AuthoritativeDraft | null;
	}>;
	abortDraftSave(
		saveKey: string,
		fingerprint: string,
		claimToken: string,
	): Promise<{ status: "aborted" | "not_claimed"; destinationKeys: string[] }>;
	queueAttachmentCleanup?: (
		emailId: string,
		keys: string[],
		actor?: ActivityActor,
		promotionOwner?: string,
	) => Promise<void>;
};

export async function reconcileAmbiguousDraftSave(input: {
	bucket: Env["BUCKET"];
	stub: RecoveryStub;
	draftId: string;
	expectedCommittedVersion: number;
	saveKey: string;
	saveFingerprint: string;
	promotion: AttachmentPromotion;
	replacedAttachments: DraftAttachment[];
	actor: ActivityActor;
}): Promise<
	| { status: "committed"; draft: AuthoritativeDraft; attachmentIdentityScope: string }
	| { status: "not_committed" }
	| { status: "indeterminate" }
> {
	let outcome: Awaited<ReturnType<RecoveryStub["getDraftSaveOutcome"]>>;
	try {
		outcome = await input.stub.getDraftSaveOutcome(
			input.saveKey,
			input.saveFingerprint,
		);
	} catch {
		return { status: "indeterminate" };
	}
	if (outcome.status !== "committed") {
		if (outcome.status === "key_conflict") {
			return { status: "indeterminate" };
		}
		if (outcome.status === "claimed") {
			if (!input.promotion.promotionOwner) {
				return { status: "indeterminate" };
			}
			let aborted;
			try {
				aborted = await input.stub.abortDraftSave(
					input.saveKey,
					input.saveFingerprint,
					input.promotion.promotionOwner,
				);
			} catch {
				return { status: "indeterminate" };
			}
			if (aborted.status !== "aborted") return { status: "indeterminate" };
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
	let draft = outcome.draft ?? null;
	if (!draft) {
		try {
			draft = await input.stub.getEmail(input.draftId);
		} catch {
			return { status: "indeterminate" };
		}
	}
	if (
		!draft ||
		draft.folder_id !== "draft" ||
		draft.draft_version !== input.expectedCommittedVersion ||
		outcome.draftId !== input.draftId ||
		outcome.committedVersion !== input.expectedCommittedVersion
	) {
		return { status: "indeterminate" };
	}
	await Promise.allSettled([
		completeAttachmentPromotion(
			input.bucket,
			input.stub,
			input.draftId,
			input.promotion,
			input.actor,
		),
		cleanupStoredAttachmentObjects(
			input.bucket,
			input.stub,
			input.draftId,
			input.replacedAttachments,
			input.actor,
		),
	]);
	return {
		status: "committed",
		draft,
		attachmentIdentityScope: outcome.claimToken ?? input.saveKey,
	};
}
