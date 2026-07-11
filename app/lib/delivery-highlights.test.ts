import assert from "node:assert/strict";
import test from "node:test";
import type { Email, OutboundDelivery } from "../types/index.ts";
import { indexDeliveryHighlights } from "./delivery-highlights.ts";

test("indexes an older bounced delivery under the thread's representative row", () => {
	const row = {
		id: "latest-sent",
		thread_id: "thread-1",
	} as Email;
	const bounce = {
		id: "delivery-old",
		emailId: "older-sent",
		threadId: "thread-1",
		status: "bounced",
	} as OutboundDelivery;

	const indexed = indexDeliveryHighlights([row], [bounce]);
	assert.equal(indexed.get("latest-sent"), bounce);
});

test("keeps the most actionable thread state regardless of response order", () => {
	const row = { id: "latest-sent", thread_id: "thread-1" } as Email;
	const bounce = {
		id: "delivery-old",
		emailId: "older-sent",
		threadId: "thread-1",
		status: "bounced",
	} as OutboundDelivery;
	const laterSent = {
		id: "delivery-new",
		emailId: "latest-sent",
		threadId: "thread-1",
		status: "sent",
	} as OutboundDelivery;

	assert.equal(indexDeliveryHighlights([row], [bounce, laterSent]).get(row.id), bounce);
});
