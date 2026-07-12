import {
	validateAttachmentSet,
	validateSingleFile,
} from "../../shared/attachments.ts";

export interface ComposeAttachmentCapacityItem {
	filename: string;
	size: number;
	status?: string;
}

export interface ComposeAttachmentAdmissionDecision {
	index: number;
	accepted: boolean;
	error?: string;
}

/**
 * Admit a batch in input order against the exact capacity already consumed by
 * ready and in-flight files. A rejected candidate never consumes capacity, so
 * a mixed batch always produces the same result for the same ordered input.
 */
export function planComposeAttachmentAdmission(
	current: ReadonlyArray<ComposeAttachmentCapacityItem>,
	incoming: ReadonlyArray<{ filename: string; size: number }>,
): {
	decisions: ComposeAttachmentAdmissionDecision[];
	capacity: Array<{ filename: string; size: number }>;
} {
	const capacity = current
		.filter(
			(attachment) =>
				attachment.status === undefined ||
				attachment.status === "ready" ||
				attachment.status === "uploading",
		)
		.map(({ filename, size }) => ({ filename, size }));
	const decisions = incoming.map((candidate, index) => {
		const error =
			validateSingleFile(candidate) ||
			validateAttachmentSet([...capacity, candidate]);
		if (error) return { index, accepted: false, error };
		capacity.push({ ...candidate });
		return { index, accepted: true };
	});
	return { decisions, capacity };
}
