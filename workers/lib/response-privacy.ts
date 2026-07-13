import { createMiddleware } from "hono/factory";

export const PRIVATE_NO_STORE = "private, no-store";

const SENSITIVE_AUTHENTICATION_PATHS = new Set([
	"/authorize",
	"/token",
	"/register",
	"/mcp",
	"/login",
	"/logout",
	"/account/recover",
	"/account/recover/request",
]);

export function isSensitiveAuthenticationPath(pathname: string): boolean {
	return SENSITIVE_AUTHENTICATION_PATHS.has(pathname);
}

export function setPrivateNoStore(context: { res: Response }): void {
	const response = context.res;
	context.res = new Response(response.body, response);
	context.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
}

/**
 * Replace a finalized sensitive response without retaining its entity metadata.
 * Hono merges existing response headers when assigning `context.res`, so scrub
 * everything except transport and browser-security headers after replacement.
 */
export function replaceWithPrivateResponse(
	context: { res: Response },
	response: Response,
): void {
	context.res = response;
	for (const name of [...context.res.headers.keys()]) {
		const normalized = name.toLowerCase();
		if (
			normalized === "content-type" ||
			normalized === "cache-control" ||
			normalized === "vary" ||
			normalized === "strict-transport-security" ||
			normalized === "x-content-type-options" ||
			normalized === "cross-origin-resource-policy" ||
			normalized.startsWith("access-control-")
		) {
			continue;
		}
		context.res.headers.delete(name);
	}
	context.res.headers.set("Cache-Control", PRIVATE_NO_STORE);
}

/** Prevent authenticated response bodies from being retained by browser or shared caches. */
export const privateNoStore = createMiddleware(async (c, next) => {
	await next();
	setPrivateNoStore(c);
});

export function withPrivateNoStore(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", PRIVATE_NO_STORE);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
