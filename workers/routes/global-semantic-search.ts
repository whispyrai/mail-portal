import { Hono } from "hono";
import {
	parseSemanticSearchRequest,
	type SemanticSearchResponse,
} from "../../shared/semantic-search.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { isSemanticSearchEnabled } from "../lib/features.ts";
import {
	createGlobalSemanticSearchDependencies,
	SemanticSearchCapacityError,
	searchSemanticEvidence,
} from "../lib/global-semantic-search.ts";
import { resolveBrand } from "./brand.ts";
import type { Env } from "../types.ts";

const REQUEST_BYTES = 2_048;

export type GlobalSemanticSearchRouteContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

export type GlobalSemanticSearchRouteInput = {
	env: Env;
	actorUserId: string;
	query: string;
	waitUntil(work: Promise<unknown>): void;
};

export type GlobalSemanticSearchRouteDependencies = {
	run(input: GlobalSemanticSearchRouteInput): Promise<SemanticSearchResponse>;
};

const productionDependencies: GlobalSemanticSearchRouteDependencies = {
	run: (input) => searchSemanticEvidence(
		createGlobalSemanticSearchDependencies(input.env, input.waitUntil),
		{ actorUserId: input.actorUserId, query: input.query },
	),
};

class SemanticBodyError extends Error {
	readonly tooLarge: boolean;

	constructor(tooLarge = false) {
		super(tooLarge ? "Semantic search request is too large" : "Semantic search request is invalid");
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		throw new SemanticBodyError();
	}
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > REQUEST_BYTES) {
			throw new SemanticBodyError(true);
		}
	}
	if (!request.body) throw new SemanticBodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new SemanticBodyError(true);
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
		throw new SemanticBodyError();
	}
}

export function createGlobalSemanticSearchRoutes(
	dependencies: GlobalSemanticSearchRouteDependencies = productionDependencies,
) {
	const app = new Hono<GlobalSemanticSearchRouteContext>();
	app.post("/api/v1/semantic-search", async (c) => {
		c.header("Cache-Control", "private, no-store");
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		const brand = resolveBrand(c.env.BRAND);
		if (!isSemanticSearchEnabled(c.env.FEATURES, brand.id)) {
			return c.json({ error: "Not found" }, 404);
		}
		if (!c.env.SEMANTIC_INDEX) {
			return c.json({ error: "Meaning search is temporarily unavailable" }, 503);
		}

		let query: string;
		try {
			query = parseSemanticSearchRequest(
				await boundedJsonBody(c.req.raw),
			).query;
		} catch (error) {
			if (error instanceof SemanticBodyError && error.tooLarge) {
				return c.json({ error: error.message }, 413);
			}
			return c.json({ error: "Semantic search request is invalid" }, 400);
		}

		try {
			return c.json(await dependencies.run({
				env: c.env,
				actorUserId: session.sub,
				query,
				waitUntil: (work) => c.executionCtx.waitUntil(work),
			}));
		} catch (error) {
			if (error instanceof SemanticSearchCapacityError) {
				return c.json({
					error: "Meaning search currently supports up to 20 accessible Mailboxes",
					limit: 20,
					actual: error.actual,
				}, 422);
			}
			return c.json({
				error: "Meaning search is temporarily unavailable. Exact search remains available.",
			}, 503);
		}
	});
	return app;
}

export const globalSemanticSearchRoutes = createGlobalSemanticSearchRoutes();
