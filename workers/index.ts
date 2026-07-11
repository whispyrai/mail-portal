// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import {
	resolveAndPromoteAttachments,
	uploadKey,
	sanitizeFilename,
	attachmentKey,
} from "./lib/attachments";
import {
	ATTACHMENT_LIMITS,
	validateSingleFile,
	isBlockedAttachment,
	attachmentExtension,
} from "../shared/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	buildThreadToken,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema, AttachmentRefSchema, PushSubscriptionSchema } from "./lib/schemas";
import { buildDeviceLabel } from "./lib/push/deviceLabel";
import { vapidConfig } from "./lib/push/transport";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { draftReplyForEmail, draftNewEmail } from "./lib/agent-context";
import { systemPromptFor } from "./lib/prompts";
import { pwaManifestFor, resolveBrand } from "./routes/brand";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import {
	isAddressInConfiguredMailDomains,
	normalizeMailAddress,
} from "./lib/mail-address";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
	attachments: z.array(AttachmentRefSchema).max(ATTACHMENT_LIMITS.maxFiles).optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
app.use("/api/v1/mailboxes/:mailboxId", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	// The VAPID public key drives the client's push subscribe + shows/hides the
	// enable-notifications UI. null when push isn't configured for this env.
	return c.json({
		domains,
		emailAddresses,
		vapidPublicKey: vapidConfig(c.env)?.publicKey ?? null,
	});
});

// PWA manifest, brand-parameterized (WISER-240). Public (no session): the
// browser fetches it uncredentialed. Ends in a file extension so the auth gate
// treats it as a static path.
app.get("/manifest.webmanifest", (c: AppContext) => {
	const manifest = pwaManifestFor(resolveBrand(c.env.BRAND));
	return new Response(JSON.stringify(manifest), {
		headers: { "Content-Type": "application/manifest+json" },
	});
});

// Who am I — drives the SPA header (account, admin link, sign out).
app.get("/api/v1/me", (c: AppContext) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	return c.json({
		email: session.email,
		role: session.role,
		mailbox: session.mailbox,
	});
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c: AppContext) => {
	const session = c.get("session");
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	// Reps see only their own mailbox; admins see all.
	const visible =
		session && session.role !== "ADMIN"
			? allMailboxes.filter(
					(m) => m.id.toLowerCase() === session.mailbox.toLowerCase(),
				)
			: allMailboxes;
	return c.json(visible.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c: AppContext) => {
	const session = c.get("session");
	if (!session || session.role !== "ADMIN") {
		return c.json({ error: "Forbidden" }, 403);
	}
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = normalizeMailAddress(rawEmail);
	if (!email || !isAddressInConfiguredMailDomains(email, c.env.DOMAINS)) {
		return c.json({ error: "Mailbox must use a configured mail domain" }, 403);
	}
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" }, agentSystemPrompt: systemPromptFor(resolveBrand(c.env.BRAND).id) };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c: AppContext) => {
	const session = c.get("session");
	if (!session || session.role !== "ADMIN") {
		return c.json({ error: "Forbidden" }, 403);
	}
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const storedThreadId = thread_id || in_reply_to || messageId;
	const threadToken = buildThreadToken(storedThreadId, fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET, stub, mailboxId, messageId, attachments,
	).then(
		(r) => ({ ok: true as const, ...r }),
		(e) => ({ ok: false as const, error: (e as Error).message }),
	);
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);
	const { sesAttachments, storedMetadata } = resolved;

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: storedThreadId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, storedMetadata);

	c.executionCtx.waitUntil(
		sendEmail(c.env, {
			to, cc, bcc, from, subject, html, text,
			attachments: sesAttachments,
			headers: buildThreadingHeaders(in_reply_to || null, references || [], threadToken),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, attachments } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	// Reuse the draft id on overwrite. This keeps the draft's attachments under a
	// stable key so `existing` references survive repeated saves (and avoids the
	// orphan-draft rows the previous new-id-per-save approach accumulated).
	const messageId = draft_id || crypto.randomUUID();

	// Promote attachments to the (re)new draft FIRST: `existing` refs may still
	// point at the draft we're about to overwrite, which must exist to resolve them.
	const resolved = await resolveAndPromoteAttachments(
		c.env.BUCKET, stub, mailboxId, messageId, attachments,
	).then(
		(r) => ({ ok: true as const, ...r }),
		(e) => ({ ok: false as const, error: (e as Error).message }),
	);
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);

	// Drop the previous draft row + its now-orphaned R2 objects. The cascade
	// clears old attachment rows; we just-promoted copies live under fresh ids.
	if (draft_id) {
		const old = await stub.deleteEmail(draft_id);
		if (old && old.length > 0) {
			await c.env.BUCKET.delete(old.map((a) => attachmentKey(draft_id, a.id, a.filename)));
		}
	}

	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, resolved.storedMetadata);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- AI reply draft (one-shot, manually invoked from the thread view) -----
app.post("/api/v1/mailboxes/:mailboxId/ai-draft", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { emailId } = (await c.req.json()) as { emailId?: string };
	if (!emailId) return c.json({ error: "emailId is required" }, 400);
	try {
		const draft = await draftReplyForEmail(c.env, mailboxId, emailId);
		return c.json(draft);
	} catch (e) {
		return c.json({ error: (e as Error).message || "AI draft failed" }, 502);
	}
});

// -- AI compose draft (one-shot, for brand-new outbound emails) -----------
app.post("/api/v1/mailboxes/:mailboxId/ai-compose", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { prompt } = (await c.req.json()) as { prompt?: string };
	if (!prompt?.trim()) return c.json({ error: "prompt is required" }, 400);
	try {
		const draft = await draftNewEmail(c.env, mailboxId, prompt.trim());
		return c.json(draft);
	} catch (e) {
		return c.json({ error: (e as Error).message || "AI compose failed" }, 502);
	}
});

// -- Bulk send (mail merge, F-06) -----------------------------------

const BulkSendBody = z.object({
	subject: z.string().min(1),
	html: z.string().optional(),
	text: z.string().optional(),
	recipients: z.array(z.record(z.string())).min(1).max(200),
	// Optional shared attachment(s), uploaded once and attached to every recipient.
	attachmentUploadIds: z.array(z.string().min(1)).max(ATTACHMENT_LIMITS.maxFiles).optional(),
});

app.post("/api/v1/mailboxes/:mailboxId/bulk", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	let body: z.infer<typeof BulkSendBody>;
	try {
		body = BulkSendBody.parse(await c.req.json());
	} catch (e) {
		return c.json({ error: `Invalid bulk request: ${(e as Error).message}` }, 400);
	}
	if (!body.html && !body.text) {
		return c.json({ error: "Provide an HTML or text body." }, 400);
	}
	// From-name comes from the mailbox settings; the from-address is the mailbox.
	const settingsObj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	const settings = settingsObj
		? await settingsObj.json<{ fromName?: string }>()
		: {};
	const fromName = settings.fromName || mailboxId.split("@")[0];
	try {
		const result = await c.var.mailboxStub.enqueueBulkJob({
			fromEmail: mailboxId,
			fromName,
			subject: body.subject,
			html: body.html,
			text: body.text,
			recipients: body.recipients,
			attachmentUploadIds: body.attachmentUploadIds,
		});
		return c.json(result, 202);
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.get("/api/v1/mailboxes/:mailboxId/bulk/:jobId", async (c: AppContext) => {
	const job = await c.var.mailboxStub.getBulkJob(c.req.param("jobId")!);
	return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
});

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Push subscriptions (WISER-240) ---------------------------------
// Per-device Web Push subscriptions, scoped to the mailbox by requireMailbox
// (an AGENT manages only their own; an admin any — the natural home for role
// inboxes like hello@/contact@). The list never exposes endpoint or keys.

app.post("/api/v1/mailboxes/:mailboxId/push-subscriptions", async (c: AppContext) => {
	const parsed = PushSubscriptionSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: `Invalid subscription: ${parsed.error.message}` }, 400);
	}
	const body = parsed.data;
	// Derive the device label server-side from the request UA — never trusted from the body.
	const userAgent = c.req.header("user-agent") ?? null;
	const result = await c.var.mailboxStub.upsertPushSubscription({
		endpoint: body.endpoint,
		p256dh: body.keys.p256dh,
		auth: body.keys.auth,
		userAgent,
		deviceLabel: buildDeviceLabel(userAgent),
	});
	return c.json(result, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/push-subscriptions", async (c: AppContext) => {
	return c.json({ subscriptions: await c.var.mailboxStub.listPushSubscriptionDevices() });
});

app.delete("/api/v1/mailboxes/:mailboxId/push-subscriptions/:id", async (c: AppContext) => {
	const subscriptionId = c.req.param("id");
	if (!subscriptionId) return c.json({ error: "Subscription id is required" }, 400);
	const ok = await c.var.mailboxStub.deletePushSubscription(subscriptionId);
	return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

// Upload a file to R2 staging (upload-first model). Returns an `uploadId` the
// client carries as a reference into send/reply/forward/draft/bulk. The raw
// file is the request body; filename + type ride in query params. Behind
// `requireMailbox`, so the upload is scoped to the caller's own mailbox.
app.post("/api/v1/mailboxes/:mailboxId/attachments", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const filename = (c.req.query("filename") || "untitled").slice(0, 255);
	const type = (c.req.query("type") || "application/octet-stream").slice(0, 78);

	if (isBlockedAttachment(filename)) {
		return c.json({ error: `.${attachmentExtension(filename) || "this"} files can't be emailed.` }, 400);
	}
	// Reject oversize before buffering the whole body into memory.
	const declared = Number(c.req.header("content-length"));
	if (Number.isFinite(declared) && declared > ATTACHMENT_LIMITS.maxFileBytes) {
		return c.json({ error: `File is over the ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MB per-file limit.` }, 413);
	}

	const buf = await c.req.arrayBuffer();
	const sizeError = validateSingleFile({ filename, size: buf.byteLength });
	if (sizeError) return c.json({ error: sizeError }, 400);

	const uploadId = crypto.randomUUID();
	const safe = sanitizeFilename(filename);
	await c.env.BUCKET.put(uploadKey(mailboxId, uploadId), buf, {
		httpMetadata: { contentType: type },
		customMetadata: { filename: safe, type, size: String(buf.byteLength) },
	});
	return c.json({ uploadId, filename: safe, mimetype: type, size: buf.byteLength }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

export { app };
