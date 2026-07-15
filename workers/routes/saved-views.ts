import { Hono } from "hono";
import { z } from "zod";
import type { SessionClaims } from "../lib/auth.ts";
import {
  SavedViewError,
  savedViewSearchParams,
  type SavedViewRecord,
} from "../lib/saved-views.ts";
import { savedViewService } from "../lib/saved-views-d1.ts";
import type { Env } from "../types.ts";

export type SavedViewOperations = ReturnType<typeof savedViewService>;

export type SavedViewsContext = {
  Bindings: Env;
	Variables: { authorizedMailboxId: string; session?: SessionClaims };
};

export interface SavedViewsDependencies {
  service(env: Env): SavedViewOperations;
}

const productionDependencies: SavedViewsDependencies = {
  service: savedViewService,
};

function responseView(row: SavedViewRecord) {
  return {
    id: row.id,
    mailboxAddress: row.mailboxAddress,
    name: row.name,
    filters: row.filters,
    sort: row.sort,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createSavedViewsApp(
  dependencies: SavedViewsDependencies = productionDependencies,
) {
  const app = new Hono<SavedViewsContext>();

  app.onError((error, c) => {
    if (error instanceof SavedViewError) {
      const status =
        error.code === "INVALID"
          ? 400
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "NOT_FOUND"
              ? 404
              : 409;
      const code =
        error.code === "CREATE_IDEMPOTENCY_CONFLICT"
          ? "create_idempotency_conflict"
          : error.code === "CREATION_SUPERSEDED"
            ? "creation_superseded"
            : error.code === "CREATION_UNAVAILABLE"
              ? "creation_unavailable"
              : undefined;
      return c.json(
        {
          error: error.message,
          ...(code ? { code } : {}),
          ...(error.resourceId ? { resourceId: error.resourceId } : {}),
          ...(error.currentRevision != null
            ? { currentRevision: error.currentRevision }
            : {}),
        },
        status,
      );
    }
    throw error;
  });

  app.use("/api/v1/mailboxes/:mailboxId/saved-views/*", async (c, next) => {
    if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.use("/api/v1/mailboxes/:mailboxId/saved-views", async (c, next) => {
    if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.get("/api/v1/mailboxes/:mailboxId/saved-views", async (c) => {
    const session = c.get("session")!;
    const views = await dependencies
      .service(c.env)
			.list(session.sub, c.var.authorizedMailboxId);
    return c.json({ views: views.map(responseView) });
  });

  app.post("/api/v1/mailboxes/:mailboxId/saved-views", async (c) => {
    const session = c.get("session")!;
    const input = await c.req.json().catch(() => null);
    const parsed = z
      .object({ operationId: z.string().uuid() })
      .passthrough()
      .safeParse(input);
    if (!parsed.success) {
      throw new SavedViewError("INVALID", "Saved view operation ID is invalid");
    }
    const { operationId, ...definition } = parsed.data;
    const view = await dependencies
      .service(c.env)
      .create(session.sub, c.var.authorizedMailboxId, definition, operationId);
    return c.json(
      { ...responseView(view), replayed: Boolean(view.replayed) },
      view.replayed ? 200 : 201,
    );
  });

  app.put("/api/v1/mailboxes/:mailboxId/saved-views/:viewId", async (c) => {
    const session = c.get("session")!;
    const input = await c.req.json().catch(() => null);
    const view = await dependencies
      .service(c.env)
      .update(
        c.req.param("viewId")!,
        session.sub,
				c.var.authorizedMailboxId,
        input,
      );
    return c.json(responseView(view));
  });

  app.delete("/api/v1/mailboxes/:mailboxId/saved-views/:viewId", async (c) => {
    const session = c.get("session")!;
    await dependencies
      .service(c.env)
      .delete(
        c.req.param("viewId")!,
        session.sub,
				c.var.authorizedMailboxId,
      );
    return c.body(null, 204);
  });

  app.post(
    "/api/v1/mailboxes/:mailboxId/saved-views/:viewId/use",
    async (c) => {
      const session = c.get("session")!;
      const view = await dependencies
        .service(c.env)
        .use(
          c.req.param("viewId")!,
          session.sub,
					c.var.authorizedMailboxId,
        );
      return c.json({
        view: responseView(view),
        searchParams: savedViewSearchParams(view),
      });
    },
  );

  return app;
}

export const savedViewsApp = createSavedViewsApp();
