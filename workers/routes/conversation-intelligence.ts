import { Hono } from "hono";
import { z } from "zod";
import type { SessionClaims } from "../lib/auth.ts";
import type { MailboxDO } from "../durableObject/index.ts";
import type { Env } from "../types.ts";
import {
  ConversationIntelligenceNotFoundError,
  ConversationIntelligenceUnsupportedStateError,
  createConversationIntelligenceRuntime,
  runConversationIntelligence,
  type ConversationIntelligenceRuntimeResponse,
} from "../lib/conversation-intelligence-runtime.ts";

export type ConversationIntelligenceRouteContext = {
  Bindings: Env;
  Variables: {
    session?: SessionClaims;
    mailboxStub?: DurableObjectStub<MailboxDO>;
  };
};

type RunInput = {
  mailboxId: string;
  actorUserId: string;
  emailId: string;
  force: boolean;
  stub: DurableObjectStub<MailboxDO>;
};

export interface ConversationIntelligenceRouteDependencies {
  run(input: RunInput): Promise<ConversationIntelligenceRuntimeResponse>;
}

const requestSchema = z.object({ refresh: z.boolean().optional() }).strict();

export function createConversationIntelligenceApp(
  dependencies?: ConversationIntelligenceRouteDependencies,
) {
  const app = new Hono<ConversationIntelligenceRouteContext>();
  app.post(
    "/api/v1/mailboxes/:mailboxId/emails/:emailId/intelligence",
    async (c) => {
      const session = c.get("session");
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      const stub = c.get("mailboxStub");
      if (!stub) return c.json({ error: "Mailbox access is required" }, 403);
      const parsed = requestSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
      const mailboxId = decodeURIComponent(
        c.req.param("mailboxId")!,
      ).toLowerCase();
      const run =
        dependencies?.run ??
        (async (input: RunInput) =>
          runConversationIntelligence(
            createConversationIntelligenceRuntime(c.env, input.stub),
            input,
          ));
      try {
        return c.json(
          await run({
            mailboxId,
            actorUserId: session.sub,
            emailId: c.req.param("emailId")!,
            force: parsed.data.refresh === true,
            stub,
          }),
        );
      } catch (error) {
        if (error instanceof ConversationIntelligenceUnsupportedStateError) {
          return c.json(
            {
              error: error.message,
              code: "unsupported_message_state",
            },
            409,
          );
        }
        if (error instanceof ConversationIntelligenceNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        console.error("[conversation-intelligence] generation failed", {
          mailboxId,
          emailId: c.req.param("emailId")!,
          error: error instanceof Error ? error.name : "unknown",
        });
        return c.json(
          { error: "Conversation intelligence is temporarily unavailable." },
          502,
        );
      }
    },
  );
  return app;
}

export const conversationIntelligenceApp = createConversationIntelligenceApp();
