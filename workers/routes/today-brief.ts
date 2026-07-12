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

const TODAY_BRIEF_REQUEST_BYTES = 1_024;

const requestSchema = z
	.object({ timeZone: z.string().trim().min(1).max(100) })
	.strict();

export type TodayBriefRouteContext = {
	Bindings: Env;
	Variables: {
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

function normalizedMailboxId(raw: string): string {
	try {
		const mailboxId = decodeURIComponent(raw).trim().toLowerCase();
		if (!mailboxId || mailboxId.length > 320) throw new Error();
		return mailboxId;
	} catch {
		throw new TodayBriefBodyError();
	}
}

export function createTodayBriefRoutes(
	dependencies: TodayBriefRouteDependencies = productionDependencies,
) {
	const app = new Hono<TodayBriefRouteContext>();
	app.use("/api/v1/mailboxes/:mailboxId/today-brief", async (c, next) => {
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
			mailboxId = normalizedMailboxId(c.req.param("mailboxId")!);
		} catch (error) {
			if (error instanceof TodayBriefBodyError && error.tooLarge) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "Today brief request is invalid" }, 400);
		}

		const session = c.get("session")!;
		try {
			return c.json(
				await dependencies.run({
					env: c.env,
					actorUserId: session.sub,
					mailboxId,
					day,
					stub: c.get("mailboxStub")!,
				}),
			);
		} catch (error) {
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
