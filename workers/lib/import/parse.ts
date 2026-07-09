// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Pure decisions for the one-time Zoho → portal mail importer (WISER-241). Kept
// separate from the store wiring so they're unit-testable via `node --test`:
//   - mapZohoFolder     — Zoho source folder → portal folder (drop Trash/Spam)
//   - normalizeEmailDate — original Date header → sortable ISO (epoch fallback)
//   - deriveImportId    — stable id for idempotent re-runs

// Type-only import (stripped at runtime) so this module stays resolvable by the
// `node --experimental-strip-types` test runner, which can't follow extensionless
// relative TS imports. The FolderId union still pins the returned literals to
// valid folder ids, so they can't drift from shared/folders.ts.
import type { FolderId } from "../../../shared/folders";

/** Zoho source folders we deliberately do NOT import. */
const DROP_FOLDERS = new Set(["trash", "deleted", "bin", "spam", "junk"]);

/**
 * Map a Zoho export folder name to a portal folder. Inbox→inbox, Sent→sent,
 * Trash/Spam (and common aliases) are dropped (null), and every other
 * meaningful folder — Archive, Drafts, custom labels — lands in Archive. The
 * ticket excludes only Trash and Spam, so nothing else is discarded.
 */
export function mapZohoFolder(sourceFolder: string): FolderId | null {
	const name = sourceFolder.trim().toLowerCase();
	if (DROP_FOLDERS.has(name)) return null;
	if (name === "inbox") return "inbox";
	if (name === "sent") return "sent";
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
export interface ImportIdParts {
	messageId?: string | null;
	from?: string | null;
	date?: string | null;
	subject?: string | null;
}

/**
 * Derive a deterministic internal id for an imported message so re-running the
 * import is idempotent: the endpoint skips any message whose id already exists,
 * and R2 attachment keys are built on this same id (re-runs overwrite in place
 * rather than duplicating). Keyed on the RFC `Message-ID` when present, else on
 * `from|date|subject`. SHA-256 → first 32 hex chars: stable, collision-safe for
 * a two-mailbox migration, and filesystem/URL-safe for R2 paths and deep links.
 */
export async function deriveImportId(parts: ImportIdParts): Promise<string> {
	const mid = parts.messageId?.trim();
	const key = mid
		? `msgid:${mid}`
		: `fallback:${parts.from ?? ""}|${parts.date ?? ""}|${parts.subject ?? ""}`;
	const bytes = new TextEncoder().encode(key);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, 32);
}
