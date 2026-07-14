import type { SessionClaims } from "./auth.ts";
import { sessionMatchesUserVersion } from "./auth.ts";
import { getUserById } from "./users.ts";
import type { Env } from "../types.ts";

export type LiveSessionUser = NonNullable<
	Awaited<ReturnType<typeof getUserById>>
>;

/** Only an accepted Agent WebSocket can leave the HTTP response path early. */
export function isAcceptedAgentWebSocket(
	pathname: string,
	upgradeHeader: string | undefined,
	responseStatus: number,
): boolean {
	return pathname.startsWith("/agents/") &&
		upgradeHeader?.toLowerCase() === "websocket" &&
		responseStatus === 101;
}

/** Resolve the canonical Mailbox name carried by an Agent route. */
export function agentMailboxFromPath(pathname: string): string | null {
	if (!pathname.startsWith("/agents/")) return null;
	const encoded = pathname.split("/").filter(Boolean)[2];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded).toLowerCase();
	} catch {
		return null;
	}
}

/** Resolve only the active user represented by this exact credential generation. */
export async function resolveLiveSessionUser(
	env: Env,
	claims: Pick<SessionClaims, "sub" | "sessionVersion">,
	loadUser: (env: Env, userId: string) => Promise<LiveSessionUser | undefined> = getUserById,
): Promise<LiveSessionUser | null> {
	const user = await loadUser(env, claims.sub);
	return user && user.is_active === 1 && sessionMatchesUserVersion(claims, user)
		? user
		: null;
}
