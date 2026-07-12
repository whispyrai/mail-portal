type PreviewListener = () => void;

function normalizedPreviews(
	previews: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(previews).map(([contentId, url]) => [
			contentId.toLowerCase(),
			url,
		]),
	);
}

function equalPreviews(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
): boolean {
	const leftEntries = Object.entries(left);
	return leftEntries.length === Object.keys(right).length &&
		leftEntries.every(([contentId, url]) => right[contentId] === url);
}

/** Mutable render-only seam consumed by Tiptap node views. */
export class InlineImagePreviewRegistry {
	#previews: Record<string, string> = {};
	readonly #listeners = new Set<PreviewListener>();

	get = (contentId: string): string | undefined =>
		this.#previews[contentId.toLowerCase()];

	subscribe = (listener: PreviewListener): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	replace(previews: Readonly<Record<string, string>>): void {
		const next = normalizedPreviews(previews);
		if (equalPreviews(this.#previews, next)) return;
		this.#previews = next;
		for (const listener of this.#listeners) listener();
	}
}
