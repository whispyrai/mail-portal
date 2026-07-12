export interface DraftCreateRecord {
	id: string;
	fingerprint: string;
	draftVersion: number;
}

export function classifyDraftCreateReplay(
	existing: DraftCreateRecord | null,
	fingerprint: string,
) {
	if (!existing) return { status: "missing" as const };
	if (existing.fingerprint !== fingerprint) {
		return {
			status: "conflict" as const,
			draftId: existing.id,
			currentVersion: existing.draftVersion,
		};
	}
	if (existing.draftVersion !== 1) {
		return {
			status: "superseded" as const,
			draftId: existing.id,
			currentVersion: existing.draftVersion,
		};
	}
	return { status: "replay" as const, draftId: existing.id };
}
