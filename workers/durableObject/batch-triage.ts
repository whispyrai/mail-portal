import { Folders } from "../../shared/folders.ts";
import {
	isBatchTriageActionAllowed,
	type BatchTriageCommand,
	type BatchTriageResult,
	type BatchTriageTarget,
} from "../../shared/batch-triage.ts";
import type { ActivityActor } from "../lib/activity.ts";

export type ResolvedBatchTriageTarget = {
	emailIds: string[];
	folderId: string;
};

export interface BatchTriageRepository {
	transaction<T>(run: () => T): T;
	resolveFolder(folderId: string): string | null;
	resolveTarget(target: BatchTriageTarget): ResolvedBatchTriageTarget | null;
	isTargetStateSatisfied(
		target: BatchTriageTarget,
		targetFolderId: string,
	): boolean;
	hasActiveOutbound(emailIds: string[]): boolean;
	setRead(emailIds: string[], read: boolean): number;
	move(emailIds: string[], fromFolderId: string, toFolderId: string): void;
	recordActivity(input: {
		actor: ActivityActor;
		action: string;
		target: BatchTriageTarget;
		affectedCount: number;
	}): void;
}

export function executeBatchTriage(
	repository: BatchTriageRepository,
	command: BatchTriageCommand,
	actor: ActivityActor,
): BatchTriageResult {
	return repository.transaction(() => {
		const results: BatchTriageResult["results"] = [];
		for (const target of command.targets) {
			const sourceFolderId = repository.resolveFolder(target.folderId);
			const policyFolderId = sourceFolderId ?? target.folderId;
			if (!isBatchTriageActionAllowed(command.action, policyFolderId)) {
				results.push({
					emailId: target.emailId,
					status: "invalid_action",
					affectedCount: 0,
				});
				continue;
			}

			const canonicalTarget = {
				...target,
				folderId: sourceFolderId ?? target.folderId,
			};
			const targetFolderId = command.action === "archive"
				? Folders.ARCHIVE
				: command.action === "trash"
					? Folders.TRASH
					: null;
			if (
				targetFolderId &&
				repository.isTargetStateSatisfied(canonicalTarget, targetFolderId)
			) {
				results.push({
					emailId: target.emailId,
					status: "updated",
					affectedCount: 0,
				});
				continue;
			}
			if (!sourceFolderId) {
				results.push({ emailId: target.emailId, status: "not_found", affectedCount: 0 });
				continue;
			}

			const resolved = repository.resolveTarget(canonicalTarget);
			if (!resolved || resolved.emailIds.length === 0) {
				results.push({ emailId: target.emailId, status: "not_found", affectedCount: 0 });
				continue;
			}
			if (
				targetFolderId &&
				repository.hasActiveOutbound(resolved.emailIds)
			) {
				results.push({
					emailId: target.emailId,
					status: "outbound_delivery_active",
					affectedCount: 0,
				});
				continue;
			}

			let affectedCount = resolved.emailIds.length;
			if (command.action === "mark_read" || command.action === "mark_unread") {
				affectedCount = repository.setRead(
					resolved.emailIds,
					command.action === "mark_read",
				);
			} else {
				repository.move(
					resolved.emailIds,
					resolved.folderId,
					targetFolderId!,
				);
			}
			if (affectedCount > 0) {
				repository.recordActivity({
					actor,
					action: `batch_${command.action}`,
					target: canonicalTarget,
					affectedCount,
				});
			}
			results.push({
				emailId: target.emailId,
				status: "updated",
				affectedCount,
			});
		}
		const succeededCount = results.filter((result) => result.status === "updated").length;
		return {
			requestedCount: command.targets.length,
			succeededCount,
			failedCount: results.length - succeededCount,
			results,
		};
	});
}
