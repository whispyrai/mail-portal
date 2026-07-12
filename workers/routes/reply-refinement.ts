import { Hono } from "hono";
import {
	REPLY_REFINEMENT_LIMITS,
	normalizeReplyRefinementSourceEmailId,
	parseReplyRefinementRequest,
	type NormalizedReplyRefinementRequest,
} from "../../shared/reply-refinement.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "../lib/conversation-intelligence-runtime.ts";
import {
	ReplyRefinementAccessRevokedError,
	ReplyRefinementSourceUnavailableError,
	ReplyRefinementWritingPromptUnavailableError,
	createReplyRefinementRuntime,
	runReplyRefinement,
	type ReplyRefinementRuntimeResponse,
} from "../lib/reply-refinement-runtime.ts";
import type { Env } from "../types.ts";

export type ReplyRefinementRouteContext = {
	Bindings: Env;
	Variables: {
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

export type ReplyRefinementRouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	sourceEmailId: string;
	request: NormalizedReplyRefinementRequest;
	stub: DurableObjectStub<MailboxDO>;
};

export interface ReplyRefinementRouteDependencies {
	run(
		input: ReplyRefinementRouteInput,
	): Promise<ReplyRefinementRuntimeResponse>;
}

const productionDependencies: ReplyRefinementRouteDependencies = {
	run: (input) =>
		runReplyRefinement(
			createReplyRefinementRuntime(input.env, {
				stub: input.stub,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
			}),
			{
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				sourceEmailId: input.sourceEmailId,
				request: {
					mode: input.request.mode,
					prompt: input.request.prompt,
					currentBody: input.request.currentBody,
					preserveSignature: input.request.preserveSignature,
				},
			},
		),
};

class ReplyRefinementBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(
			tooLarge
				? "Reply refinement request is too large"
				: "Reply refinement request is invalid",
		);
		this.name = "ReplyRefinementBodyError";
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (
			Number.isFinite(parsed) &&
			parsed > REPLY_REFINEMENT_LIMITS.requestBytes
		) {
			throw new ReplyRefinementBodyError(true);
		}
	}
	if (!request.body) throw new ReplyRefinementBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > REPLY_REFINEMENT_LIMITS.requestBytes) {
				await reader.cancel().catch(() => undefined);
				throw new ReplyRefinementBodyError(true);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ReplyRefinementBodyError();
	}
}

function normalizedMailboxId(raw: string): string {
	try {
		const mailboxId = decodeURIComponent(raw).trim().toLowerCase();
		if (!mailboxId || mailboxId.length > 320) throw new Error();
		return mailboxId;
	} catch {
		throw new ReplyRefinementBodyError();
	}
}

export function createReplyRefinementRoutes(
	dependencies: ReplyRefinementRouteDependencies = productionDependencies,
) {
	const app = new Hono<ReplyRefinementRouteContext>();
	const path =
		"/api/v1/mailboxes/:mailboxId/emails/:emailId/reply-refinement";
	app.use(path, async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.post(path, async (c) => {
		let mailboxId: string;
		let sourceEmailId: string;
		let request: NormalizedReplyRefinementRequest;
		try {
			const body = await boundedJsonBody(c.req.raw);
			request = parseReplyRefinementRequest(body);
			mailboxId = normalizedMailboxId(c.req.param("mailboxId")!);
			sourceEmailId = normalizeReplyRefinementSourceEmailId(
				c.req.param("emailId") ?? "",
			);
		} catch (error) {
			if (error instanceof ReplyRefinementBodyError && error.tooLarge) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "Reply refinement request is invalid" }, 400);
		}

		const session = c.get("session")!;
		try {
			return c.json(
				await dependencies.run({
					env: c.env,
					actorUserId: session.sub,
					mailboxId,
					sourceEmailId,
					request,
					stub: c.get("mailboxStub")!,
				}),
			);
		} catch (error) {
			if (error instanceof ReplyRefinementAccessRevokedError) {
				return c.json({ error: "Mailbox access is no longer active." }, 403);
			}
			if (error instanceof ConversationIntelligenceNotFoundError) {
				return c.json({ error: "Conversation was not found" }, 404);
			}
			if (
				error instanceof ConversationIntelligenceUnsupportedStateError ||
				error instanceof ReplyRefinementSourceUnavailableError ||
				error instanceof ReplyRefinementWritingPromptUnavailableError
			) {
				return c.json(
					{
						error:
							"Reply refinement is unavailable for this Message state.",
						code: "unsupported_message_state",
					},
					409,
				);
			}
			console.error("[reply-refinement] generation failed", {
				actorUserId: session.sub,
				mailboxId,
				sourceEmailId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return c.json(
				{
					error:
						"Reply refinement is temporarily unavailable. Your draft remains unchanged.",
				},
				502,
			);
		}
	});
	return app;
}

export const replyRefinementRoutes = createReplyRefinementRoutes();
