import type { EnqueueOutboundCommand } from "./outbound-delivery-contract.ts";
import type { AttachmentRef } from "./attachments.ts";
import { stableJson } from "./stable-json.ts";

type FingerprintCommand = Omit<EnqueueOutboundCommand, "commandFingerprint">;
type OutboundFingerprintContext = {
	callerThreadId?: string;
	sourceEmailId?: string;
};

function normalizeAddress(value: string): string {
	return value.trim().toLowerCase();
}

function canonicalSchedule(value: string | undefined): string | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error("Outbound schedule is invalid");
	}
	return new Date(timestamp).toISOString();
}

export async function outboundCommandFingerprint(
	command: FingerprintCommand,
	stableAttachmentReferences: readonly string[],
	context: OutboundFingerprintContext = {},
): Promise<string> {
	const snapshot = command.snapshot;
	const canonical = stableJson({
		actor: {
			id: command.actor.id ?? null,
			kind: command.actor.kind,
		},
		attachments: [...stableAttachmentReferences],
		bcc: snapshot.bcc.map(normalizeAddress),
		cc: snapshot.cc.map(normalizeAddress),
		draft: snapshot.draftId
			? { id: snapshot.draftId, version: snapshot.draftVersion }
			: null,
		from: normalizeAddress(snapshot.from),
		html: snapshot.html ?? null,
		inReplyTo: snapshot.inReplyTo ?? null,
		kind: snapshot.kind,
		callerThreadId: context.callerThreadId ?? null,
		mailboxId: normalizeAddress(snapshot.mailboxId),
		references: snapshot.references ?? [],
		scheduledFor: canonicalSchedule(command.scheduledFor),
		source: command.source,
		sourceEmailId: context.sourceEmailId ?? null,
		subject: snapshot.subject,
		text: snapshot.text ?? null,
		threadId: snapshot.kind === "reply" ? snapshot.threadId : null,
		to: snapshot.to.map(normalizeAddress),
	});
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function stableOutboundAttachmentReferences(
	refs: readonly AttachmentRef[] | undefined,
): string[] {
	return (refs ?? []).map((ref) =>
		ref.kind === "upload"
			? stableJson({
					contentId: ref.contentId ?? null,
					disposition: ref.disposition ?? "attachment",
					kind: ref.kind,
					uploadId: ref.uploadId,
				})
			: stableJson({
					attachmentId: ref.attachmentId,
					disposition: ref.disposition ?? "attachment",
					emailId: ref.emailId,
					kind: ref.kind,
				}),
	);
}

export async function withOutboundCommandFingerprint(
	command: FingerprintCommand,
	stableAttachmentReferences: readonly string[],
	context: OutboundFingerprintContext = {},
): Promise<EnqueueOutboundCommand> {
	return {
		...command,
		commandFingerprint: await outboundCommandFingerprint(
			command,
			stableAttachmentReferences,
			context,
		),
	};
}
