import type { ActivityActor } from "./activity.ts";

export type DraftCreateFingerprintInput = {
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	body: string;
	in_reply_to?: string;
	thread_id?: string;
	attachments?: unknown[];
};

export type DraftSaveFingerprintInput = DraftCreateFingerprintInput & {
	draft_id?: string;
	draft_version?: number;
};

export type DraftToolInvocation =
	| {
			surface: "mcp";
			toolName: "create_draft" | "draft_reply";
			sessionId: string;
			requestId: string | number;
		}
	| {
			surface: "agent";
			toolName: "draft_email" | "draft_reply";
			requestId: string;
			toolCallId: string;
		};

export type DraftToolUpdateInvocation = {
	surface: "mcp";
	toolName: "update_draft";
	sessionId: string;
	requestId: string | number;
};

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function draftIdForSaveKey(
	mailboxId: string,
	saveKey: string,
): Promise<string> {
	const hash = await sha256([
		"mail-draft-save-id",
		1,
		mailboxId.toLowerCase(),
		saveKey,
	]);
	const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function draftCreateFingerprint(
	input: DraftCreateFingerprintInput,
): Promise<string> {
	return sha256([
		input.to ?? "",
		input.cc ?? "",
		input.bcc ?? "",
		input.subject ?? "",
		input.body,
		input.in_reply_to ?? null,
		input.thread_id ?? null,
		input.attachments ?? [],
	]);
}

export function draftSaveFingerprint(
	input: DraftSaveFingerprintInput,
): Promise<string> {
	return sha256([
		input.draft_id ?? null,
		input.draft_version ?? 0,
		(input.to ?? "").toLowerCase(),
		(input.cc ?? "").toLowerCase(),
		(input.bcc ?? "").toLowerCase(),
		input.subject ?? "",
		input.body,
		input.in_reply_to ?? null,
		input.thread_id ?? null,
		input.attachments ?? [],
	]);
}

export function draftToolCreateKey(input: {
	mailboxId: string;
	actor: ActivityActor;
	invocation: DraftToolInvocation;
}): Promise<string> {
	const common = [
		"mail-draft-tool-create",
		1,
		input.invocation.surface,
		input.mailboxId.toLowerCase(),
		input.actor.kind,
		input.actor.id ?? null,
		input.invocation.toolName,
	];
	return input.invocation.surface === "mcp"
		? sha256([
				...common,
				input.invocation.sessionId,
				input.invocation.requestId,
			])
		: sha256([
				...common,
				input.invocation.requestId,
				input.invocation.toolCallId,
			]);
}

export function draftToolUpdateKey(input: {
	mailboxId: string;
	actor: ActivityActor;
	invocation: DraftToolUpdateInvocation;
}): Promise<string> {
	return sha256([
		"mail-draft-tool-update",
		1,
		input.invocation.surface,
		input.mailboxId.toLowerCase(),
		input.actor.kind,
		input.actor.id ?? null,
		input.invocation.toolName,
		input.invocation.sessionId,
		input.invocation.requestId,
	]);
}

export function draftToolUpdateFingerprint(
	input: {
		draftId: string;
		draftVersion: number;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<string> {
	const field = (
		key: "to" | "subject" | "bodyHtml",
		normalize: (value: string) => string = (value) => value,
	) => Object.prototype.hasOwnProperty.call(input, key)
		? ["present", normalize(input[key] ?? "")]
		: ["omitted"];
	return sha256([
		"mail-draft-tool-update-intent",
		1,
		input.draftId,
		input.draftVersion,
		field("to", (value) => value.toLowerCase()),
		field("subject"),
		field("bodyHtml"),
	]);
}
