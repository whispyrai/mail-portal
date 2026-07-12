import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { buildGlobalToday, createGlobalTodayDependencies, type GlobalTodayDependencies } from "../lib/global-today.ts";
import { resolveTodayBriefDay } from "../lib/today-brief-timezone.ts";
import type { Env } from "../types.ts";

export type GlobalTodayRouteContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

export type GlobalTodayRouteDependencies = {
	operations(env: Env): GlobalTodayDependencies;
};

const productionDependencies: GlobalTodayRouteDependencies = { operations: createGlobalTodayDependencies };

function parseTimeZone(url: URL) {
	const keys = [...url.searchParams.keys()];
	if (keys.length !== 1 || keys[0] !== "timeZone") throw new Error("Global Today query is invalid");
	return resolveTodayBriefDay(url.searchParams.get("timeZone") ?? "");
}

export function createGlobalTodayRoutes(dependencies: GlobalTodayRouteDependencies = productionDependencies) {
	const app = new Hono<GlobalTodayRouteContext>();
	app.get("/api/v1/today", async (c) => {
		c.header("Cache-Control", "private, no-store");
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		let day;
		try {
			day = parseTimeZone(new URL(c.req.url));
		} catch {
			return c.json({ error: "Global Today query is invalid" }, 400);
		}
		try {
			return c.json(await buildGlobalToday(dependencies.operations(c.env), { actorUserId: session.sub, day }));
		} catch (error) {
			console.error("[global-today] snapshot failed", { actorUserId: session.sub, errorName: error instanceof Error ? error.name : "UnknownError" });
			return c.json({ error: "Today is temporarily unavailable" }, 502);
		}
	});
	return app;
}

export const globalTodayRoutes = createGlobalTodayRoutes();
