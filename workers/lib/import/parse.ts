// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Pure decisions for the one-time Zoho → portal mail importer (WISER-241). Kept
// separate from the store wiring so they're unit-testable via `node --test`:
//   - mapZohoFolder     — Zoho source folder → portal folder (drop Trash/Spam)
//   - normalizeEmailDate — original Date header → sortable ISO (epoch fallback)
//   - deriveImportId    — stable id for idempotent re-runs
//   - deriveImportThreadId — stable thread id from RFC reply headers

// Type-only import (stripped at runtime) so this module stays resolvable by the
// `node --experimental-strip-types` test runner, which can't follow extensionless
// relative TS imports. The FolderId union still pins the returned literals to
// valid folder ids, so they can't drift from shared/folders.ts.
import type { FolderId } from "../../../shared/folders";

/** Zoho source folders we deliberately do NOT import. */
const DROP_FOLDERS = new Set(["trash", "deleted", "bin", "spam", "junk"]);

/** Normalize the complete relative folder path supplied by the import driver. */
export function normalizeZohoFolderPath(sourceFolder: string): string {
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

/**
 * Map a Zoho export folder name to a portal folder. Inbox→inbox, Sent→sent,
 * Trash/Spam (and common aliases) are dropped (null), and every other
 * meaningful folder — Archive, Drafts, custom labels — lands in Archive. The
 * ticket excludes only Trash and Spam, so nothing else is discarded.
 */
export function mapZohoFolder(sourceFolder: string): FolderId | null {
	const segments = normalizeZohoFolderPath(sourceFolder)
		.split("/")
		.map((segment) => segment.toLowerCase());
	if (segments.some((segment) => DROP_FOLDERS.has(segment))) return null;
	if (segments.length === 1 && segments[0] === "inbox") return "inbox";
	if (segments.length === 1 && segments[0] === "sent") return "sent";
	return "archive";
}

/**
 * Normalize a raw email `Date` header to a sortable ISO string so imported
 * history orders correctly. An empty or unparseable date falls back to the
 * epoch — it sorts as the oldest, never masquerading as a fresh arrival.
 */
export function normalizeEmailDate(raw: string | null | undefined): string {
	if (!raw) return new Date(0).toISOString();
	const d = new Date(raw);
	return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Fields used to derive a stable id when a Message-ID is present or not. */
type ImportIdParts = {
	messageId?: string | null;
	rawSha256?: string | null;
};

type ImportThreadParts = ImportIdParts & {
	inReplyTo?: string | null;
	references?: string | null;
};

function normalizeMessageId(raw: string | null | undefined): string | null {
	const value = raw?.trim();
	if (!value) return null;
	return value.match(/<([^>]+)>/)?.[1] ?? value.split(/\s+/)[0] ?? null;
}

async function deriveImportHash(key: string): Promise<string> {
	const bytes = new TextEncoder().encode(key);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, 32);
}

/** Hash the exact uploaded RFC822 bytes before any parser normalization. */
export async function sha256RawEmail(raw: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", raw);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function importMessageKey(parts: ImportIdParts): string {
	const mid = normalizeMessageId(parts.messageId);
	if (mid) return `msgid:${mid}`;
	const rawSha256 = parts.rawSha256?.trim().toLowerCase();
	if (!rawSha256 || !/^[0-9a-f]{64}$/.test(rawSha256)) {
		throw new Error("A valid raw SHA-256 is required when Message-ID is absent");
	}
	return `raw-sha256:${rawSha256}`;
}

/** The pre-mailbox-scope identity, retained only as a read-compatibility bridge. */
export function deriveLegacyImportId(parts: ImportIdParts): Promise<string> {
	return deriveImportHash(importMessageKey(parts));
}

/**
 * Derive a deterministic internal id for an imported message so re-running the
 * import is idempotent: the endpoint skips any message whose id already exists.
 * Attachments add a claim-generation fence beneath this mailbox-scoped message
 * identity so a failed or expired writer cannot collide with its successor.
 * The message identity is keyed on the RFC `Message-ID` when present, preserving
 * its existing 32-hex contract. Without one, it is keyed on the exact raw
 * RFC822 SHA-256 while preserving the same 32-hex storage contract. Both are
 * stable and safe for R2 paths, promotion intents, and deep links.
 */
export async function deriveImportId(
	parts: ImportIdParts,
	mailboxId: string,
): Promise<string> {
	const mailbox = mailboxId.trim().toLowerCase();
	if (!mailbox) throw new Error("Target mailbox identity is required for import");
	return deriveImportHash(
		`mailbox:${mailbox}\n${importMessageKey(parts)}`,
	);
}

/**
 * Resolve every imported conversation to the same deterministic internal
 * thread id. RFC References lists the root first, so it wins over the direct
 * parent in In-Reply-To and makes grouping independent of import order.
 */
export async function deriveImportThreadId(
	parts: ImportThreadParts,
	mailboxId: string,
): Promise<string> {
	const rootMessageId =
		normalizeMessageId(parts.references) ??
		normalizeMessageId(parts.inReplyTo) ??
		normalizeMessageId(parts.messageId);

	return deriveImportId({ ...parts, messageId: rootMessageId }, mailboxId);
}

export function deriveLegacyImportThreadId(
	parts: ImportThreadParts,
): Promise<string> {
	const rootMessageId =
		normalizeMessageId(parts.references) ??
		normalizeMessageId(parts.inReplyTo) ??
		normalizeMessageId(parts.messageId);
	return deriveLegacyImportId({ ...parts, messageId: rootMessageId });
}
