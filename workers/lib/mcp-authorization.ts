import type { UserRole } from "../db/users-schema.ts";

export const DEFAULT_MCP_SCOPES = ["email.read", "email.send"] as const;
export const QUIZ_MCP_SCOPES = ["quiz.read", "quiz.write"] as const;
export const MCP_SCOPES: string[] = [
	...DEFAULT_MCP_SCOPES,
	...QUIZ_MCP_SCOPES,
];

export type QuizAccessMode = "read" | "write";

type McpIdentity = {
	userId?: string;
	scopes?: readonly string[];
	sessionVersion?: number;
};

type LiveMcpUser = {
	role: UserRole;
	is_active: number;
	session_version: number;
};

export function mcpCredentialVersionMatches(
	identity: Pick<McpIdentity, "sessionVersion">,
	user: Pick<LiveMcpUser, "session_version">,
): boolean {
	return (identity.sessionVersion ?? 1) === user.session_version;
}

export async function quizAuthorizationFailure(
	identity: McpIdentity | undefined,
	mode: QuizAccessMode,
	loadUser: (userId: string) => Promise<LiveMcpUser | undefined>,
): Promise<string | null> {
	if (!identity?.userId) return "Unauthenticated MCP session.";

	const user = await loadUser(identity.userId);
	if (
		!user ||
		user.is_active !== 1 ||
		user.role !== "ADMIN" ||
		!mcpCredentialVersionMatches(identity, user)
	) {
		return "Quiz tools require a live active administrator.";
	}

	const requiredScope = mode === "read" ? "quiz.read" : "quiz.write";
	if (!identity.scopes?.includes(requiredScope)) {
		return `Forbidden: this connection lacks ${requiredScope}.`;
	}
	return null;
}

export function legacyMcpScopes(role: UserRole): string[] {
	return role === "ADMIN" ? [...MCP_SCOPES] : [...DEFAULT_MCP_SCOPES];
}
