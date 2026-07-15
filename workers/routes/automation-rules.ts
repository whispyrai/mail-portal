import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	AUTOMATION_RULE_LIMITS,
	AUTOMATION_RUN_STATES,
	AutomationRuleDefinitionSchema,
} from "../../shared/automation-rules.ts";
import { decodeBase64Url } from "../../shared/base64url.ts";
import {
	AutomationRuleError,
	type AutomationDryRunRecord,
	type AutomationRunRecord,
	type AutomationRunResultRecord,
} from "../lib/automation-rules/index.ts";
import { automationDryRunTestId } from "../lib/automation-dry-run-idempotency.ts";
import { mailboxAccess } from "../lib/mailbox-access.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

export interface AutomationRouteDependencies {
	canManage(c: AppContext, userId: string, mailboxId: string): Promise<boolean>;
	canDisclose(c: AppContext): Promise<boolean>;
}

const productionDependencies: AutomationRouteDependencies = {
	canManage: (c, userId, mailboxId) =>
		mailboxAccess(c.env).canManageAutomationRules(userId, mailboxId),
	canDisclose: hasLiveMailboxContentAccess,
};

const MAX_BODY_BYTES = AUTOMATION_RULE_LIMITS.definitionBytes + 4_096;
const MAX_ID_CHARS = 300;
const MAX_PAGE_SIZE = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTROL_TEXT = /[\u0000-\u001F\u007F]/u;

const identifier = z.string().min(1).max(MAX_ID_CHARS).refine(
	(value) => value === value.trim().normalize("NFC") && !CONTROL_TEXT.test(value),
);
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const CreateBody = z.object({
	definition: AutomationRuleDefinitionSchema,
	expectedOrderRevision: nonnegativeInteger,
}).strict();
const UpdateBody = z.object({
	definition: AutomationRuleDefinitionSchema,
	expectedRevision: positiveInteger,
}).strict();
const RevisionBody = z.object({ expectedRevision: positiveInteger }).strict();
const EnableBody = z.object({ expectedRevision: positiveInteger }).strict();
const ReorderBody = z.object({
	orderedRuleIds: z.array(identifier).max(100).refine(
		(values) => new Set(values).size === values.length,
	),
	expectedOrderRevision: nonnegativeInteger,
}).strict();
const DryRunBody = z.object({
	definition: AutomationRuleDefinitionSchema,
	ruleId: identifier,
	ruleVersion: positiveInteger,
	acknowledgedZero: z.boolean(),
	operationId: z.string().uuid(),
}).strict();
const RestoreBody = z.object({
	version: positiveInteger,
	expectedRevision: positiveInteger,
}).strict();

class AutomationRequestError extends Error {
	readonly status: 400 | 413;
	readonly code: "INVALID" | "BODY_TOO_LARGE";

	constructor(status: 400 | 413, code: "INVALID" | "BODY_TOO_LARGE", message: string) {
		super(message);
		this.name = "AutomationRequestError";
		this.status = status;
		this.code = code;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^(?:0|[1-9]\d*)$/u.test(declared)) {
			throw new AutomationRequestError(400, "INVALID", "Request body is invalid");
		}
		const parsed = Number(declared);
		if (parsed > MAX_BODY_BYTES) {
			throw new AutomationRequestError(413, "BODY_TOO_LARGE", "Request body is too large");
		}
	}
	if (!request.body) throw new AutomationRequestError(400, "INVALID", "Request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new AutomationRequestError(413, "BODY_TOO_LARGE", "Request body is too large");
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
		return JSON.parse(decoder.decode(bytes));
	} catch {
		throw new AutomationRequestError(400, "INVALID", "Request body is invalid");
	}
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	const result = schema.safeParse(await boundedJsonBody(request));
	if (!result.success) {
		throw new AutomationRequestError(400, "INVALID", "Automation request is invalid");
	}
	return result.data;
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

type HistoryCursor = { v: 1; t: string; i: string };

function encodeCursor(value: Omit<HistoryCursor, "v">): string {
	return encodeBase64Url(encoder.encode(JSON.stringify({ v: 1, ...value })));
}

function decodeCursor(value: string): Omit<HistoryCursor, "v"> {
	if (!value || value.length > 2_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new AutomationRequestError(400, "INVALID", "Automation history cursor is invalid");
	}
	const bytes = decodeBase64Url(value);
	if (!bytes) throw new AutomationRequestError(400, "INVALID", "Automation history cursor is invalid");
	try {
		const parsed: unknown = JSON.parse(decoder.decode(bytes));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		const record = parsed as Record<string, unknown>;
		if (
			Object.keys(record).join(",") !== "v,t,i" ||
			record.v !== 1 ||
			typeof record.t !== "string" ||
			new Date(record.t).toISOString() !== record.t ||
			typeof record.i !== "string" ||
			!identifier.safeParse(record.i).success
		) throw new Error();
		const cursor = { t: record.t, i: record.i };
		if (encodeCursor(cursor) !== value) throw new Error();
		return cursor;
	} catch {
		throw new AutomationRequestError(400, "INVALID", "Automation history cursor is invalid");
	}
}

function one(params: URLSearchParams, key: string): string | null {
	const values = params.getAll(key);
	if (values.length > 1) {
		throw new AutomationRequestError(400, "INVALID", `${key} cannot be repeated`);
	}
	return values[0] ?? null;
}

function historyQuery(
	params: URLSearchParams,
	allowed: ReadonlySet<string>,
): { cursor: Omit<HistoryCursor, "v"> | null; limit: number } {
	for (const key of params.keys()) {
		if (!allowed.has(key)) {
			throw new AutomationRequestError(400, "INVALID", "Automation history query is invalid");
		}
	}
	const rawLimit = one(params, "limit");
	if (rawLimit !== null && !/^[1-9]\d*$/u.test(rawLimit)) {
		throw new AutomationRequestError(400, "INVALID", "Automation history limit is invalid");
	}
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
		throw new AutomationRequestError(400, "INVALID", "Automation history limit is invalid");
	}
	const rawCursor = one(params, "cursor");
	return { cursor: rawCursor === null ? null : decodeCursor(rawCursor), limit };
}

function errorCode(error: unknown): string | null {
	if (error instanceof AutomationRuleError) return error.code;
	if (!error || typeof error !== "object") return null;
	const record = error as Record<string, unknown>;
	if (typeof record.code === "string") return record.code;
	if (
		typeof record.name === "string" &&
		record.name.startsWith("AutomationRuleError:")
	) return record.name.slice("AutomationRuleError:".length);
	return null;
}

function mapAutomationError(c: AppContext, error: unknown) {
	if (error instanceof AutomationRequestError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	if (error instanceof z.ZodError) {
		return c.json({ error: "Automation request is invalid", code: "INVALID" }, 400);
	}
	const code = errorCode(error);
	const message = error instanceof Error ? error.message : "Automations are unavailable";
	if (code === "NOT_FOUND") return c.json({ error: message, code }, 404);
	if (
		code === "CONFLICT" ||
		code === "DRY_RUN_IDEMPOTENCY_CONFLICT" ||
		code === "ACTIVATION_TEST_REQUIRED" ||
		code === "RULE_TARGET_IN_USE"
	) {
		return c.json({ error: message, code }, 409);
	}
	if (code === "INVALID") return c.json({ error: message, code }, 400);
	console.error("[automation-rules] route failure", {
		error: error instanceof Error ? error.message : String(error),
	});
	return c.json({ error: "Automations are unavailable", code: "UNAVAILABLE" }, 500);
}

async function sessionAndManagement(c: AppContext, dependencies: AutomationRouteDependencies) {
	const session = c.get("session");
	if (!session) return null;
	const mailboxId = c.var.authorizedMailboxId;
	if (!mailboxId) return null;
	const canManage = await dependencies.canManage(c, session.sub, mailboxId);
	return { session, mailboxId, canManage };
}

async function revalidateDisclosure(
	c: AppContext,
	dependencies: AutomationRouteDependencies,
): Promise<boolean> {
	return dependencies.canDisclose(c);
}

async function revalidateManagement(
	c: AppContext,
	dependencies: AutomationRouteDependencies,
): Promise<boolean> {
	const identity = await sessionAndManagement(c, dependencies);
	return Boolean(identity?.canManage && await revalidateDisclosure(c, dependencies));
}

function messageHref(mailboxId: string, messageId: string): string {
	return `/mailbox/${encodeURIComponent(mailboxId)}/open/${encodeURIComponent(messageId)}`;
}

function publicTest(mailboxId: string, test: AutomationDryRunRecord) {
	return {
		id: test.id,
		ruleId: test.ruleId,
		ruleVersion: test.ruleVersion,
		definitionFingerprint: test.definitionFingerprint,
		evaluatedCount: test.evaluatedCount,
		matchedCount: test.matchedCount,
		acknowledgedZero: test.acknowledgedZero,
		actionCounts: {
			wouldChange: test.result.wouldChange,
			alreadySatisfied: test.result.alreadySatisfied,
			conflicts: test.result.conflicts,
		},
		samples: test.result.samples.map((sample) => ({
			messageId: sample.messageId,
			conversationId: sample.conversationId,
			sender: sample.sender,
			subject: sample.subject,
			date: sample.date,
			href: messageHref(mailboxId, sample.messageId),
			matchedConditionIndexes: sample.matchedConditionIndexes,
			plannedActions: sample.plannedActions,
			noOpActions: sample.noOpActions,
			conflicts: sample.conflicts,
		})),
		actorId: test.actorId,
		createdAt: test.createdAt,
		expiresAt: test.expiresAt,
	};
}

type AutomationRunRouteView = AutomationRunRecord & {
	message: {
		emailId: string;
		folderId: string;
		conversationId: string;
		sender: string;
		subject: string;
		date: string;
	} | null;
	results?: AutomationRunResultRecord[];
};

function publicRun(mailboxId: string, run: AutomationRunRouteView) {
	return {
		id: run.id,
		message: run.message
			? {
				state: "available" as const,
				messageId: run.message.emailId,
				conversationId: run.message.conversationId,
				sender: run.message.sender,
				subject: run.message.subject,
				date: run.message.date,
				href: messageHref(mailboxId, run.message.emailId),
			}
			: {
				state: "unavailable" as const,
				messageId: run.triggerMessageId,
				label: "Message no longer available" as const,
			},
		rulesetGeneration: run.rulesetGeneration,
		state: run.state,
		attemptCount: run.attemptCount,
		evaluatedCount: run.evaluatedCount,
		matchedCount: run.matchedCount,
		appliedCount: run.appliedCount,
		stoppedByRuleId: run.stoppedByRuleId,
		completedAt: run.completedAt,
		failureCategory: run.failureCategory,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.results ? {
			results: run.results.map((result) => ({
				ordinal: result.ordinal,
				ruleId: result.ruleId,
				ruleName: result.ruleName,
				ruleVersion: result.ruleVersion,
				outcome: result.outcome,
				matchedConditionIndexes: result.matchedConditionIndexes,
				plannedActions: result.plannedActions,
				actionResults: result.actionResults.map((action) => ({
					action: action.action,
					status: action.status,
				})),
				failureCategory: result.failureCategory,
				attemptCount: result.attemptCount,
				createdAt: result.createdAt,
			})),
		} : {}),
	};
}

async function resolveReadIdentity(c: AppContext, dependencies: AutomationRouteDependencies) {
	const identity = await sessionAndManagement(c, dependencies);
	if (!identity) return c.json({ error: "Unauthorized" }, 401);
	return identity;
}

async function resolveManageIdentity(c: AppContext, dependencies: AutomationRouteDependencies) {
	const identity = await sessionAndManagement(c, dependencies);
	if (!identity) return c.json({ error: "Unauthorized" }, 401);
	if (!identity.canManage) return c.json({ error: "Forbidden" }, 403);
	return identity;
}

function isResponse(value: unknown): value is Response {
	return value instanceof Response;
}

export function createAutomationRuleRoutes(
	dependencies: AutomationRouteDependencies = productionDependencies,
) {
	const routes = new Hono<MailboxContext>();
	const readIdentity = (c: AppContext) => resolveReadIdentity(c, dependencies);
	const manageIdentity = (c: AppContext) => resolveManageIdentity(c, dependencies);
	const canStillDisclose = (c: AppContext) => revalidateDisclosure(c, dependencies);
	const canStillManage = (c: AppContext) => revalidateManagement(c, dependencies);
	const automationError = async (c: AppContext, error: unknown) => {
		try {
			const stillAuthorized = c.req.method === "GET"
				? await canStillDisclose(c)
				: await canStillManage(c);
			if (!stillAuthorized) return c.json({ error: "Forbidden" }, 403);
		} catch {
			return c.json({ error: "Forbidden" }, 403);
		}
		return mapAutomationError(c, error);
	};

	routes.get("/api/v1/mailboxes/:mailboxId/automation-rules", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const result = await c.var.mailboxStub.listAutomationRules(true);
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({
				rules: result.rules,
				rulesetGeneration: result.rulesetGeneration,
				orderRevision: result.orderRevision,
				canManage: identity.canManage,
			});
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const ruleId = identifier.parse(c.req.param("ruleId"));
			const result = await c.var.mailboxStub.getAutomationRule(ruleId);
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return result
				? c.json({ ...result, canManage: identity.canManage })
				: c.json({ error: "Automation Rule was not found", code: "NOT_FOUND" }, 404);
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.post("/api/v1/mailboxes/:mailboxId/automation-rules", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, CreateBody);
			const result = await c.var.mailboxStub.createAutomationRuleDraft({
				...body,
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({ ...result, canManage: true as const }, 201);
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.put("/api/v1/mailboxes/:mailboxId/automation-rules/order", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, ReorderBody);
			const result = await c.var.mailboxStub.reorderAutomationRules({
				...body,
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({ ...result, canManage: true as const });
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.post("/api/v1/mailboxes/:mailboxId/automation-rules/dry-run", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, DryRunBody);
			const testId = await automationDryRunTestId({
				mailboxId: identity.mailboxId,
				actorId: identity.session.sub,
				operationId: body.operationId,
			});
			const { operationId: _operationId, ...command } = body;
			const test = await c.var.mailboxStub.dryRunAutomationRule({
				...command,
				testId,
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json(
				{
					test: publicTest(identity.mailboxId, test),
					replayed: test.replayed,
					canManage: true as const,
				},
				test.replayed ? 200 : 201,
			);
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.put("/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, UpdateBody);
			const result = await c.var.mailboxStub.updateAutomationRuleDraft({
				...body,
				ruleId: identifier.parse(c.req.param("ruleId")),
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({ ...result, canManage: true as const });
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.delete("/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, RevisionBody);
			const result = await c.var.mailboxStub.archiveAutomationRule({
				...body,
				ruleId: identifier.parse(c.req.param("ruleId")),
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({ ...result, canManage: true as const });
		} catch (error) {
			return automationError(c, error);
		}
	});

	for (const enabled of [true, false] as const) {
		const action = enabled ? "enable" : "disable";
		routes.post(`/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId/${action}`, async (c) => {
			try {
				const identity = await manageIdentity(c);
				if (isResponse(identity)) return identity;
				const body = await parseBody(c.req.raw, EnableBody);
				const result = await c.var.mailboxStub.setAutomationRuleEnabled({
					...body,
					ruleId: identifier.parse(c.req.param("ruleId")),
					enabled,
					actorId: identity.session.sub,
				});
				if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
				return c.json({ ...result, canManage: true as const });
			} catch (error) {
				return automationError(c, error);
			}
		});
	}

	routes.get("/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId/versions", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const result = await c.var.mailboxStub.getAutomationRule(
				identifier.parse(c.req.param("ruleId")),
			);
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return result
				? c.json({ versions: result.versions, canManage: identity.canManage })
				: c.json({ error: "Automation Rule was not found", code: "NOT_FOUND" }, 404);
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.post("/api/v1/mailboxes/:mailboxId/automation-rules/:ruleId/restore-version", async (c) => {
		try {
			const identity = await manageIdentity(c);
			if (isResponse(identity)) return identity;
			const body = await parseBody(c.req.raw, RestoreBody);
			const result = await c.var.mailboxStub.restoreAutomationRuleVersion({
				...body,
				ruleId: identifier.parse(c.req.param("ruleId")),
				actorId: identity.session.sub,
			});
			if (!(await canStillManage(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({ ...result, canManage: true as const });
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/automation-rule-tests", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const query = historyQuery(
				new URL(c.req.url).searchParams,
				new Set(["cursor", "limit", "ruleId"]),
			);
			const rawRuleId = one(new URL(c.req.url).searchParams, "ruleId");
			const ruleId = rawRuleId === null ? null : identifier.parse(rawRuleId);
			const result = await c.var.mailboxStub.listAutomationRuleTests({
				ruleId,
				beforeCreatedAt: query.cursor?.t ?? null,
				beforeId: query.cursor?.i ?? null,
				limit: query.limit,
			});
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({
				tests: result.tests.map((test) => publicTest(identity.mailboxId, test)),
				nextCursor: result.next ? encodeCursor({ t: result.next.createdAt, i: result.next.id }) : null,
				canManage: identity.canManage,
			});
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/automation-runs", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const params = new URL(c.req.url).searchParams;
			const query = historyQuery(params, new Set(["cursor", "limit", "state"]));
			const state = one(params, "state");
			if (state !== null && !AUTOMATION_RUN_STATES.includes(
				state as (typeof AUTOMATION_RUN_STATES)[number],
			)) throw new AutomationRequestError(400, "INVALID", "Automation Run state is invalid");
			const result = await c.var.mailboxStub.listAutomationRuns({
				state,
				beforeCreatedAt: query.cursor?.t ?? null,
				beforeId: query.cursor?.i ?? null,
				limit: query.limit,
			});
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return c.json({
				runs: result.runs.map((run) => publicRun(identity.mailboxId, run)),
				nextCursor: result.next ? encodeCursor({ t: result.next.createdAt, i: result.next.id }) : null,
				canManage: identity.canManage,
			});
		} catch (error) {
			return automationError(c, error);
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/automation-runs/:runId", async (c) => {
		try {
			const identity = await readIdentity(c);
			if (isResponse(identity)) return identity;
			const run = await c.var.mailboxStub.getAutomationRun(identifier.parse(c.req.param("runId")));
			if (!(await canStillDisclose(c))) return c.json({ error: "Forbidden" }, 403);
			return run
				? c.json({ run: publicRun(identity.mailboxId, run), canManage: identity.canManage })
				: c.json({ error: "Automation Run was not found", code: "NOT_FOUND" }, 404);
		} catch (error) {
			return automationError(c, error);
		}
	});

	return routes;
}

export const automationRuleRoutes = createAutomationRuleRoutes();
