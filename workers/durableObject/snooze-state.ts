import { Folders } from "../../shared/folders.ts";
import type { ActivityActor } from "../lib/activity.ts";
import {
	MAX_SNOOZE_TARGETS,
	isSnoozeSourceFolder,
	resolveUnsnoozeFolder,
	type SnoozeRequest,
} from "../lib/snooze.ts";

export type SnoozeScope = SnoozeRequest["scope"];

export interface ResolvedSnoozeEmail {
	id: string;
	folderId: string;
	sourceFolderId: string | null;
}

export interface SnoozeRepository {
	transaction<T>(run: () => T): T;
	resolveScope(
		scope: SnoozeScope,
		mode: "snooze" | "unsnooze",
	): ResolvedSnoozeEmail[] | { tooLarge: true } | null;
	hasActiveOutbound(emailIds: string[]): boolean;
	folderExists(folderId: string): boolean;
	applySnooze(input: {
		emailIds: string[];
		sourceFolderId: string;
		wakeAt: string;
	}): void;
	clearSnooze(input: { targets: Array<{ id: string; folderId: string }> }): void;
	recordActivity(input: {
		actor: ActivityActor;
		action: string;
		entityType: "email" | "conversation";
		entityId: string;
		metadata: Record<string, unknown>;
	}): void;
}

export type SnoozeMutationResult = {
	status:
		| "snoozed"
		| "unsnoozed"
		| "not_found"
		| "ineligible"
		| "too_large"
		| "outbound_delivery_active";
	affectedCount: number;
};

export function executeSnooze(
	repository: SnoozeRepository,
	request: SnoozeRequest,
	actor: ActivityActor,
): SnoozeMutationResult {
	return repository.transaction(() => {
		const resolved = repository.resolveScope(request.scope, "snooze");
		if (resolved && !Array.isArray(resolved)) {
			return { status: "too_large", affectedCount: 0 };
		}
		if (!resolved?.length) return { status: "not_found", affectedCount: 0 };
		if (resolved.length > MAX_SNOOZE_TARGETS) {
			return { status: "too_large", affectedCount: 0 };
		}
		const sourceFolderId = resolved[0]!.folderId;
		if (
			!isSnoozeSourceFolder(sourceFolderId) ||
			resolved.some((row) => row.folderId !== sourceFolderId)
		) {
			return { status: "ineligible", affectedCount: 0 };
		}
		const emailIds = resolved.map((row) => row.id);
		if (repository.hasActiveOutbound(emailIds)) {
			return { status: "outbound_delivery_active", affectedCount: 0 };
		}
		repository.applySnooze({ emailIds, sourceFolderId, wakeAt: request.wakeAt });
		repository.recordActivity({
			actor,
			action: request.scope.kind === "conversation"
				? "conversation_snoozed"
				: "email_snoozed",
			entityType: request.scope.kind === "conversation" ? "conversation" : "email",
			entityId: request.scope.kind === "conversation"
				? request.scope.conversationId
				: request.scope.emailId,
			metadata: {
				fromFolderId: sourceFolderId,
				wakeAt: request.wakeAt,
				affectedCount: emailIds.length,
			},
		});
		return { status: "snoozed", affectedCount: emailIds.length };
	});
}

export function executeUnsnooze(
	repository: SnoozeRepository,
	scope: SnoozeScope,
	actor: ActivityActor,
): SnoozeMutationResult {
	return repository.transaction(() => {
		const resolved = repository.resolveScope(scope, "unsnooze");
		if (resolved && !Array.isArray(resolved)) {
			return { status: "too_large", affectedCount: 0 };
		}
		if (!resolved?.length) return { status: "not_found", affectedCount: 0 };
		if (resolved.length > MAX_SNOOZE_TARGETS) {
			return { status: "too_large", affectedCount: 0 };
		}
		if (resolved.some((row) => row.folderId !== Folders.SNOOZED)) {
			return { status: "ineligible", affectedCount: 0 };
		}
		const targets = resolved.map((row) => ({
			id: row.id,
			folderId: resolveUnsnoozeFolder(
				row.sourceFolderId,
				Boolean(row.sourceFolderId && repository.folderExists(row.sourceFolderId)),
			),
		}));
		repository.clearSnooze({ targets });
		repository.recordActivity({
			actor,
			action: scope.kind === "conversation"
				? "conversation_unsnoozed"
				: "email_unsnoozed",
			entityType: scope.kind === "conversation" ? "conversation" : "email",
			entityId: scope.kind === "conversation" ? scope.conversationId : scope.emailId,
			metadata: { affectedCount: targets.length },
		});
		return { status: "unsnoozed", affectedCount: targets.length };
	});
}
