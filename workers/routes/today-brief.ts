import { Hono } from "hono";
import { z } from "zod";
import type { MailboxDO } from "../durableObject/index.ts";
import type { SessionClaims } from "../lib/auth.ts";
import type { TodayBriefDayBoundary } from "../lib/today-brief-timezone.ts";
import { resolveTodayBriefDay } from "../lib/today-brief-timezone.ts";
import {
	createTodayBriefRuntime,
	runTodayBrief,
} from "../lib/today-brief-runtime.ts";
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

const TODAY_BRIEF_REQUEST_BYTES = 1_024;

const requestSchema = z
	.object({ timeZone: z.string().trim().min(1).max(100) })
	.strict();

export type TodayBriefRouteContext = {
	Bindings: Env;
	Variables: {
		authorizedMailboxId: string;
		session?: SessionClaims;
		mailboxStub?: DurableObjectStub<MailboxDO>;
	};
};

export type TodayBriefRouteInput = {
	env: Env;
	actorUserId: string;
	mailboxId: string;
	day: TodayBriefDayBoundary;
	stub: DurableObjectStub<MailboxDO>;
};

export interface TodayBriefRouteDependencies {
	run(input: TodayBriefRouteInput): Promise<unknown>;
}

const productionDependencies: TodayBriefRouteDependencies = {
	run: (input) =>
		runTodayBrief(
			createTodayBriefRuntime(input.env, input),
			{
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				requestScope: `${input.day.localDate}:${input.day.timeZone}`,
			},
		),
};

class TodayBriefBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(tooLarge ? "Today brief request is too large" : "Today brief request is invalid");
		this.name = "TodayBriefBodyError";
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > TODAY_BRIEF_REQUEST_BYTES) {
			throw new TodayBriefBodyError(true);
		}
	}
	if (!request.body) throw new TodayBriefBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > TODAY_BRIEF_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new TodayBriefBodyError(true);
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
		throw new TodayBriefBodyError();
	}
}

export function createTodayBriefRoutes(
	dependencies: TodayBriefRouteDependencies = productionDependencies,
	authorize: LiveMailboxAccessAuthorizer = hasExactLiveMailboxAccess,
) {
	const app = new Hono<TodayBriefRouteContext>();
	app.use("/api/v1/mailboxes/:mailboxId/today-brief", async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		if (!c.get("mailboxStub")) {
			return c.json({ error: "Mailbox access is required" }, 403);
		}
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/today-brief", async (c) => {
		let day: TodayBriefDayBoundary;
		let mailboxId: string;
		try {
			const body = await boundedJsonBody(c.req.raw);
			const parsed = requestSchema.safeParse(body);
			if (!parsed.success) throw new TodayBriefBodyError();
			day = resolveTodayBriefDay(parsed.data.timeZone);
			mailboxId = c.var.authorizedMailboxId;
		} catch (error) {
			if (error instanceof TodayBriefBodyError && error.tooLarge) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "Today brief request is invalid" }, 400);
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
						day,
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
			console.error("[today-brief] generation failed", {
				actorUserId: session.sub,
				mailboxId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return c.json(
				{ error: "The AI brief is temporarily unavailable. Today remains fully usable." },
				502,
			);
		}
	});
	return app;
}

export const todayBriefRoutes = createTodayBriefRoutes();
