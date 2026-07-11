import type { SessionClaims } from "./auth.ts";

export interface ActivityActor {
	kind: "user" | "mcp" | "agent" | "rule" | "system";
	id?: string;
}

export function actorFromSession(
	session: SessionClaims | undefined,
): ActivityActor {
	return session
		? { kind: "user", id: session.sub }
		: { kind: "system" };
}
