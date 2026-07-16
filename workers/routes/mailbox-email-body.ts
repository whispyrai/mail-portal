import { Hono, type Context } from "hono";
import {
	hasLiveMailboxContentAccess,
	markMailboxReadAuthorizationFinalized,
	type MailboxContext,
} from "../lib/mailbox.ts";

type AppContext = Context<MailboxContext>;

type EmailBodySource =
	| { storage: "inline"; body: string }
	| {
			storage: "external";
			parts: Array<{
				contentType: "text/html" | "text/plain";
				partIndex: number;
				r2Key: string;
				byteLength: number;
			}>;
		  };

export type MailboxEmailBodyRouteDependencies = {
	source(c: AppContext, emailId: string): Promise<EmailBodySource | null>;
	bucket(c: AppContext): {
		get(key: string): Promise<{
			size: number;
			text(): Promise<string>;
		} | null>;
	};
	revalidateAccess(c: AppContext): Promise<boolean>;
};

type AccessDecision = "allowed" | "forbidden" | "unavailable";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function composeSelectedBody(
	parts: Array<{ contentType: "text/html" | "text/plain"; value: string }>,
): string {
	if (parts.some((part) => part.contentType === "text/html" && part.value.length > 0)) {
		return parts
			.map((part) =>
				part.contentType === "text/html"
					? part.value
					: `<pre>${escapeHtml(part.value)}</pre>`,
			)
			.join("<br/>\n");
	}
	return parts
		.filter((part) => part.contentType === "text/plain")
		.map((part) => part.value)
		.join("\n");
}

function bodyHeaders(): Headers {
	return new Headers({
		"Cache-Control": "private, no-store",
		"Content-Type": "text/plain; charset=utf-8",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	});
}

async function accessDecision(
	c: AppContext,
	dependencies: MailboxEmailBodyRouteDependencies,
): Promise<AccessDecision> {
	try {
		const decision = await dependencies.revalidateAccess(c)
			? "allowed"
			: "forbidden";
		markMailboxReadAuthorizationFinalized(c);
		return decision;
	} catch {
		markMailboxReadAuthorizationFinalized(c);
		return "unavailable";
	}
}

function unavailableBodyResponse(c: AppContext) {
	return c.json(
		{
			error: "Complete message body is temporarily unavailable",
			code: "BODY_OBJECT_UNAVAILABLE",
		},
		503,
	);
}

async function responseAfterBodyReadFailure(
	c: AppContext,
	dependencies: MailboxEmailBodyRouteDependencies,
) {
	const access = await accessDecision(c, dependencies);
	return access === "forbidden"
		? c.json({ error: "Forbidden" }, 403)
		: unavailableBodyResponse(c);
}

export function createMailboxEmailBodyRoutes(
	dependencies: MailboxEmailBodyRouteDependencies,
) {
	const routes = new Hono<MailboxContext>();
	routes.get(
		"/api/v1/mailboxes/:mailboxId/emails/:emailId/body",
		async (c: AppContext) => {
			const emailId = c.req.param("emailId") ?? "";
			if (!emailId || emailId.length > 300)
				return c.json({ error: "Email not found" }, 404);
			const source = await dependencies.source(c, emailId);
			if (!source) return c.json({ error: "Email not found" }, 404);

			let body: string;
			if (source.storage === "inline") {
				body = source.body;
			} else {
				const parts: Array<{
					contentType: "text/html" | "text/plain";
					value: string;
				}> = [];
				for (const part of [...source.parts].sort(
					(left, right) => left.partIndex - right.partIndex,
				)) {
					try {
						const object = await dependencies.bucket(c).get(part.r2Key);
						if (!object || object.size !== part.byteLength) {
							return responseAfterBodyReadFailure(c, dependencies);
						}
						parts.push({
							contentType: part.contentType,
							value: await object.text(),
						});
					} catch {
						return responseAfterBodyReadFailure(c, dependencies);
					}
				}
				body = composeSelectedBody(parts);
			}

			const finalAccess = await accessDecision(c, dependencies);
			if (finalAccess === "forbidden") return c.json({ error: "Forbidden" }, 403);
			if (finalAccess === "unavailable") return unavailableBodyResponse(c);
			return new Response(body, { headers: bodyHeaders() });
		},
	);
	return routes;
}

export const mailboxEmailBodyRoutes = createMailboxEmailBodyRoutes({
	source: (c, emailId) =>
		c.var.mailboxStub.getEmailBodySource(emailId) as Promise<EmailBodySource | null>,
	bucket: (c) => ({
		get: (key) => c.env.BUCKET.get(key),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
