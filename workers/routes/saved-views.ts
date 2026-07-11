import { Hono } from "hono";
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
  Variables: { session?: SessionClaims };
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

function mailboxAddress(raw: string): string {
  return decodeURIComponent(raw).toLowerCase();
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
      return c.json({ error: error.message }, status);
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
      .list(session.sub, mailboxAddress(c.req.param("mailboxId")!));
    return c.json({ views: views.map(responseView) });
  });

  app.post("/api/v1/mailboxes/:mailboxId/saved-views", async (c) => {
    const session = c.get("session")!;
    const input = await c.req.json().catch(() => null);
    const view = await dependencies
      .service(c.env)
      .create(session.sub, mailboxAddress(c.req.param("mailboxId")!), input);
    return c.json(responseView(view), 201);
  });

  app.put("/api/v1/mailboxes/:mailboxId/saved-views/:viewId", async (c) => {
    const session = c.get("session")!;
    const input = await c.req.json().catch(() => null);
    const view = await dependencies
      .service(c.env)
      .update(
        c.req.param("viewId")!,
        session.sub,
        mailboxAddress(c.req.param("mailboxId")!),
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
        mailboxAddress(c.req.param("mailboxId")!),
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
          mailboxAddress(c.req.param("mailboxId")!),
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
