import { Hono } from "hono";
import {
	MAILBOX_SIGNATURE_LIMITS,
	type MailboxSignatureSettingsResponse,
} from "../../shared/mailbox-signature-settings.ts";
import type { SessionClaims } from "../lib/auth.ts";
import { mailboxAccess } from "../lib/mailbox-access.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";
import {
	InvalidMailboxSignatureError,
	normalizeEffectiveSignature,
	parseSignatureUpdate,
} from "../lib/mailbox-signature-settings.ts";
import {
	MailboxSettingsConflictError,
	MailboxSettingsNotFoundError,
	mergeSignatureMailboxSettings,
	updateMailboxSettings,
} from "../lib/mailbox-settings-store.ts";
import type { Env } from "../types.ts";

export type MailboxSignatureSettingsRouteContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

type SignatureAccess = { canRead: boolean; canManage: boolean };

export interface MailboxSignatureSettingsOperations {
	access(env: Env, userId: string, mailboxAddress: string): Promise<SignatureAccess>;
	read(env: Env, mailboxAddress: string): Promise<Record<string, unknown> | null>;
	updateSignature(
		env: Env,
		mailboxAddress: string,
		signature: ReturnType<typeof parseSignatureUpdate>,
	): Promise<Record<string, unknown>>;
}

export interface MailboxSignatureSettingsDependencies {
	operations: MailboxSignatureSettingsOperations;
}

const productionOperations: MailboxSignatureSettingsOperations = {
	async access(env, userId, mailboxAddress) {
		const access = mailboxAccess(env);
		const [canRead, canManage] = await Promise.all([
			access.canAccessMailbox(userId, mailboxAddress),
			access.canManageMailboxSettings(userId, mailboxAddress),
		]);
		return { canRead, canManage };
	},
	async read(env, mailboxAddress) {
		const object = await env.BUCKET.get(`mailboxes/${mailboxAddress}.json`);
		if (!object) return null;
		const value = await object.json();
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: {};
	},
	async updateSignature(env, mailboxAddress, signature) {
		return updateMailboxSettings(env.BUCKET, mailboxAddress, (current) =>
			mergeSignatureMailboxSettings(current, signature),
		);
	},
};

type SignatureRouteCode = "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "REQUEST_TOO_LARGE" | "SETTINGS_CONFLICT" | "SETTINGS_UNAVAILABLE";

class SignatureRouteError extends Error {
	readonly code: SignatureRouteCode;
	readonly status: 400 | 403 | 404 | 409 | 413 | 500;

	constructor(
		code: SignatureRouteCode,
		message: string,
		status: 400 | 403 | 404 | 409 | 413 | 500,
	) {
		super(message);
		this.name = "SignatureRouteError";
		this.code = code;
		this.status = status;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > MAILBOX_SIGNATURE_LIMITS.requestBytes) {
		throw new SignatureRouteError("REQUEST_TOO_LARGE", "Signature settings request is too large", 413);
	}
	if (!request.body) throw new InvalidMailboxSignatureError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAILBOX_SIGNATURE_LIMITS.requestBytes) {
				await reader.cancel().catch(() => undefined);
				throw new SignatureRouteError("REQUEST_TOO_LARGE", "Signature settings request is too large", 413);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new InvalidMailboxSignatureError();
	}
}

function mailboxAddress(raw: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new SignatureRouteError("INVALID", "Mailbox address is invalid", 400);
	}
	const address = normalizeMailAddress(decoded);
	if (!address) throw new SignatureRouteError("INVALID", "Mailbox address is invalid", 400);
	return address;
}

export function createMailboxSignatureSettingsRoutes(
	dependencies: MailboxSignatureSettingsDependencies = { operations: productionOperations },
) {
	const app = new Hono<MailboxSignatureSettingsRouteContext>();
	app.onError((error, c) => {
		if (error instanceof InvalidMailboxSignatureError) {
			return c.json({ error: error.message, code: "INVALID" }, 400);
		}
		if (error instanceof SignatureRouteError) {
			return c.json({ error: error.message, code: error.code }, error.status);
		}
		if (error instanceof MailboxSettingsNotFoundError) {
			return c.json({ error: error.message, code: "NOT_FOUND" }, 404);
		}
		if (error instanceof MailboxSettingsConflictError) {
			return c.json({ error: error.message, code: "SETTINGS_CONFLICT" }, 409);
		}
		return c.json({ error: "Mailbox settings are unavailable", code: "SETTINGS_UNAVAILABLE" }, 500);
	});
	app.use("/api/v1/mailboxes/:mailboxId/settings", async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/settings/signature", async (c, next) => {
		if (!c.get("session")) return c.json({ error: "Unauthorized" }, 401);
		await next();
	});

	app.get("/api/v1/mailboxes/:mailboxId/settings", async (c) => {
		const mailbox = mailboxAddress(c.req.param("mailboxId")!);
		const access = await dependencies.operations.access(c.env, c.get("session")!.sub, mailbox);
		if (!access.canRead && !access.canManage) {
			throw new SignatureRouteError("FORBIDDEN", "Mailbox settings are not available", 403);
		}
		const settings = await dependencies.operations.read(c.env, mailbox);
		if (!settings) throw new SignatureRouteError("NOT_FOUND", "Mailbox settings were not found", 404);
		const response: MailboxSignatureSettingsResponse = {
			signature: normalizeEffectiveSignature(settings.signature),
			canManage: access.canManage,
		};
		return c.json(response);
	});

	app.patch("/api/v1/mailboxes/:mailboxId/settings/signature", async (c) => {
		const mailbox = mailboxAddress(c.req.param("mailboxId")!);
		const access = await dependencies.operations.access(c.env, c.get("session")!.sub, mailbox);
		if (!access.canManage) {
			throw new SignatureRouteError("FORBIDDEN", "Signature settings cannot be changed", 403);
		}
		const signature = parseSignatureUpdate(await boundedJsonBody(c.req.raw));
		await dependencies.operations.updateSignature(c.env, mailbox, signature);
		const response: MailboxSignatureSettingsResponse = { signature, canManage: true };
		return c.json(response);
	});
	return app;
}

export const mailboxSignatureSettingsRoutes = createMailboxSignatureSettingsRoutes();
