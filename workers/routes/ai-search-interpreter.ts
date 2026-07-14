import { Hono } from "hono";
import {
	AI_SEARCH_INTERPRETER_LIMITS,
	parseAiSearchInterpreterRequest,
	type AiSearchInterpreterRequest,
	type AiSearchInterpreterResponse,
} from "../../shared/ai-search-interpreter.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	AiSearchInterpreterAccessRevokedError,
	createAiSearchInterpreterRuntime,
	runAiSearchInterpreter,
} from "../lib/ai-search-interpreter-runtime.ts";
import type { Env } from "../types.ts";

export type AiSearchInterpreterRouteContext = {
	Bindings: Env;
	Variables: {
		authorizedMailboxId: string;
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

export type AiSearchInterpreterRouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	request: AiSearchInterpreterRequest;
	stub: DurableObjectStub<MailboxDO>;
};

export interface AiSearchInterpreterRouteDependencies {
	run(input: AiSearchInterpreterRouteInput): Promise<AiSearchInterpreterResponse>;
}

const productionDependencies: AiSearchInterpreterRouteDependencies = {
	run: (input) =>
		runAiSearchInterpreter(
			createAiSearchInterpreterRuntime(input.env, {
				stub: input.stub,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
			}),
			{
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				request: input.request,
			},
		),
};

class AiSearchInterpreterBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(
			tooLarge
				? "Search interpretation request is too large"
				: "Search interpretation request is invalid",
		);
		this.name = "AiSearchInterpreterBodyError";
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (
			Number.isFinite(parsed) &&
			parsed > AI_SEARCH_INTERPRETER_LIMITS.requestBytes
		) {
			throw new AiSearchInterpreterBodyError(true);
		}
	}
	if (!request.body) throw new AiSearchInterpreterBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > AI_SEARCH_INTERPRETER_LIMITS.requestBytes) {
				await reader.cancel().catch(() => undefined);
				throw new AiSearchInterpreterBodyError(true);
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
		throw new AiSearchInterpreterBodyError();
	}
}

export function createAiSearchInterpreterRoutes(
	dependencies: AiSearchInterpreterRouteDependencies = productionDependencies,
) {
	const app = new Hono<AiSearchInterpreterRouteContext>();
	const path = "/api/v1/mailboxes/:mailboxId/search/interpret";
	app.use(path, async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.post(path, async (c) => {
		let mailboxId: string;
		let request: AiSearchInterpreterRequest;
		try {
			request = parseAiSearchInterpreterRequest(
				await boundedJsonBody(c.req.raw),
			);
			mailboxId = c.var.authorizedMailboxId;
		} catch (error) {
			if (
				error instanceof AiSearchInterpreterBodyError &&
				error.tooLarge
			) {
				return c.json({ error: error.message }, 413);
			}
			return c.json(
				{ error: "Search interpretation request is invalid" },
				400,
			);
		}
		const session = c.get("session")!;
		try {
			return c.json(
				await dependencies.run({
					env: c.env,
					actorUserId: session.sub,
					mailboxId,
					request,
					stub: c.get("mailboxStub")!,
				}),
			);
		} catch (error) {
			if (error instanceof AiSearchInterpreterAccessRevokedError) {
				return c.json({ error: "Mailbox access is no longer active." }, 403);
			}
			return c.json(
				{
					error:
						"AI search interpretation is temporarily unavailable. Ordinary search remains available.",
				},
				502,
			);
		}
	});
	return app;
}

export const aiSearchInterpreterRoutes = createAiSearchInterpreterRoutes();
