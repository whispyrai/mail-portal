import { Hono } from "hono";
import { parseMessageViewerReport } from "../../shared/message-viewer-diagnostics.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

// A report is a few hundred bytes; anything larger is not one of ours.
const MAX_REPORT_BYTES = 4_096;

/**
 * Writes one structured log line per message render so a body that stays blank
 * on one laptop can be found in Workers Logs, with who, which build and which
 * browser. The mailbox middleware has already authorized the reader.
 */
export const messageViewerDiagnosticsRoutes = new Hono<MailboxContext>();

messageViewerDiagnosticsRoutes.post(
	"/api/v1/mailboxes/:mailboxId/message-viewer-reports",
	async (c) => {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		const raw = await c.req.text();
		if (raw.length > MAX_REPORT_BYTES) {
			return c.json({ error: "Report too large" }, 413);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return c.json({ error: "Invalid report" }, 400);
		}
		const report = parseMessageViewerReport(parsed);
		if (!report) return c.json({ error: "Invalid report" }, 400);

		const entry = {
			operation: "message_viewer_report",
			mailboxId: c.get("authorizedMailboxId"),
			userId: session.sub,
			userEmail: session.email,
			userAgent: c.req.header("User-Agent")?.slice(0, 400) ?? null,
			...report,
		};
		// Static messages per outcome keep the Worker log contract (every console
		// message is a literal) and let a failure be filtered at warning level.
		if (report.outcome === "rendered") {
			console.log("[message-viewer] rendered", entry);
		} else if (report.outcome === "blank") {
			console.warn("[message-viewer] blank", entry);
		} else {
			console.warn("[message-viewer] never_reported", entry);
		}
		return c.body(null, 204);
	},
);
