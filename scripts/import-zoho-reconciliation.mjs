import { createHash } from "node:crypto";

export class ImportIdentityCollisionError extends Error {
	constructor(message = "Import identity evidence conflicted") {
		super(message);
		this.name = "ImportIdentityCollisionError";
		this.code = "IMPORT_IDENTITY_COLLISION";
	}
}

const PORTAL_IMPORT_ID = /^[0-9a-f]{32}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const DROP_FOLDERS = new Set(["trash", "deleted", "bin", "spam", "junk"]);

export function normalizeLocalZohoFolderPath(sourceFolder) {
	if (
		typeof sourceFolder !== "string" ||
		sourceFolder.length > 1_000 ||
		/[\u0000-\u001f\u007f]/.test(sourceFolder)
	) {
		throw new Error("Zoho source folder path is invalid");
	}
	const segments = sourceFolder
		.replaceAll("\\", "/")
		.split("/")
		.map((segment) => segment.trim());
	if (
		segments.length === 0 ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("Zoho source folder path is invalid");
	}
	return segments.join("/");
}

export function mapLocalZohoFolder(sourceFolder) {
	const segments = normalizeLocalZohoFolderPath(sourceFolder)
		.split("/")
		.map((segment) => segment.toLowerCase());
	if (segments.some((segment) => DROP_FOLDERS.has(segment))) return null;
	if (segments.length === 1 && segments[0] === "inbox") return "inbox";
	if (segments.length === 1 && segments[0] === "sent") return "sent";
	return "archive";
}

function normalizedMailbox(mailboxId) {
	const mailbox = typeof mailboxId === "string"
		? mailboxId.trim().toLowerCase()
		: "";
	if (!mailbox) throw new Error("Import mailbox identity is required");
	return mailbox;
}

function hashPortalIdentity(mailboxId, identityKey) {
	return createHash("sha256")
		.update(`mailbox:${normalizedMailbox(mailboxId)}\n${identityKey}`)
		.digest("hex")
		.slice(0, 32);
}

export function normalizeImportMessageId(raw) {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return null;
	return value.match(/<([^>]+)>/)?.[1] ?? value.split(/\s+/)[0] ?? null;
}

export function deriveRawImportPortalId(mailboxId, rawSha256) {
	const digest = typeof rawSha256 === "string"
		? rawSha256.trim().toLowerCase()
		: "";
	if (!RAW_SHA256.test(digest)) {
		throw new Error("Exact raw SHA-256 identity evidence is required");
	}
	return hashPortalIdentity(mailboxId, `raw-sha256:${digest}`);
}

export function deriveMessageIdImportPortalId(mailboxId, messageId) {
	const normalized = normalizeImportMessageId(messageId);
	if (!normalized) throw new Error("Message-ID identity evidence is required");
	return hashPortalIdentity(mailboxId, `msgid:${normalized}`);
}

export function localImportIdentity(mailboxId, rawSha256, parsedMessageId) {
	const normalizedMessageId = normalizeImportMessageId(parsedMessageId);
	if (normalizedMessageId) {
		return {
			identitySource: "message-id",
			portalId: deriveMessageIdImportPortalId(mailboxId, normalizedMessageId),
			rawSha256,
		};
	}
	return {
		identitySource: "raw-sha256",
		portalId: deriveRawImportPortalId(mailboxId, rawSha256),
		rawSha256,
	};
}

function isExactHttpContract(result) {
	if (result?.status === "imported") return result.httpStatus === 201;
	if (result?.status !== "skipped") return false;
	if (result.reason === "duplicate" || result.reason === "excluded-folder") {
		return result.httpStatus === 200;
	}
	if (result.reason === "in_progress" || result.reason === "identity_conflict") {
		return result.httpStatus === 409;
	}
	return false;
}

export class ImportReconciliation {
	#sourceTotal;
	#mailboxId;
	#resultTotal = 0;
	#imported = 0;
	#duplicate = 0;
	#excluded = 0;
	#error = 0;
	#identityCollisions = 0;

	constructor(sourceTotal, mailboxId) {
		if (!Number.isSafeInteger(sourceTotal) || sourceTotal < 0) {
			throw new Error("Import source count must be a non-negative integer");
		}
		this.#mailboxId = normalizedMailbox(mailboxId);
		this.#sourceTotal = sourceTotal;
	}

	record(identity, result, expectedFolder) {
		this.#resultTotal += 1;
		if (!isExactHttpContract(result)) {
			this.#error += 1;
			return;
		}
		if (result.status === "skipped" && result.reason === "excluded-folder") {
			if (expectedFolder !== null) {
				this.#error += 1;
				return;
			}
			this.#excluded += 1;
			return;
		}
		if (result.status === "skipped" && result.reason === "identity_conflict") {
			this.#error += 1;
			this.#identityCollisions += 1;
			throw new ImportIdentityCollisionError("Server rejected conflicting persistent import identity evidence");
		}
		if (result.status === "skipped" && result.reason === "in_progress") {
			this.#error += 1;
			return;
		}

		const isStoredOutcome =
			result.status === "imported" ||
			(result.status === "skipped" && result.reason === "duplicate");
		if (!isStoredOutcome) {
			this.#error += 1;
			return;
		}
		if (
			!(["inbox", "sent", "archive"].includes(expectedFolder)) ||
			result.folder !== expectedFolder
		) {
			this.#error += 1;
			throw new Error("Stored import result contradicted the local folder mapping");
		}
		if (
			!identity ||
			!["message-id", "raw-sha256"].includes(identity.identitySource) ||
			result.identitySource !== identity.identitySource ||
			typeof result.id !== "string" ||
			!PORTAL_IMPORT_ID.test(result.id) ||
			result.id !== identity.portalId
		) {
			this.#error += 1;
			throw new Error("Stored import result contradicted local exact identity evidence");
		}
		if (identity.identitySource === "raw-sha256") {
			if (
				!RAW_SHA256.test(identity.rawSha256) ||
				result.rawSha256 !== identity.rawSha256 ||
				result.id !== deriveRawImportPortalId(this.#mailboxId, identity.rawSha256)
			) {
				this.#error += 1;
				throw new Error("No-Message-ID result lacked persistent exact raw identity evidence");
			}
		}

		if (result.status === "imported") this.#imported += 1;
		else this.#duplicate += 1;
	}

	summary() {
		return {
			sourceTotal: this.#sourceTotal,
			resultTotal: this.#resultTotal,
			unprocessed: Math.max(0, this.#sourceTotal - this.#resultTotal),
			imported: this.#imported,
			duplicate: this.#duplicate,
			excluded: this.#excluded,
			error: this.#error,
			identityCollisions: this.#identityCollisions,
		};
	}
}
