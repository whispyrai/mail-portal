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

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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
