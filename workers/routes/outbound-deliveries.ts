import type { Context } from "hono";
import { z } from "zod";
import { actorFromSession } from "../lib/activity.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

const RetryBody = z.object({
	acknowledgeDuplicateRisk: z.boolean().optional().default(false),
});

function deliveryError(c: AppContext, error: unknown) {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "OutboundDeliveryNotFoundError" || message.includes("was not found")) {
		return c.json({ error: "Outbound delivery not found" }, 404);
	}
	if (
		name === "DuplicateRiskAcknowledgementRequiredError" ||
		message.includes("duplicate-risk acknowledgement")
	) {
		return c.json(
			{
				error:
					"This delivery may already have been accepted. Confirm the duplicate-send risk before retrying.",
				code: "duplicate_risk_acknowledgement_required",
			},
			409,
		);
	}
	if (name === "InvalidDeliveryTransitionError" || message.startsWith("Cannot apply")) {
		return c.json({ error: message }, 409);
	}
	throw error;
}

export async function handleListOutboundDeliveries(c: AppContext) {
	const emailIds = (c.req.query("emailIds") ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.slice(0, 100);
	const threadIds = (c.req.query("threadIds") ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.slice(0, 100);
	const deliveries = threadIds.length
		? await c.var.mailboxStub.listOutboundDeliveryHighlights(emailIds, threadIds)
		: emailIds.length
			? await c.var.mailboxStub.listOutboundDeliveriesForEmailIds(emailIds)
		: await c.var.mailboxStub.listOutboundDeliveries();
	return c.json({ deliveries });
}

export async function handleGetOutboundDelivery(c: AppContext) {
	const delivery = await c.var.mailboxStub.getOutboundDelivery(
		c.req.param("deliveryId")!,
	);
	return delivery
		? c.json({ delivery })
		: c.json({ error: "Outbound delivery not found" }, 404);
}

export async function handleCancelOutboundDelivery(c: AppContext) {
	try {
		const result = await c.var.mailboxStub.cancelOutboundDelivery(
			c.req.param("deliveryId")!,
			actorFromSession(c.get("session")),
		);
		return c.json({
			delivery: result.delivery,
			...(result.recoveredDraftId
				? { recoveredDraftId: result.recoveredDraftId }
				: {}),
		});
	} catch (error) {
		return deliveryError(c, error);
	}
}

export async function handleRetryOutboundDelivery(c: AppContext) {
	const { acknowledgeDuplicateRisk } = RetryBody.parse(await c.req.json());
	try {
		const result = await c.var.mailboxStub.retryOutboundDelivery(
			c.req.param("deliveryId")!,
			actorFromSession(c.get("session")),
			acknowledgeDuplicateRisk,
		);
		return c.json({ delivery: result.delivery });
	} catch (error) {
		return deliveryError(c, error);
	}
}
