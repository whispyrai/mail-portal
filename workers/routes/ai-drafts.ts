import { Hono } from "hono";
import { z } from "zod";
import {
	draftNewEmail,
	draftReplyForEmail,
	type ComposeDraftRequest,
} from "../lib/agent-context.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import type { Env } from "../types.ts";
import {
	AI_DRAFTING_LIMITS,
	validateAiComposeDraftRequest,
} from "../../shared/ai-drafting.ts";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
} from "../lib/live-authorized-read.ts";
import {
	hasExactLiveMailboxAccess,
	runLiveMailboxAuthorizedRead,
	type LiveMailboxAccessAuthorizer,
} from "../lib/live-mailbox-authorization.ts";

export const AI_DRAFT_REQUEST_LIMITS = {
	replyBytes: AI_DRAFTING_LIMITS.replyRequestBytes,
	composeBytes: AI_DRAFTING_LIMITS.composeRequestBytes,
} as const;

const ReplyDraftRequestSchema = z.object({
	emailId: z.string().trim().min(1).max(300),
}).strict();

const ComposeDraftRequestSchema = z.object({
	prompt: z.string().trim().min(1).max(AI_DRAFTING_LIMITS.promptChars),
	currentSubject: z.string().max(AI_DRAFTING_LIMITS.currentSubjectChars).optional(),
	currentBody: z.string().max(AI_DRAFTING_LIMITS.currentBodyChars).optional(),
	preserveSignature: z.boolean().optional(),
}).strict();

const SAFE_AI_UNAVAILABLE_MESSAGES = new Set([
	"AI drafting is paused pending an administrator budget review.",
	"AI drafting is temporarily unavailable. Your mail remains fully available.",
]);

const GENERIC_AI_FAILURE =
	"AI drafting is temporarily unavailable. Please try again.";

class AiDraftRequestTooLargeError extends Error {
	constructor() {
		super("AI draft request is too large");
		this.name = "AiDraftRequestTooLargeError";
	}
}

class InvalidAiDraftRequestError extends Error {
	constructor() {
		super("AI draft request is invalid");
		this.name = "InvalidAiDraftRequestError";
	}
}

async function boundedJsonBody(request: Request, maxBytes: number): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw new AiDraftRequestTooLargeError();
		}
	}

	if (!request.body) throw new InvalidAiDraftRequestError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new AiDraftRequestTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		throw new InvalidAiDraftRequestError();
	}
}

export interface AiDraftRouteOperations {
	draftReply(
		env: Env,
		mailboxId: string,
		emailId: string,
		actorUserId: string,
	): Promise<{ to: string; subject: string; body: string }>;
	draftCompose(
		env: Env,
		mailboxId: string,
		request: ComposeDraftRequest,
		actorUserId: string,
	): Promise<{ subject?: string; body: string }>;
}

export type AiDraftRouteContext = MailboxContext;

const productionOperations: AiDraftRouteOperations = {
	draftReply: draftReplyForEmail,
	draftCompose: draftNewEmail,
};

function safeInferenceError(
	error: unknown,
	context: { kind: "reply" | "compose"; mailboxId: string; actorUserId: string },
) {
	const message = error instanceof Error ? error.message : "";
	if (SAFE_AI_UNAVAILABLE_MESSAGES.has(message)) return message;
	console.error("[ai-drafts] inference failed", {
		kind: context.kind,
		mailboxId: context.mailboxId,
		actorUserId: context.actorUserId,
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
	return GENERIC_AI_FAILURE;
}

function invalidReplyMessage(value: unknown): string {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(typeof (value as { emailId?: unknown }).emailId !== "string" ||
			!(value as { emailId: string }).emailId.trim())
	) {
		return "emailId is required";
	}
	return "AI draft request is invalid";
}

function invalidComposeMessage(value: unknown): string {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(typeof (value as { prompt?: unknown }).prompt !== "string" ||
			!(value as { prompt: string }).prompt.trim())
	) {
		return "prompt is required";
	}
	return "AI compose request is invalid";
}

export function createAiDraftRoutes(
	operations: AiDraftRouteOperations = productionOperations,
	authorize: LiveMailboxAccessAuthorizer = hasExactLiveMailboxAccess,
) {
	const app = new Hono<AiDraftRouteContext>();

	for (const path of [
		"/api/v1/mailboxes/:mailboxId/ai-draft",
		"/api/v1/mailboxes/:mailboxId/ai-compose",
	]) {
		app.use(path, async (c, next) => {
			c.header("Cache-Control", "private, no-store");
			if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
			await next();
		});
	}

	app.post("/api/v1/mailboxes/:mailboxId/ai-draft", async (c) => {
		let input: z.infer<typeof ReplyDraftRequestSchema>;
		try {
			const body = await boundedJsonBody(
				c.req.raw,
				AI_DRAFT_REQUEST_LIMITS.replyBytes,
			);
			const parsed = ReplyDraftRequestSchema.safeParse(body);
			if (!parsed.success) {
				return c.json({ error: invalidReplyMessage(body) }, 400);
			}
			input = parsed.data;
		} catch (error) {
			if (error instanceof AiDraftRequestTooLargeError) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "AI draft request is invalid" }, 400);
		}

		const session = c.get("session")!;
			const mailboxId = c.var.authorizedMailboxId;
		try {
			return c.json(
				await runLiveMailboxAuthorizedRead(
					c.env,
					{
						mailboxId,
						userId: session.sub,
						sessionVersion: session.sessionVersion,
					},
					() => operations.draftReply(
						c.env,
						mailboxId,
						input.emailId,
						session.sub,
					),
					authorize,
				),
			);
		} catch (error) {
			if (error instanceof LiveReadAuthorizationError) {
				return c.json({ error: "Forbidden" }, 403);
			}
			if (error instanceof LiveReadAuthorizationUnavailableError) {
				return c.json({ error: "Authorization unavailable" }, 503);
			}
			return c.json(
				{
					error: safeInferenceError(error, {
						kind: "reply",
						mailboxId,
						actorUserId: session.sub,
					}),
				},
				502,
			);
		}
	});

	app.post("/api/v1/mailboxes/:mailboxId/ai-compose", async (c) => {
		let input: z.infer<typeof ComposeDraftRequestSchema>;
		try {
			const body = await boundedJsonBody(
				c.req.raw,
				AI_DRAFT_REQUEST_LIMITS.composeBytes,
			);
			const parsed = ComposeDraftRequestSchema.safeParse(body);
			if (!parsed.success) {
				return c.json({ error: invalidComposeMessage(body) }, 400);
			}
			const validation = validateAiComposeDraftRequest(parsed.data);
			if (!validation.ok) {
				return c.json(
					{
						error:
							validation.code === "draft_context_too_large"
								? "The current draft is too large to refine safely"
								: "AI compose request is invalid",
					},
					400,
				);
			}
			input = parsed.data;
		} catch (error) {
			if (error instanceof AiDraftRequestTooLargeError) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "AI compose request is invalid" }, 400);
		}

		const session = c.get("session")!;
			const mailboxId = c.var.authorizedMailboxId;
		try {
			return c.json(
				await runLiveMailboxAuthorizedRead(
					c.env,
					{
						mailboxId,
						userId: session.sub,
						sessionVersion: session.sessionVersion,
					},
					() => operations.draftCompose(
						c.env,
						mailboxId,
						input,
						session.sub,
					),
					authorize,
				),
			);
		} catch (error) {
			if (error instanceof LiveReadAuthorizationError) {
				return c.json({ error: "Forbidden" }, 403);
			}
			if (error instanceof LiveReadAuthorizationUnavailableError) {
				return c.json({ error: "Authorization unavailable" }, 503);
			}
			return c.json(
				{
					error: safeInferenceError(error, {
						kind: "compose",
						mailboxId,
						actorUserId: session.sub,
					}),
				},
				502,
			);
		}
	});

	return app;
}

export const aiDraftRoutes = createAiDraftRoutes();
