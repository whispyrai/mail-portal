import { TagIcon } from "@phosphor-icons/react";
import type { Label } from "~/types";
import LabelChip from "./LabelChip";

export default function LabelPicker({
	labels,
	selectedIds,
	onToggle,
	disabled,
	buttonLabel = "Labels",
}: {
	labels: Label[];
	selectedIds: ReadonlySet<string>;
	onToggle: (label: Label, selected: boolean) => void;
	disabled?: boolean;
	buttonLabel?: string;
}) {
	return (
		<details className="relative inline-block" open={disabled ? false : undefined}>
			<summary
				className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 text-sm font-medium text-kumo-strong hover:bg-kumo-tint ${disabled ? "pointer-events-none opacity-50" : ""}`}
				aria-label={buttonLabel}
				aria-disabled={disabled || undefined}
				tabIndex={disabled ? -1 : 0}
				onClick={(event) => { if (disabled) event.preventDefault(); }}
				onKeyDown={(event) => {
					if (disabled && (event.key === "Enter" || event.key === " ")) event.preventDefault();
				}}
			>
				<TagIcon size={16} />
				{buttonLabel}
			</summary>
			<div className="absolute right-0 z-50 mt-2 max-h-[min(22rem,calc(100vh-6rem))] w-[min(16rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-2 shadow-xl">
				<div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
					Mailbox labels
				</div>
				{labels.length === 0 ? (
					<p className="px-2 py-3 text-sm text-kumo-subtle">Create a label from the sidebar first.</p>
				) : labels.map((label) => {
					const selected = selectedIds.has(label.id);
					return (
						<label key={label.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-kumo-tint">
							<input
								type="checkbox"
								checked={selected}
								onChange={(event) => onToggle(label, event.target.checked)}
								className="h-4 w-4 accent-kumo-brand"
							/>
							<LabelChip label={label} />
						</label>
					);
				})}
			</div>
		</details>
	);
}
