import { Hono } from "hono";
import type {
	FollowUpReminder,
	FollowUpReminderListPage,
} from "../../shared/follow-up-reminders.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { followUpReminderService } from "../lib/follow-up-reminders-d1.ts";
import {
	FollowUpReminderError,
	type FollowUpReminderErrorCode,
} from "../lib/follow-up-reminders.ts";
import type { Env } from "../types.ts";

export interface FollowUpReminderRouteService {
	list(
		userId: string,
		mailboxAddress: string,
		limit?: number,
		cursor?: string,
	): Promise<FollowUpReminderListPage>;
	create(
		userId: string,
		mailboxAddress: string,
		input: unknown,
	): Promise<FollowUpReminder>;
	apply(
		userId: string,
		mailboxAddress: string,
		reminderId: string,
		input: unknown,
	): Promise<FollowUpReminder>;
}

export type FollowUpReminderRouteContext = {
	Bindings: Env;
	Variables: { authorizedMailboxId: string; session?: SessionClaims };
};

export interface FollowUpReminderRouteDependencies {
	service(env: Env): FollowUpReminderRouteService;
}

const productionDependencies: FollowUpReminderRouteDependencies = {
	service: followUpReminderService,
};

const MAX_REQUEST_BODY_BYTES = 2_048;

class FollowUpReminderRequestTooLargeError extends Error {
	constructor() {
		super("Reminder request body is too large");
		this.name = "FollowUpReminderRequestTooLargeError";
	}
}

const errorStatuses: Record<FollowUpReminderErrorCode, 400 | 403 | 404 | 409> = {
	INVALID: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	ACTIVE_CONFLICT: 409,
	STATE_CONFLICT: 409,
	IDEMPOTENCY_CONFLICT: 409,
};

function listLimit(raw: string | undefined): number {
	if (raw === undefined) return 100;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new FollowUpReminderError("INVALID", "Reminder list limit is invalid");
	}
	const limit = Number(raw);
	if (!Number.isSafeInteger(limit) || limit > 100) {
		throw new FollowUpReminderError("INVALID", "Reminder list limit is invalid");
	}
	return limit;
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (Number.isFinite(parsedLength) && parsedLength > MAX_REQUEST_BODY_BYTES) {
			throw new FollowUpReminderRequestTooLargeError();
		}
	}

	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_REQUEST_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new FollowUpReminderRequestTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return null;
	}
}

export function createFollowUpReminderRoutes(
	dependencies: FollowUpReminderRouteDependencies = productionDependencies,
) {
	const app = new Hono<FollowUpReminderRouteContext>();

	app.onError((error, c) => {
		if (error instanceof FollowUpReminderRequestTooLargeError) {
			return c.json(
				{ error: error.message, code: "REQUEST_TOO_LARGE" },
				413,
			);
		}
		if (error instanceof FollowUpReminderError) {
			return c.json(
				{ error: error.message, code: error.code },
				errorStatuses[error.code],
			);
		}
		throw error;
	});

	app.use("/api/v1/mailboxes/:mailboxId/follow-up-reminders/*", async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/follow-up-reminders", async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		await next();
	});

	app.get("/api/v1/mailboxes/:mailboxId/follow-up-reminders", async (c) => {
		const session = c.get("session")!;
		const page = await dependencies.service(c.env).list(
			session.sub,
			c.var.authorizedMailboxId,
			listLimit(c.req.query("limit")),
			c.req.query("cursor"),
		);
		return c.json(page);
	});

	app.post("/api/v1/mailboxes/:mailboxId/follow-up-reminders", async (c) => {
		const session = c.get("session")!;
		const input = await boundedJsonBody(c.req.raw);
		const reminder = await dependencies.service(c.env).create(
			session.sub,
			c.var.authorizedMailboxId,
			input,
		);
		return c.json({ reminder }, 201);
	});

	app.post(
		"/api/v1/mailboxes/:mailboxId/follow-up-reminders/:reminderId/operations",
		async (c) => {
			const session = c.get("session")!;
			const input = await boundedJsonBody(c.req.raw);
			const reminder = await dependencies.service(c.env).apply(
				session.sub,
				c.var.authorizedMailboxId,
				c.req.param("reminderId")!,
				input,
			);
			return c.json({ reminder });
		},
	);

	return app;
}

export const followUpReminderRoutes = createFollowUpReminderRoutes();
