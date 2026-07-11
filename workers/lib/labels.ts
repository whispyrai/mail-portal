export const LABEL_COLORS = [
	"gray",
	"red",
	"orange",
	"yellow",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export type LabelMutationTarget = {
	emailId: string;
	folderId: string;
	conversationId?: string;
};

export function normalizeLabelName(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function validateLabelDefinition(name: string, color: string) {
	const displayName = name.trim().replace(/\s+/g, " ");
	if (!displayName) throw new Error("Label name is required");
	if (displayName.length > 64) throw new Error("Label name cannot exceed 64 characters");
	if (!LABEL_COLORS.includes(color as LabelColor)) {
		throw new Error("Label color is not supported");
	}
	return {
		name: displayName,
		normalizedName: normalizeLabelName(displayName),
		color: color as LabelColor,
	};
}

export function validateLabelMutationTargets(
	targets: LabelMutationTarget[],
): LabelMutationTarget[] {
	if (targets.length === 0) throw new Error("At least one message target is required");
	if (targets.length > 100) throw new Error("A maximum of 100 targets can be changed at once");
	const seen = new Set<string>();
	for (const target of targets) {
		if (!target.emailId?.trim() || !target.folderId?.trim()) {
			throw new Error("Every label target requires an email and folder");
		}
		const key = `${target.folderId}\u0000${target.emailId}\u0000${target.conversationId ?? ""}`;
		if (seen.has(key)) throw new Error("Duplicate label mutation target");
		seen.add(key);
	}
	return targets;
}
