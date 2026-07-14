import { Hono } from "hono";
import {
	CONVERSATION_ACTIVITY_LABELS,
	CONVERSATION_ACTIVITY_LIMITS,
	parseConversationActivityQuery,
	type ConversationActivityActor,
	type ConversationActivityCode,
	type ConversationActivityPage,
} from "../../shared/conversation-activity.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { ConversationActivityProjection } from "../lib/conversation-activity.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { mailboxAccess } from "../lib/mailbox-access.ts";
import type { Env } from "../types.ts";

export type ConversationActivityRouteContext = {
	Bindings: Env;
	Variables: {
		authorizedMailboxId: string;
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

type RouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	emailId: string;
	limit: number;
	cursor: string | null;
	stub: DurableObjectStub<MailboxDO>;
};

export type ConversationActivityRouteResult =
	| { state: "not_found" }
	| { state: "invalid_request" }
	| { state: "invalid_cursor" }
	| { state: "ready"; page: ConversationActivityPage };

export interface ConversationActivityRouteDependencies {
	run(input: RouteInput): Promise<ConversationActivityRouteResult>;
}

export class ConversationActivityAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "ConversationActivityAccessRevokedError";
	}
}

export type ConversationActivityActorUserRow = {
	id: string;
	email: string;
	is_active: number;
};

export interface ConversationActivityRuntimeDependencies {
	canAccess(actorUserId: string, mailboxId: string): Promise<boolean>;
	readProjection(input: {
		emailId: string;
		limit: number;
		cursor: string | null;
	}): Promise<ConversationActivityProjection>;
	readActorUsers(
		actorIds: string[],
	): Promise<Map<string, ConversationActivityActorUserRow>>;
}

function boundedActorEmail(value: string): string | null {
	const normalized = value.normalize("NFC").trim().toLowerCase();
	const maxChars = CONVERSATION_ACTIVITY_LIMITS.actorLabelChars - 20;
	if (
		!normalized ||
		/[\u0000-\u001F\u007F]/.test(normalized) ||
		Array.from(normalized).length > maxChars ||
		new TextEncoder().encode(normalized).byteLength >
			maxChars * 4
	) return null;
	return normalized;
}

export async function readConversationActivityActorUsers(
	env: Env,
	actorIds: string[],
): Promise<Map<string, ConversationActivityActorUserRow>> {
	const unique = [...new Set(actorIds)].slice(0, CONVERSATION_ACTIVITY_LIMITS.maxPageSize);
	if (unique.length === 0) return new Map();
	const placeholders = unique.map(() => "?").join(", ");
	const result = await env.DB.prepare(
		`SELECT id, email, is_active FROM users WHERE id IN (${placeholders})`,
	)
		.bind(...unique)
		.all<ConversationActivityActorUserRow>();
	return new Map((result.results ?? []).map((row) => [row.id, row]));
}

function publicActor(
	actorKind: "user" | "mcp" | "agent" | "rule" | "system",
	actorId: string | null,
	users: ReadonlyMap<string, ConversationActivityActorUserRow>,
): ConversationActivityActor {
	if (actorKind === "system") return { kind: "system", label: "Mail portal" };
	if (actorKind === "rule") return { kind: "automation", label: "Automation" };
	const user = actorId ? users.get(actorId) : undefined;
	const email = user?.is_active === 1 ? boundedActorEmail(user.email) : null;
	if (actorKind === "user") {
		return {
			kind: "person",
			label: email ?? "Former team member",
		};
	}
	if (actorKind === "mcp") {
		return {
			kind: "mcp",
			label: email ? `${email} via MCP` : "Former team member",
		};
	}
	return {
		kind: "assistant",
		label: actorId
			? email
				? `${email} via AI assistant`
				: "Former team member"
			: "AI assistant",
	};
}

function isConversationActivityCode(value: string): value is ConversationActivityCode {
	return Object.prototype.hasOwnProperty.call(CONVERSATION_ACTIVITY_LABELS, value);
}

async function requireLiveAccess(
	dependencies: ConversationActivityRuntimeDependencies,
	input: Pick<RouteInput, "actorUserId" | "mailboxId">,
): Promise<void> {
	if (!(await dependencies.canAccess(input.actorUserId, input.mailboxId))) {
		throw new ConversationActivityAccessRevokedError();
	}
}

export async function runConversationActivity(
	dependencies: ConversationActivityRuntimeDependencies,
	input: Pick<
		RouteInput,
		"actorUserId" | "mailboxId" | "emailId" | "limit" | "cursor"
	>,
): Promise<ConversationActivityRouteResult> {
	await requireLiveAccess(dependencies, input);
	const projection = await dependencies.readProjection({
		emailId: input.emailId,
		limit: input.limit,
		cursor: input.cursor,
	});
	await requireLiveAccess(dependencies, input);
	if (projection.state !== "ready") return projection;
	const safeItems = projection.items.filter((item) =>
		isConversationActivityCode(item.code),
	);
	const actorIds = [...new Set(safeItems.flatMap((item) =>
		item.actorId && new Set(["user", "mcp", "agent"]).has(item.actorKind)
			? [item.actorId]
			: [],
	))];
	const users = await dependencies.readActorUsers(actorIds);
	await requireLiveAccess(dependencies, input);
	return {
		state: "ready",
		page: {
			items: safeItems.map((item) => ({
				id: item.id,
				code: item.code,
				label: CONVERSATION_ACTIVITY_LABELS[item.code],
				actor: publicActor(item.actorKind, item.actorId, users),
				occurredAt: item.occurredAt,
			})),
			nextCursor: projection.nextCursor,
		},
	};
}

const productionDependencies: ConversationActivityRouteDependencies = {
	run: (input) =>
		runConversationActivity(
			{
				canAccess: (actorUserId, mailboxId) =>
					mailboxAccess(input.env).canAccessMailbox(actorUserId, mailboxId),
				readProjection: async ({ emailId, limit, cursor }) =>
					(await input.stub.getConversationActivity(
						emailId,
						limit,
						cursor,
					)) as ConversationActivityProjection,
				readActorUsers: (actorIds) =>
					readConversationActivityActorUsers(input.env, actorIds),
			},
			input,
		),
};

export function createConversationActivityRoutes(
	dependencies: ConversationActivityRouteDependencies = productionDependencies,
) {
	const app = new Hono<ConversationActivityRouteContext>();
	const path = "/api/v1/mailboxes/:mailboxId/emails/:emailId/activity";
	app.use(path, async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.get(path, async (c) => {
		let query: ReturnType<typeof parseConversationActivityQuery>;
		try {
			const search = new URL(c.req.url).searchParams;
			for (const key of search.keys()) {
				if ((key !== "limit" && key !== "cursor") || search.getAll(key).length !== 1) {
					throw new Error("Conversation activity query is invalid");
				}
			}
			query = parseConversationActivityQuery({
				limit: c.req.query("limit"),
				cursor: c.req.query("cursor"),
			});
		} catch (error) {
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Conversation activity query is invalid",
				},
				400,
			);
		}
		const session = c.get("session")!;
		const mailboxId = c.var.authorizedMailboxId;
		const emailId = c.req.param("emailId")!;
		try {
			const result = await dependencies.run({
				env: c.env,
				actorUserId: session.sub,
				mailboxId,
				emailId,
				limit: query.limit,
				cursor: query.cursor,
				stub: c.get("mailboxStub")!,
			});
			if (result.state === "not_found") {
				return c.json({ error: "Conversation activity was not found" }, 404);
			}
			if (result.state === "invalid_cursor" || result.state === "invalid_request") {
				return c.json(
					{
						error:
							result.state === "invalid_cursor"
								? "Conversation activity cursor is invalid"
								: "Conversation activity query is invalid",
					},
					400,
				);
			}
			return c.json(result.page);
		} catch (error) {
			if (error instanceof ConversationActivityAccessRevokedError) {
				return c.json({ error: "Mailbox access is no longer active." }, 403);
			}
			console.error("[conversation-activity] read failed", {
				actorUserId: session.sub,
				mailboxId,
				emailId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return c.json(
				{ error: "Conversation activity is temporarily unavailable." },
				502,
			);
		}
	});
	return app;
}

export const conversationActivityRoutes = createConversationActivityRoutes();
