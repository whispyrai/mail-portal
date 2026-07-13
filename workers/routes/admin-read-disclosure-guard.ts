import { createMiddleware } from "hono/factory";
import type { SessionClaims } from "../lib/auth.ts";
import {
	replaceWithPrivateResponse,
	withPrivateNoStore,
} from "../lib/response-privacy.ts";
import type { Env } from "../types.ts";

export type AdminRouteContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

function isReadMethod(method: string): boolean {
	return method === "GET" || method === "HEAD";
}

/** Keep every worker-rendered administrator read behind a live authorization boundary. */
export function createAdminReadDisclosureGuard(options: {
	checkAdministrator: (env: Env, userId: string) => Promise<boolean>;
}) {
	return createMiddleware<AdminRouteContext>(async (c, next) => {
		const session = c.get("session");
		if (!session) return withPrivateNoStore(c.text("Forbidden", 403));

		let authorized: boolean;
		try {
			authorized = await options.checkAdministrator(c.env, session.sub);
		} catch (error) {
			console.error("[admin] live authorization check failed", {
				operation: "admin_authorization_check",
				phase: "before_read",
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				userId: session.sub,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return withPrivateNoStore(c.text("Internal Server Error", 500));
		}
		if (!authorized) return withPrivateNoStore(c.text("Forbidden", 403));

		await next();
		if (!isReadMethod(c.req.method)) return;

		try {
			authorized = await options.checkAdministrator(c.env, session.sub);
		} catch (error) {
			console.error("[admin] live authorization check failed", {
				operation: "admin_authorization_check",
				phase: "after_read",
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				userId: session.sub,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			replaceWithPrivateResponse(
				c,
				c.text("Internal Server Error", 500),
			);
			return;
		}
		if (!authorized) {
			replaceWithPrivateResponse(c, c.text("Forbidden", 403));
		}
	});
}
