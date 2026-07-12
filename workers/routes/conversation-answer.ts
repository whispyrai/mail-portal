import { Hono } from "hono";
import { parseConversationAnswerRequest } from "../../shared/conversation-answer.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "../lib/conversation-intelligence-runtime.ts";
import {
	ConversationAnswerAccessRevokedError,
	createConversationAnswerRuntime,
	runConversationAnswer,
	type ConversationAnswerRuntimeResponse,
} from "../lib/conversation-answer-runtime.ts";
import type { Env } from "../types.ts";

const CONVERSATION_ANSWER_REQUEST_BYTES = 2_048;

export type ConversationAnswerRouteContext = {
	Bindings: Env;
	Variables: {
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

export type ConversationAnswerRouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	emailId: string;
	question: string;
	stub: DurableObjectStub<MailboxDO>;
};

export interface ConversationAnswerRouteDependencies {
	run(
		input: ConversationAnswerRouteInput,
	): Promise<ConversationAnswerRuntimeResponse>;
}

const productionDependencies: ConversationAnswerRouteDependencies = {
	run: (input) =>
		runConversationAnswer(
			createConversationAnswerRuntime(input.env, {
				stub: input.stub,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
			}),
			{
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				emailId: input.emailId,
				question: input.question,
			},
		),
};

class ConversationAnswerBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(
			tooLarge
				? "Conversation question is too large"
				: "Conversation question is invalid",
		);
		this.name = "ConversationAnswerBodyError";
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > CONVERSATION_ANSWER_REQUEST_BYTES) {
			throw new ConversationAnswerBodyError(true);
		}
	}
	if (!request.body) throw new ConversationAnswerBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > CONVERSATION_ANSWER_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new ConversationAnswerBodyError(true);
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
		throw new ConversationAnswerBodyError();
	}
}

function normalizedMailboxId(raw: string): string {
	try {
		const mailboxId = decodeURIComponent(raw).trim().toLowerCase();
		if (!mailboxId || mailboxId.length > 320) throw new Error();
		return mailboxId;
	} catch {
		throw new ConversationAnswerBodyError();
	}
}

export function createConversationAnswerRoutes(
	dependencies: ConversationAnswerRouteDependencies = productionDependencies,
) {
	const app = new Hono<ConversationAnswerRouteContext>();
	const path = "/api/v1/mailboxes/:mailboxId/emails/:emailId/question";
	app.use(path, async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.post(path, async (c) => {
		let mailboxId: string;
		let question: string;
		const emailId = c.req.param("emailId")?.trim() ?? "";
		try {
			const body = await boundedJsonBody(c.req.raw);
			const parsed = parseConversationAnswerRequest(body);
			if (!emailId || emailId.length > 300) {
				throw new ConversationAnswerBodyError();
			}
			mailboxId = normalizedMailboxId(c.req.param("mailboxId")!);
			question = parsed.question;
		} catch (error) {
			if (error instanceof ConversationAnswerBodyError && error.tooLarge) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "Conversation question is invalid" }, 400);
		}

		const session = c.get("session")!;
		try {
			return c.json(
				await dependencies.run({
					env: c.env,
					actorUserId: session.sub,
					mailboxId,
					emailId,
					question,
					stub: c.get("mailboxStub")!,
				}),
			);
		} catch (error) {
			if (error instanceof ConversationAnswerAccessRevokedError) {
				return c.json({ error: "Mailbox access is no longer active." }, 403);
			}
			if (error instanceof ConversationIntelligenceNotFoundError) {
				return c.json({ error: "Conversation was not found" }, 404);
			}
			if (error instanceof ConversationIntelligenceUnsupportedStateError) {
				return c.json(
					{
						error:
							"Conversation questions are unavailable for Drafts and Outbox messages.",
						code: "unsupported_message_state",
					},
					409,
				);
			}
			console.error("[conversation-answer] generation failed", {
				actorUserId: session.sub,
				mailboxId,
				emailId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return c.json(
				{
					error:
						"Conversation answer is temporarily unavailable. Mail remains fully usable.",
				},
				502,
			);
		}
	});
	return app;
}

export const conversationAnswerRoutes = createConversationAnswerRoutes();
