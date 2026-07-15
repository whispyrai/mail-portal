import type { Context } from "hono";
import { z } from "zod";
import {
  hasLiveMailboxContentAccess,
  type MailboxContext,
} from "../lib/mailbox.ts";
import { actorFromSession } from "../lib/activity.ts";
import {
	LABEL_COLORS,
  validateLabelDefinition,
  validateLabelMutationTargets,
} from "../lib/labels.ts";
import {
  resourceCreateFingerprint,
  resourceCreateOperationKey,
} from "../lib/resource-create-idempotency.ts";
import { AutomationRuleError } from "../lib/automation-rules/index.ts";

type AppContext = Context<MailboxContext>;

type LabelCreateResult =
  | {
      status: "created" | "replayed";
      resource: {
        id: string;
        name: string;
        color: string;
        createdAt?: string;
        updatedAt?: string;
      };
    }
  | { status: "name_conflict" | "idempotency_conflict" }
  | {
      status: "creation_superseded" | "creation_unavailable";
      resourceId: string;
      currentRevision: string;
    };

const LabelBody = z.object({
	name: z.string(),
	color: z.enum(LABEL_COLORS),
});

const LabelCreateBody = LabelBody.extend({
  operationId: z.string().uuid(),
});

const LabelMutationBody = z.object({
	labelId: z.string().trim().min(1),
	action: z.enum(["apply", "remove"]),
	targets: z.array(z.object({
		emailId: z.string().trim().min(1),
		folderId: z.string().trim().min(1),
		conversationId: z.string().trim().min(1).optional(),
	})),
});

function labelError(c: AppContext, error: unknown) {
	if (
		(error instanceof AutomationRuleError && error.code === "RULE_TARGET_IN_USE") ||
		(error instanceof Error && error.name === "AutomationRuleError:RULE_TARGET_IN_USE")
	) {
		return c.json({ error: error.message, code: "RULE_TARGET_IN_USE" }, 409);
	}
	const message = error instanceof Error ? error.message : "Label operation failed";
	if (message.includes("UNIQUE constraint failed")) {
		return c.json({ error: "A label with that name already exists" }, 409);
	}
	return c.json({ error: message }, 400);
}

export async function handleListLabels(c: AppContext) {
	return c.json({ labels: await c.var.mailboxStub.listLabels() });
}

export type LabelCreateRouteDependencies = {
  revalidateAccess(c: AppContext): Promise<boolean>;
};

export function createLabelCreateHandler(
  dependencies: LabelCreateRouteDependencies,
) {
  return async (c: AppContext) => {
	const parsed = LabelCreateBody.safeParse(await c.req.json().catch(() => null),
    );
	if (!parsed.success) return c.json({ error: "Valid label name and color required" }, 400);
	try {
		const actor = actorFromSession(c.get("session"));
      const definition = validateLabelDefinition(
        parsed.data.name,
			parsed.data.color,
      );
      const [operationKey, fingerprint] = await Promise.all([
        resourceCreateOperationKey({
          kind: "label",
          mailboxId: c.var.authorizedMailboxId,
          actor,
          operationId: parsed.data.operationId,
        }),
        resourceCreateFingerprint({
          kind: "label",
          payload: [
            definition.name,
            definition.normalizedName,
            definition.color,
          ],
        }),
      ]);
      let authorized: boolean;
      try {
        authorized = await dependencies.revalidateAccess(c);
      } catch {
        return c.json({ error: "Mailbox authorization could not be confirmed." },
          503,
        );
	}
      if (!authorized) return c.json({ error: "Forbidden" }, 403);
      const stub = c.var.mailboxStub as unknown as {
        createMailboxResourceIdempotently(
          input: unknown,
        ): Promise<LabelCreateResult>;
      };
      const result = await stub.createMailboxResourceIdempotently({
        kind: "label",
        operationKey,
        fingerprint,
        resourceId: `label_${crypto.randomUUID()}`,
        name: definition.name,
        color: definition.color,
        actor,
      });
      if (result.status === "created") {
        return c.json({ label: result.resource, replayed: false }, 201);
      }
      if (result.status === "replayed") {
        return c.json({ label: result.resource, replayed: true }, 200);
      }
      if (result.status === "name_conflict") {
        return c.json({ error: "A label with that name already exists" }, 409);
      }
      const code =
        result.status === "idempotency_conflict"
          ? "create_idempotency_conflict"
          : result.status;
      const lifecycle = "resourceId" in result ? result : null;
      return c.json(
        {
          error:
            result.status === "idempotency_conflict"
              ? "This create retry no longer matches the original label"
              : result.status === "creation_superseded"
                ? "The label was created and later changed"
                : "The label was created and later deleted",
          code,
          ...(lifecycle
            ? {
                resourceId: lifecycle.resourceId,
                currentRevision: lifecycle.currentRevision,
              }
            : {}),
        },
        409,
      );
    } catch (error) {
      return labelError(c, error);
    }
  };
}

export const handleCreateLabel = createLabelCreateHandler({
  revalidateAccess: hasLiveMailboxContentAccess,
});

export async function handleUpdateLabel(c: AppContext) {
  const parsed = LabelBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Valid label name and color required" }, 400);
  try {
    const label = await c.var.mailboxStub.updateLabel(
      c.req.param("labelId")!,
      parsed.data.name,
      parsed.data.color,
      actorFromSession(c.get("session")),
    );
    return label
      ? c.json({ label })
      : c.json({ error: "Label not found" }, 404);
  } catch (error) {
    return labelError(c, error);
  }
}

export async function handleDeleteLabel(c: AppContext) {
  try {
    const names = await c.var.mailboxStub.getAutomationTargetUsage({
      labelId: c.req.param("labelId")!,
    });
    if (names.length > 0) {
      return c.json(
        {
          error: `Target is used by Automation ${names.length === 1 ? "Rule" : "Rules"}: ${names.join(", ")}`,
				code: "RULE_TARGET_IN_USE",
			}, 409);
		}
		const deleted = await c.var.mailboxStub.deleteLabel(
			c.req.param("labelId")!,
			actorFromSession(c.get("session")),
		);
		return deleted ? c.body(null, 204) : c.json({ error: "Label not found" }, 404);
	} catch (error) {
		return labelError(c, error);
	}
}

export async function handleMutateLabels(c: AppContext) {
	const parsed = LabelMutationBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid label mutation" }, 400);
	try {
		const targets = validateLabelMutationTargets(parsed.data.targets);
		const result = await c.var.mailboxStub.mutateLabels(
			{ ...parsed.data, targets },
			actorFromSession(c.get("session")),
		);
		if (result.status === "label_not_found") {
			return c.json({ error: "Label not found" }, 404);
		}
		return c.json(result);
	} catch (error) {
		return labelError(c, error);
	}
}
