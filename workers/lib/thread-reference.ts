export interface ThreadReferenceRow {
	id: string;
	messageId: string | null;
	threadId: string | null;
}

export function resolveUnambiguousThreadReference(
	orderedReferences: string[],
	rows: ThreadReferenceRow[],
): string | null {
	const references = new Map<string, Set<string>>();
	for (const row of rows) {
		const canonical = row.threadId || row.id;
		for (const reference of [row.id, row.messageId].filter(
			(value): value is string => Boolean(value),
		)) {
			const values = references.get(reference) ?? new Set<string>();
			values.add(canonical);
			references.set(reference, values);
		}
	}
	const canonicalThreads = new Set<string>();
	for (const reference of orderedReferences) {
		const values = references.get(reference);
		if (!values) continue;
		if (values.size !== 1) return null;
		canonicalThreads.add([...values][0]!);
	}
	return canonicalThreads.size === 1 ? [...canonicalThreads][0]! : null;
}
