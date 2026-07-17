import { Hono } from "hono";
import {
	INBOX_TRIAGE_SUGGESTION_LIMITS,
	parseInboxTriageSuggestionRequest,
	type NormalizedInboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	InboxTriageSuggestionAccessRevokedError,
	createInboxTriageSuggestionRuntime,
	runInboxTriageSuggestions,
	type InboxTriageSuggestionRuntimeResponse,
} from "../lib/inbox-triage-suggestions-runtime.ts";
import type { Env } from "../types.ts";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
} from "../lib/live-authorized-read.ts";
import {
	hasExactLiveMailboxAccess,
	runLiveMailboxAuthorizedRead,
	type LiveMailboxAccessAuthorizer,
} from "../lib/live-mailbox-authorization.ts";

export type InboxTriageSuggestionRouteContext = {
	Bindings: Env;
	Variables: {
		authorizedMailboxId: string;
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

export type InboxTriageSuggestionRouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	request: NormalizedInboxTriageSuggestionRequest;
	stub: DurableObjectStub<MailboxDO>;
};

export interface InboxTriageSuggestionRouteDependencies {
	run(
		input: InboxTriageSuggestionRouteInput,
	): Promise<InboxTriageSuggestionRuntimeResponse>;
}

const productionDependencies: InboxTriageSuggestionRouteDependencies = {
	run: (input) =>
		runInboxTriageSuggestions(
			createInboxTriageSuggestionRuntime(input.env, {
				stub: input.stub,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
			}),
			{
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				request: {
					page: input.request.page,
					...(input.request.labelId
						? { labelId: input.request.labelId }
						: {}),
					visibleEmailIds: input.request.visibleEmailIds,
				},
			},
		),
};

class InboxTriageSuggestionBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(
			tooLarge
				? "Inbox triage suggestion request is too large"
				: "Inbox triage suggestion request is invalid",
		);
		this.name = "InboxTriageSuggestionBodyError";
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (
			Number.isFinite(parsed) &&
			parsed > INBOX_TRIAGE_SUGGESTION_LIMITS.requestBytes
		) {
			throw new InboxTriageSuggestionBodyError(true);
		}
	}
	if (!request.body) throw new InboxTriageSuggestionBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > INBOX_TRIAGE_SUGGESTION_LIMITS.requestBytes) {
				await reader.cancel().catch(() => undefined);
				throw new InboxTriageSuggestionBodyError(true);
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
		throw new InboxTriageSuggestionBodyError();
	}
}

export function createInboxTriageSuggestionRoutes(
	dependencies: InboxTriageSuggestionRouteDependencies = productionDependencies,
	authorize: LiveMailboxAccessAuthorizer = hasExactLiveMailboxAccess,
) {
	const app = new Hono<InboxTriageSuggestionRouteContext>();
	const path = "/api/v1/mailboxes/:mailboxId/inbox-triage-suggestions";
	app.use(path, async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.post(path, async (c) => {
		let mailboxId: string;
		let request: NormalizedInboxTriageSuggestionRequest;
		try {
			request = parseInboxTriageSuggestionRequest(
				await boundedJsonBody(c.req.raw),
			);
			mailboxId = c.var.authorizedMailboxId;
		} catch (error) {
			if (
				error instanceof InboxTriageSuggestionBodyError &&
				error.tooLarge
			) {
				return c.json({ error: error.message }, 413);
			}
			return c.json(
				{ error: "Inbox triage suggestion request is invalid" },
				400,
			);
		}
		const session = c.get("session")!;
		try {
			return c.json(
				await runLiveMailboxAuthorizedRead(
					c.env,
					{
						mailboxId,
						userId: session.sub,
						sessionVersion: session.sessionVersion,
					},
					() => dependencies.run({
						env: c.env,
						actorUserId: session.sub,
						mailboxId,
						request,
						stub: c.get("mailboxStub")!,
					}),
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
			if (error instanceof InboxTriageSuggestionAccessRevokedError) {
				return c.json({ error: "Mailbox access is no longer active." }, 403);
			}
			console.error("[inbox-triage-suggestions] generation failed", {
				actorUserId: session.sub,
				mailboxId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return c.json(
				{
					error:
						"Inbox triage suggestions are temporarily unavailable. No mail was changed.",
				},
				502,
			);
		}
	});
	return app;
}

export const inboxTriageSuggestionRoutes =
	createInboxTriageSuggestionRoutes();
