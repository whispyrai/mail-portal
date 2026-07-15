import type { Context } from "hono";
import { z } from "zod";
import {
  hasLiveMailboxContentAccess,
  type MailboxContext,
} from "../lib/mailbox.ts";
import { actorFromSession } from "../lib/activity.ts";
import { AutomationRuleError } from "../lib/automation-rules/index.ts";
import {
  resourceCreateFingerprint,
  resourceCreateOperationKey,
} from "../lib/resource-create-idempotency.ts";

type AppContext = Context<MailboxContext>;
type FolderCreateResult =
  | {
      status: "created" | "replayed";
      resource: { id: string; name: string; unreadCount: number };
    }
  | { status: "name_conflict" | "idempotency_conflict" }
  | {
      status: "creation_superseded" | "creation_unavailable";
      resourceId: string;
      currentRevision: string;
    };

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export type FolderCreateRouteDependencies = {
  revalidateAccess(c: AppContext): Promise<boolean>;
};

export function createFolderCreateHandler(
  dependencies: FolderCreateRouteDependencies,
) {
  return async (c: AppContext) => {
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .transform((value) => value.replace(/\s+/g, " ")),
        operationId: z.string().uuid(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Valid folder name and operation ID required" },
        400,
      );
    const { name, operationId } = parsed.data;
    const resourceId = slugify(name);
    if (!resourceId) {
      return c.json(
        { error: "Folder name must contain alphanumeric characters" },
        400,
      );
    }
    const actor = actorFromSession(c.get("session"));
    const [operationKey, fingerprint] = await Promise.all([
      resourceCreateOperationKey({
        kind: "folder",
        mailboxId: c.var.authorizedMailboxId,
        actor,
        operationId,
      }),
      resourceCreateFingerprint({
        kind: "folder",
        payload: [resourceId, name],
      }),
    ]);
    let authorized: boolean;
    try {
      authorized = await dependencies.revalidateAccess(c);
    } catch {
      return c.json(
        { error: "Mailbox authorization could not be confirmed." },
        503,
      );
    }
    if (!authorized) return c.json({ error: "Forbidden" }, 403);
    const stub = c.var.mailboxStub as unknown as {
      createMailboxResourceIdempotently(
        input: unknown,
      ): Promise<FolderCreateResult>;
    };
    const result = await stub.createMailboxResourceIdempotently({
      kind: "folder",
      operationKey,
      fingerprint,
      resourceId,
      name,
      actor,
    });
    if (result.status === "created")
      return c.json({ ...result.resource, replayed: false }, 201);
    if (result.status === "replayed")
      return c.json({ ...result.resource, replayed: true }, 200);
    if (result.status === "name_conflict") {
      return c.json({ error: "Folder with this name already exists" }, 409);
    }
    const lifecycle = "resourceId" in result ? result : null;
    return c.json(
      {
        error:
          result.status === "idempotency_conflict"
            ? "This create retry no longer matches the original folder"
            : result.status === "creation_superseded"
              ? "The folder was created and later changed"
              : "The folder was created and later deleted",
        code:
          result.status === "idempotency_conflict"
            ? "create_idempotency_conflict"
            : result.status,
        ...(lifecycle
          ? {
              resourceId: lifecycle.resourceId,
              currentRevision: lifecycle.currentRevision,
            }
          : {}),
      },
      409,
    );
  };
}

export const handleCreateFolder = createFolderCreateHandler({
  revalidateAccess: hasLiveMailboxContentAccess,
});

export async function handleDeleteFolder(c: AppContext) {
	let result;
	try {
		const names = await c.var.mailboxStub.getAutomationTargetUsage({
			folderId: c.req.param("id")!,
		});
		if (names.length > 0) {
			return c.json({
				error: `Target is used by Automation ${names.length === 1 ? "Rule" : "Rules"}: ${names.join(", ")}`,
				code: "RULE_TARGET_IN_USE",
			}, 409);
		}
		result = await c.var.mailboxStub.deleteFolder(
			c.req.param("id")!,
			actorFromSession(c.get("session")),
		);
	} catch (error) {
		if (
			(error instanceof AutomationRuleError && error.code === "RULE_TARGET_IN_USE") ||
			(error instanceof Error && error.name === "AutomationRuleError:RULE_TARGET_IN_USE")
		) {
			return c.json({ error: error.message, code: "RULE_TARGET_IN_USE" }, 409);
		}
		throw error;
	}
	if (result === "deleted") return c.body(null, 204);
	if (result === "not_empty") {
		return c.json(
			{ error: "Move or delete all emails before deleting this folder" },
			409,
		);
	}
	if (result === "protected") {
		return c.json({ error: "System folders cannot be deleted" }, 403);
	}
	return c.json({ error: "Folder not found" }, 404);
}
