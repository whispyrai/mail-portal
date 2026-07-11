import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	SnoozeValidationError,
	normalizeSnoozeRequest,
	normalizeSnoozeScope,
	type SnoozeRequest,
} from "../lib/snooze.ts";
import type { SnoozeMutationResult } from "../durableObject/snooze-state.ts";
import type { Env } from "../types.ts";

export interface SnoozeRouteOperations {
	snooze(
		input: SnoozeRequest,
		actor: ReturnType<typeof actorFromSession>,
	): Promise<SnoozeMutationResult>;
	unsnooze(
		input: SnoozeRequest["scope"],
		actor: ReturnType<typeof actorFromSession>,
	): Promise<SnoozeMutationResult>;
}

export type SnoozeRouteContext = {
	Bindings: Env;
	Variables: {
		session?: SessionClaims;
		mailboxStub?: SnoozeRouteOperations;
	};
};

export interface SnoozeRouteDependencies {
	operations(context: { var: { mailboxStub?: SnoozeRouteOperations } }): SnoozeRouteOperations;
}

const productionDependencies: SnoozeRouteDependencies = {
	operations: (context) => context.var.mailboxStub!,
};

function mutationResponse(result: SnoozeMutationResult, c: any) {
	if (result.status === "snoozed" || result.status === "unsnoozed") {
		return c.json(result);
	}
	const notFound = result.status === "not_found";
	return c.json({
		error: notFound
			? "Message or conversation was not found"
			: "Snooze state could not be changed",
		code: result.status,
	}, notFound ? 404 : 409);
}

export function createSnoozeRoutes(
	dependencies: SnoozeRouteDependencies = productionDependencies,
) {
	const app = new Hono<SnoozeRouteContext>();
	app.onError((error, c) => {
		if (error instanceof SnoozeValidationError) {
			return c.json({ error: error.message, code: "invalid_snooze" }, 400);
		}
		throw error;
	});

	app.post("/api/v1/mailboxes/:mailboxId/snooze", async (c) => {
		const input = normalizeSnoozeRequest(await c.req.json().catch(() => null));
		return mutationResponse(
			await dependencies.operations(c).snooze(
				input,
				actorFromSession(c.get("session")),
			),
			c,
		);
	});

	app.post("/api/v1/mailboxes/:mailboxId/snooze/clear", async (c) => {
		const body = await c.req.json().catch(() => null) as { scope?: unknown } | null;
		const scope = normalizeSnoozeScope(body?.scope);
		return mutationResponse(
			await dependencies.operations(c).unsnooze(
				scope,
				actorFromSession(c.get("session")),
			),
			c,
		);
	});

	return app;
}

export const snoozeRoutes = createSnoozeRoutes();
