import { Hono, type Context } from "hono";
import {
	RelationshipBriefContractError,
	parseRelationshipBriefRequest,
	validateRelationshipBriefResponse,
	type RelationshipBriefResponse,
} from "../../shared/relationship-brief.ts";
import { validateMailPersonId } from "../../shared/mail-people.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";
import {
	RelationshipBriefAccessRevokedError,
	createRelationshipBriefRuntime,
	runRelationshipBrief,
} from "../lib/relationship-brief-runtime.ts";

const MAX_BODY_BYTES = 256;
type AppContext = Context<MailboxContext>;

export type RelationshipBriefRouteInput = {
	env: AppContext["env"];
	actorUserId: string;
	mailboxId: string;
	personId: string;
	refresh: boolean;
	stub: DurableObjectStub<MailboxDO>;
};

export type RelationshipBriefRouteDependencies = {
	run(input: RelationshipBriefRouteInput): Promise<RelationshipBriefResponse>;
	revalidateAccess(context: AppContext): Promise<boolean>;
};

class RelationshipBriefRequestError extends Error {
	readonly tooLarge: boolean;
	constructor(tooLarge = false) {
		super("Relationship brief request is invalid");
		this.tooLarge = tooLarge;
	}
}

async function boundedJson(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
		throw new RelationshipBriefRequestError(true);
	}
	if (!request.body) throw new RelationshipBriefRequestError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new RelationshipBriefRequestError(true);
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
		throw new RelationshipBriefRequestError();
	}
}

function personId(raw: string): string {
	try {
		return validateMailPersonId(decodeURIComponent(raw));
	} catch {
		throw new RelationshipBriefRequestError();
	}
}

const productionDependencies: RelationshipBriefRouteDependencies = {
	run: (input) => runRelationshipBrief(
		createRelationshipBriefRuntime(input.env, input),
		input,
	),
	revalidateAccess: hasLiveMailboxContentAccess,
};

export function createRelationshipBriefRoutes(
	dependencies: RelationshipBriefRouteDependencies = productionDependencies,
) {
	const app = new Hono<MailboxContext>();
	app.post(
		"/api/v1/mailboxes/:mailboxId/people/:personId/relationship-brief",
		async (c) => {
			const session = c.get("session");
			if (!session) return c.json({ error: "Unauthorized" }, 401);
			const stub = c.get("mailboxStub");
			if (!stub) return c.json({ error: "Forbidden" }, 403);

			let request: { refresh: boolean };
			let mailbox: string;
			let person: string;
			try {
				request = parseRelationshipBriefRequest(await boundedJson(c.req.raw));
				mailbox = c.var.authorizedMailboxId;
				person = personId(c.req.param("personId") ?? "");
			} catch (error) {
				if (error instanceof RelationshipBriefRequestError && error.tooLarge) {
					return c.json({ error: "Relationship brief request is too large" }, 413);
				}
				return c.json({ error: "Relationship brief request is invalid" }, 400);
			}

			const outcome = await dependencies.run({
				env: c.env,
				actorUserId: session.sub,
				mailboxId: mailbox,
				personId: person,
				refresh: request.refresh,
				stub,
			}).then(
				(value) => ({ state: "success" as const, value }),
				(error: unknown) => ({ state: "failure" as const, error }),
			);
			if (!(await dependencies.revalidateAccess(c))) {
				return c.json({ error: "Forbidden" }, 403);
			}
			if (outcome.state === "failure") {
				if (outcome.error instanceof RelationshipBriefAccessRevokedError) {
					return c.json({ error: "Forbidden" }, 403);
				}
				console.error("[relationship-brief] generation failed", {
					actorUserId: session.sub,
					mailboxId: mailbox,
					personId: person,
					errorName: outcome.error instanceof Error ? outcome.error.name : "UnknownError",
				});
				return c.json({ error: "The relationship brief is temporarily unavailable." }, 502);
			}
			try {
				return c.json(validateRelationshipBriefResponse(outcome.value));
			} catch (error) {
				if (error instanceof RelationshipBriefContractError) {
					return c.json({ error: "The relationship brief is temporarily unavailable." }, 502);
				}
				throw error;
			}
		},
	);
	return app;
}

export const relationshipBriefRoutes = createRelationshipBriefRoutes();
