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
	resolveTarget(target: BatchTriageTarget): ResolvedBatchTriageTarget | null;
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
			const resolved = repository.resolveTarget(target);
			if (!resolved || resolved.emailIds.length === 0) {
				results.push({ emailId: target.emailId, status: "not_found", affectedCount: 0 });
				continue;
			}
			if (!isBatchTriageActionAllowed(command.action, resolved.folderId)) {
				results.push({
					emailId: target.emailId,
					status: "invalid_action",
					affectedCount: 0,
				});
				continue;
			}
			if (
				(command.action === "archive" || command.action === "trash") &&
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
					command.action === "archive" ? Folders.ARCHIVE : Folders.TRASH,
				);
			}
			if (affectedCount > 0) {
				repository.recordActivity({
					actor,
					action: `batch_${command.action}`,
					target,
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
