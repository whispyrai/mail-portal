import TiptapImage, { type ImageOptions } from "@tiptap/extension-image";
import {
	NodeViewWrapper,
	ReactNodeViewRenderer,
	type ReactNodeViewProps,
} from "@tiptap/react";
import { useSyncExternalStore } from "react";
import {
	MANAGED_INLINE_IMAGE_ATTRIBUTE,
	MANAGED_INLINE_IMAGE_VERSION,
	inlineImageContentIdFromSource,
	managedInlineImageContentId,
} from "~/lib/compose-inline-images";
import { InlineImagePreviewRegistry } from "~/lib/inline-image-preview-registry";

interface ManagedInlineImageOptions extends ImageOptions {
	previewRegistry: InlineImagePreviewRegistry;
}

function ManagedInlineImagePreview({
	node,
	extension,
	selected,
}: ReactNodeViewProps) {
	const previewRegistry: InlineImagePreviewRegistry = extension.options.previewRegistry;
	const contentId = managedInlineImageContentId(
		node.attrs.src,
		node.attrs.managed,
	);
	const previewUrl = useSyncExternalStore(
		previewRegistry.subscribe,
		() => contentId ? previewRegistry.get(contentId) : undefined,
		() => undefined,
	);

	return (
		<NodeViewWrapper
			as="span"
			className={`my-2 inline-block max-w-full rounded-md ${selected ? "ring-2 ring-kumo-brand" : ""}`}
			contentEditable={false}
			data-managed-inline-image-preview="v1"
		>
			{previewUrl ? (
				<img
					src={previewUrl}
					alt={node.attrs.alt || "Inline image"}
					className="max-h-80 max-w-full rounded-md border border-kumo-line object-contain"
					draggable={false}
				/>
			) : (
				<span
					role="status"
					className="inline-flex min-h-20 min-w-40 items-center justify-center rounded-md border border-dashed border-kumo-line bg-kumo-recessed px-3 text-xs text-kumo-subtle"
				>
					Inline image preview unavailable
				</span>
			)}
		</NodeViewWrapper>
	);
}

/**
 * Tiptap image node restricted to portal-managed CID parts. Body HTML keeps the
 * canonical cid source; the node view alone resolves a trusted local preview.
 */
export const ManagedInlineImage = TiptapImage.extend<ManagedInlineImageOptions>({
	addOptions() {
		const parent = this.parent?.();
		return {
			inline: parent?.inline ?? false,
			allowBase64: false,
			HTMLAttributes: parent?.HTMLAttributes ?? {},
			resize: parent?.resize ?? false,
			previewRegistry: new InlineImagePreviewRegistry(),
		};
	},
	addAttributes() {
		return {
			...(this.parent?.() ?? {}),
			managed: {
				default: null,
				parseHTML: (element) =>
					element.getAttribute(MANAGED_INLINE_IMAGE_ATTRIBUTE),
				renderHTML: (attributes) =>
					attributes.managed === MANAGED_INLINE_IMAGE_VERSION
						? { [MANAGED_INLINE_IMAGE_ATTRIBUTE]: MANAGED_INLINE_IMAGE_VERSION }
						: {},
			},
		};
	},
	parseHTML() {
		return [
			{
				tag: `img[${MANAGED_INLINE_IMAGE_ATTRIBUTE}]`,
				getAttrs: (element) =>
					managedInlineImageContentId(
						element.getAttribute("src"),
						element.getAttribute(MANAGED_INLINE_IMAGE_ATTRIBUTE),
					)
						? {}
						: false,
			},
			{
				tag: "img[src]",
				getAttrs: (element) => {
					if (element.hasAttribute(MANAGED_INLINE_IMAGE_ATTRIBUTE)) return false;
					const contentId = inlineImageContentIdFromSource(
						element.getAttribute("src"),
					);
					return contentId
						? {
							src: `cid:${contentId}`,
							managed: MANAGED_INLINE_IMAGE_VERSION,
						  }
						: false;
				},
			},
		];
	},
	renderHTML({ HTMLAttributes }) {
		const contentId = managedInlineImageContentId(
			HTMLAttributes.src,
			HTMLAttributes[MANAGED_INLINE_IMAGE_ATTRIBUTE],
		);
		if (!contentId) return ["span", { "data-blocked-inline-image": "v1" }];
		return ["img", {
			src: `cid:${contentId}`,
			alt: HTMLAttributes.alt ?? "",
			[MANAGED_INLINE_IMAGE_ATTRIBUTE]: MANAGED_INLINE_IMAGE_VERSION,
		}];
	},
	addInputRules() {
		return [];
	},
	addNodeView() {
		return ReactNodeViewRenderer(ManagedInlineImagePreview);
	},
});
