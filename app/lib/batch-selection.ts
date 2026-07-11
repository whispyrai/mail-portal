export type BatchSelectionContext = {
	mailboxId: string;
	folderId: string;
	page: number;
	searchQuery: string;
};

export function batchSelectionContextKey(context: BatchSelectionContext): string {
	return JSON.stringify([
		context.mailboxId,
		context.folderId,
		context.page,
		context.searchQuery,
	]);
}

export function reconcileVisibleSelection(
	selected: ReadonlySet<string>,
	visibleIds: readonly string[],
): Set<string> {
	const visible = new Set(visibleIds);
	return new Set([...selected].filter((id) => visible.has(id)));
}

export function batchSelectionsEqual(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): boolean {
	return left.size === right.size && [...left].every((id) => right.has(id));
}

export function selectAllVisible(
	_selected: ReadonlySet<string>,
	visibleIds: readonly string[],
): Set<string> {
	return new Set(visibleIds);
}

export function toggleVisibleSelection(
	selected: ReadonlySet<string>,
	id: string,
	visibleIds: readonly string[],
): Set<string> {
	const next = reconcileVisibleSelection(selected, visibleIds);
	if (!visibleIds.includes(id)) return next;
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}
