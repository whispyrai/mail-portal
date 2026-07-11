const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin policy for browser routes authenticated by the session cookie.
 *
 * The SES callback is excluded because it has a dedicated bearer credential.
 * OAuth token and MCP endpoints are handled by OAuthProvider before this app.
 */
export function mutationOriginDecision(request: Request): "allow" | "forbid" {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return "allow";

	const url = new URL(request.url);
	if (url.pathname === "/webhooks/ses") return "allow";

	const origin = request.headers.get("origin");
	if (origin) return origin === url.origin ? "allow" : "forbid";

	const referer = request.headers.get("referer");
	if (referer) {
		try {
			return new URL(referer).origin === url.origin ? "allow" : "forbid";
		} catch {
			return "forbid";
		}
	}

	return request.headers.get("sec-fetch-site") === "same-origin"
		? "allow"
		: "forbid";
}
