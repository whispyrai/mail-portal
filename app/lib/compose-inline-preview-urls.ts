import {
	isCanonicalContentId,
	isInlineImageMimeType,
} from "../../shared/content-id.ts";

export interface InlinePreviewAttachment {
	localId: string;
	mimetype: string;
	status?: string;
	disposition?: string;
	contentId?: string | null;
	file?: File;
	existing?: { emailId: string; attachmentId: string };
}

interface PreviewEntry {
	contentId: string;
	url: string;
	file?: File;
	existingKey?: string;
	revocable: boolean;
}

interface ObjectUrlApi {
	createObjectURL(file: File): string;
	revokeObjectURL(url: string): void;
}

function attachmentPreviewUrl(
	mailboxId: string,
	existing: { emailId: string; attachmentId: string },
): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(existing.emailId)}/attachments/${encodeURIComponent(existing.attachmentId)}`;
}

/**
 * Owns composer-only preview URLs. The returned mapping is keyed by normalized
 * Content-ID and is deliberately kept outside attachment records, recovery
 * snapshots, draft fingerprints, and outgoing payloads.
 */
export class ComposeInlinePreviewUrls {
	readonly #objectUrls: ObjectUrlApi;
	readonly #entries = new Map<string, PreviewEntry>();

	constructor(objectUrls: ObjectUrlApi) {
		this.#objectUrls = objectUrls;
	}

	reconcile(
		attachments: ReadonlyArray<InlinePreviewAttachment>,
		mailboxId: string | undefined,
	): Record<string, string> {
		const eligible = attachments.flatMap((attachment) => {
			const contentId = attachment.contentId;
			return attachment.disposition === "inline" &&
				attachment.status !== "rejected" &&
				typeof contentId === "string" &&
				isCanonicalContentId(contentId) &&
				isInlineImageMimeType(attachment.mimetype) &&
				(Boolean(attachment.file) || Boolean(mailboxId && attachment.existing))
				? [{ attachment, contentId: contentId.toLowerCase() }]
				: [];
		});
		const eligibleIds = new Set(
			eligible.map(({ attachment }) => attachment.localId),
		);
		for (const localId of this.#entries.keys()) {
			if (!eligibleIds.has(localId)) this.release(localId);
		}

		for (const { attachment, contentId } of eligible) {
			const current = this.#entries.get(attachment.localId);
			if (attachment.file) {
				if (current?.file === attachment.file && current.contentId === contentId) {
					continue;
				}
				this.release(attachment.localId);
				this.#entries.set(attachment.localId, {
					contentId,
					url: this.#objectUrls.createObjectURL(attachment.file),
					file: attachment.file,
					revocable: true,
				});
				continue;
			}
			if (!mailboxId || !attachment.existing) continue;
			const existingKey = `${mailboxId}\n${attachment.existing.emailId}\n${attachment.existing.attachmentId}`;
			if (
				current?.existingKey === existingKey &&
				current.contentId === contentId
			) {
				continue;
			}
			this.release(attachment.localId);
			this.#entries.set(attachment.localId, {
				contentId,
				url: attachmentPreviewUrl(mailboxId, attachment.existing),
				existingKey,
				revocable: false,
			});
		}

		return Object.fromEntries(
			Array.from(this.#entries.values(), (entry) => [entry.contentId, entry.url]),
		);
	}

	release(localId: string): void {
		const current = this.#entries.get(localId);
		if (!current) return;
		if (current.revocable) this.#objectUrls.revokeObjectURL(current.url);
		this.#entries.delete(localId);
	}

	releaseAll(): void {
		for (const localId of Array.from(this.#entries.keys())) this.release(localId);
	}
}
