// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { RecipientMemoryOrigin } from "../../shared/recipient-suggestions.ts";
import type { StoredAttachment } from "./attachments.ts";
import type { InboundDerivedContentCleanupCandidate } from "./inbound-derived-content-cleanup.ts";
import type { PushPayload } from "./push/types.ts";

export const MAX_INBOUND_EMAIL_BYTES = 25 * 1024 * 1024;

export type InboundStoredEmail = {
	id: string;
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	read?: boolean;
	body: string;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string;
	message_id: string | null;
	raw_headers: string;
	recipient_memory_origin: RecipientMemoryOrigin;
	snooze_wake_thread_id: string | null;
	follow_up_reply_mailbox_address: string | null;
	automation_trigger: "live_inbound";
	push_notification: PushPayload;
};

export type StoredEmailBodyObject = {
	id: string;
	email_id: string;
	part_index: number;
	content_type: "text/html" | "text/plain";
	charset: string;
	r2_key: string;
	byte_length: number;
};

export type InboundProjectionCommand = {
	folder: string;
	email: InboundStoredEmail;
	attachments: StoredAttachment[];
	bodyObjects: StoredEmailBodyObject[];
	mailboxAddress: string;
	allowTerminalRecovery: boolean;
	projectionAttemptId?: string;
	derivedContentProof?: InboundDerivedContentCleanupCandidate[];
};

export type InboundProjectionResult = {
	status:
		| "cleanup_conflict"
		| "deleted"
		| "duplicate"
		| "stored"
		| "terminal";
	cleanupKeys?: string[];
};

export type InboundDerivedContentManifest =
	| { status: "deleted" | "missing" | "not_live_inbound" }
	| {
			status: "live_inbound";
			generation: number;
			lastRepairMarkerId: string | null;
			attachments: Array<{
				id: string;
				r2Key: string;
				byteLength: number;
			}>;
			bodyObjects: Array<{
				id: string;
				r2Key: string;
				byteLength: number;
			}>;
	  };

const MAX_INBOUND_DERIVED_MANIFEST_OBJECTS = 512;
const MAX_INBOUND_DERIVED_ID_LENGTH = 300;
const MAX_INBOUND_DERIVED_KEY_LENGTH = 1024;
// This operational ceiling keeps a corrupted RPC value out of durable keys and
// telemetry while leaving room for far more repairs than one message can reach.
export const MAX_INBOUND_DERIVED_GENERATION = 1_000_000;

function isExactRecord(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"),
	);
}

function projectManifestObjects(
	value: unknown,
	namespace: string,
): Array<{ id: string; r2Key: string; byteLength: number }> | null {
	if (!Array.isArray(value) || value.length > MAX_INBOUND_DERIVED_MANIFEST_OBJECTS) {
		return null;
	}
	const projected: Array<{ id: string; r2Key: string; byteLength: number }> = [];
	const keys = new Set<string>();
	for (const item of value) {
		if (!isExactRecord(item, ["byteLength", "id", "r2Key"])) return null;
		if (
			typeof item.id !== "string" ||
			!/^[A-Za-z0-9_-]{1,300}$/.test(item.id) ||
			typeof item.r2Key !== "string" ||
			!item.r2Key.startsWith(namespace) ||
			item.r2Key.length > MAX_INBOUND_DERIVED_KEY_LENGTH ||
			!Number.isSafeInteger(item.byteLength) ||
			(item.byteLength as number) < 0 ||
			(item.byteLength as number) > MAX_INBOUND_EMAIL_BYTES ||
			keys.has(item.r2Key)
		) {
			return null;
		}
		keys.add(item.r2Key);
		projected.push({
			id: item.id,
			r2Key: item.r2Key,
			byteLength: item.byteLength as number,
		});
	}
	return projected;
}

export function projectInboundDerivedContentManifest(
	value: unknown,
	expectedEmailId: string,
): InboundDerivedContentManifest | null {
	if (
		expectedEmailId.length === 0 ||
		expectedEmailId.length > MAX_INBOUND_DERIVED_ID_LENGTH ||
		!/^[A-Za-z0-9_-]+$/.test(expectedEmailId)
	) {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const status = (value as Record<string, unknown>).status;
	if (
		status === "deleted" ||
		status === "missing" ||
		status === "not_live_inbound"
	) {
		return isExactRecord(value, ["status"]) ? { status } : null;
	}
	if (
		status !== "live_inbound" ||
		!isExactRecord(value, [
			"attachments",
			"bodyObjects",
			"generation",
			"lastRepairMarkerId",
			"status",
		])
	) {
		return null;
	}
	if (
		!Number.isSafeInteger(value.generation) ||
		(value.generation as number) < 1 ||
		(value.generation as number) > MAX_INBOUND_DERIVED_GENERATION ||
		(value.lastRepairMarkerId !== null &&
			(typeof value.lastRepairMarkerId !== "string" ||
				!/^[a-zA-Z0-9_-]{8,100}$/.test(value.lastRepairMarkerId)))
	) {
		return null;
	}
	const attachments = projectManifestObjects(
		value.attachments,
		`attachments/${expectedEmailId}/`,
	);
	const bodyObjects = projectManifestObjects(
		value.bodyObjects,
		`email-bodies/${expectedEmailId}/`,
	);
	const objectCount =
		(attachments?.length ?? 0) + (bodyObjects?.length ?? 0);
	if (
		!attachments ||
		!bodyObjects ||
		objectCount > MAX_INBOUND_DERIVED_MANIFEST_OBJECTS ||
		new Set([
			...attachments.map(({ id }) => id),
			...bodyObjects.map(({ id }) => id),
		]).size !== objectCount ||
		new Set([
			...attachments.map(({ r2Key }) => r2Key),
			...bodyObjects.map(({ r2Key }) => r2Key),
		]).size !== objectCount
	) {
		return null;
	}
	return {
		status,
		generation: value.generation as number,
		lastRepairMarkerId: value.lastRepairMarkerId as string | null,
		attachments,
		bodyObjects,
	};
}

export type InboundDerivedContentRepairCommand = {
	attemptId: string;
	commandFingerprint: string;
	emailId: string;
	expectedGeneration: number;
	markerId: string;
	body: string;
	attachments: StoredAttachment[];
	bodyObjects: StoredEmailBodyObject[];
};

export type InboundDerivedContentRepairAttemptIdentity = {
	attemptId: string;
	emailId: string;
	expectedGeneration: number;
	markerId: string;
	commandFingerprint: string;
	proof: {
		attachments: Array<{ r2Key: string; byteLength: number }>;
		bodyObjects: Array<{ r2Key: string; byteLength: number }>;
	};
};

export type InboundDerivedContentRepairAttemptOutcome =
	| "abandoned"
	| "committed"
	| "rejected";

export type InboundDerivedContentRepairAttemptTerminal =
	| { outcome: "abandoned" | "rejected" }
	| { outcome: "committed"; generation: number };

export type InboundDerivedContentRepairResult = {
	status:
			| "already_repaired"
			| "cleanup_conflict"
		| "deleted"
		| "missing"
		| "not_live_inbound"
		| "repaired"
		| "stale_marker";
	generation?: number;
	ambiguousCommit?: boolean;
};
