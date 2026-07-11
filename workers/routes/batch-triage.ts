import type { Context } from "hono";
import { z } from "zod";
import {
	MAX_BATCH_TRIAGE_TARGETS,
	type BatchTriageCommand,
} from "../../shared/batch-triage.ts";
import { actorFromSession } from "../lib/activity.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

const BatchTriageBody = z
	.object({
		action: z.enum(["mark_read", "mark_unread", "archive", "trash"]),
		targets: z
			.array(
				z.object({
					emailId: z.string().trim().min(1).max(300),
					folderId: z.string().trim().min(1).max(200),
					conversationId: z.string().trim().min(1).max(300).optional(),
				}),
			)
			.min(1)
			.max(MAX_BATCH_TRIAGE_TARGETS),
	})
	.superRefine((body, context) => {
		const seen = new Set<string>();
		for (const target of body.targets) {
			if (seen.has(target.emailId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Duplicate email targets are not allowed",
					path: ["targets"],
				});
				return;
			}
			seen.add(target.emailId);
		}
	});

export async function handleBatchTriage(c: AppContext) {
	const parsed = BatchTriageBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: "A valid bounded batch action and unique targets are required" }, 400);
	}
	const result = await c.var.mailboxStub.batchTriage(
		parsed.data satisfies BatchTriageCommand,
		actorFromSession(c.get("session")),
	);
	return c.json(result);
}
