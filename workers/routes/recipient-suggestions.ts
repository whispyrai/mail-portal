import { Hono, type Context } from "hono";
import {
	RECIPIENT_MEMORY_LIMITS,
	type RecipientSuggestion,
} from "../../shared/recipient-suggestions.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";

export type RecipientSuggestionRouteContext = MailboxContext;

export interface RecipientSuggestionOperations {
	list(input: {
		mailboxAddress: string;
		query: string;
		limit: number;
		stub: unknown;
	}): Promise<RecipientSuggestion[]>;
}

interface RecipientSuggestionDependencies {
	operations(context: Context<RecipientSuggestionRouteContext>): RecipientSuggestionOperations;
}

function mailboxAddress(value: string): string | null {
	try {
		return normalizeMailAddress(decodeURIComponent(value));
	} catch {
		return null;
	}
}

function boundedLimit(value: string | null): number | null {
	if (value === null || value === "") return 10;
	if (!/^\d+$/.test(value)) return null;
	const limit = Number(value);
	return limit >= 1 && limit <= RECIPIENT_MEMORY_LIMITS.resultLimit
		? limit
		: null;
}

function projectSuggestion(
	suggestion: RecipientSuggestion,
): RecipientSuggestion {
	return {
		address: suggestion.address,
		sentCount: suggestion.sentCount,
		receivedCount: suggestion.receivedCount,
		lastSentAt: suggestion.lastSentAt,
		lastReceivedAt: suggestion.lastReceivedAt,
	};
}

export function createRecipientSuggestionRoutes(
	dependencies: RecipientSuggestionDependencies,
) {
	const routes = new Hono<RecipientSuggestionRouteContext>();
	routes.get(
		"/api/v1/mailboxes/:mailboxId/recipient-suggestions",
		async (c) => {
			if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
			const stub = c.var.mailboxStub;
			if (!stub) return c.json({ error: "Forbidden" }, 403);
			const mailbox = mailboxAddress(c.req.param("mailboxId") ?? "");
			if (!mailbox) return c.json({ error: "Mailbox address is invalid" }, 400);
			const query = (c.req.query("q") ?? "").trim().toLowerCase();
			if (query.length > RECIPIENT_MEMORY_LIMITS.queryChars) {
				return c.json({ error: "Recipient query is too long" }, 400);
			}
			const limit = boundedLimit(c.req.query("limit") ?? null);
			if (limit === null) {
				return c.json({ error: "Recipient result limit is invalid" }, 400);
			}
			const suggestions = await dependencies.operations(c).list({
				mailboxAddress: mailbox,
				query,
				limit,
				stub,
			});
			return c.json({ suggestions: suggestions.map(projectSuggestion) });
		},
	);
	return routes;
}

export const recipientSuggestionRoutes = createRecipientSuggestionRoutes({
	operations: () => ({
		list: async ({ mailboxAddress, query, limit, stub }) => {
			const mailbox = stub as {
				getRecipientSuggestions(
					mailboxAddress: string,
					query: string,
					limit: number,
				): Promise<RecipientSuggestion[]>;
			};
			return mailbox.getRecipientSuggestions(mailboxAddress, query, limit);
		},
	}),
});
