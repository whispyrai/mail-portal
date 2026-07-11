import { Button, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";
import type { BatchTriageAction } from "../../shared/batch-triage";

export default function BatchTriageToolbar({
	visibleCount,
	selectedCount,
	allowedActions,
	disabled,
	onToggleAll,
	onClear,
	onAction,
	labelControl,
}: {
	visibleCount: number;
	selectedCount: number;
	allowedActions: ReadonlySet<BatchTriageAction>;
	disabled?: boolean;
	onToggleAll: () => void;
	onClear: () => void;
	onAction: (action: BatchTriageAction) => void;
	labelControl?: ReactNode;
}) {
	const selectAllRef = useRef<HTMLInputElement>(null);
	const allSelected = visibleCount > 0 && selectedCount === visibleCount;
	useEffect(() => {
		if (selectAllRef.current) {
			selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
		}
	}, [allSelected, selectedCount]);

	return (
		<div
			className="flex min-h-12 min-w-0 flex-wrap items-center gap-1.5 border-b border-kumo-line bg-kumo-tint px-2 py-2 sm:px-3 md:px-5"
			role="toolbar"
			aria-label="Bulk message actions"
		>
			<label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-kumo-strong focus-within:ring-2 focus-within:ring-kumo-brand">
				<input
					ref={selectAllRef}
					type="checkbox"
					className="h-5 w-5 accent-kumo-brand"
					checked={allSelected}
					onChange={onToggleAll}
					disabled={disabled || visibleCount === 0}
					aria-label={allSelected ? "Clear visible selection" : "Select all visible conversations"}
				/>
				<span className="whitespace-nowrap" role="status" aria-live="polite">
					{selectedCount > 0 ? `${selectedCount} selected` : "Select visible"}
				</span>
			</label>

			{selectedCount > 0 && (
				<>
					<div className="mx-1 hidden h-6 w-px bg-kumo-line sm:block" aria-hidden="true" />
					{allowedActions.has("mark_read") && (
						<Tooltip content="Mark selected read" asChild>
							<Button
								variant="ghost"
								size="sm"
								className="min-h-11 min-w-11"
								icon={<EnvelopeOpenIcon size={16} />}
								onClick={() => onAction("mark_read")}
								disabled={disabled}
								aria-label="Mark selected conversations read"
							>
								<span className="hidden sm:inline">Read</span>
							</Button>
						</Tooltip>
					)}
					{allowedActions.has("mark_unread") && (
						<Tooltip content="Mark selected unread" asChild>
							<Button
								variant="ghost"
								size="sm"
								className="min-h-11 min-w-11"
								icon={<EnvelopeSimpleIcon size={16} />}
								onClick={() => onAction("mark_unread")}
								disabled={disabled}
								aria-label="Mark selected conversations unread"
							>
								<span className="hidden sm:inline">Unread</span>
							</Button>
						</Tooltip>
					)}
					{allowedActions.has("archive") && (
						<Button
							variant="ghost"
							size="sm"
							className="min-h-11 min-w-11"
							icon={<ArchiveIcon size={16} />}
							onClick={() => onAction("archive")}
							disabled={disabled}
							aria-label="Archive selected conversations"
						>
							<span className="hidden sm:inline">Archive</span>
						</Button>
					)}
					{allowedActions.has("trash") && (
						<Button
							variant="ghost"
							size="sm"
							className="min-h-11 min-w-11"
							icon={<TrashIcon size={16} />}
							onClick={() => onAction("trash")}
							disabled={disabled}
							aria-label="Move selected conversations to Trash"
						>
							<span className="hidden sm:inline">Trash</span>
						</Button>
					)}
					{labelControl}
					<Tooltip content="Clear selection" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							className="min-h-11 min-w-11"
							icon={<XIcon size={16} />}
							onClick={onClear}
							disabled={disabled}
							aria-label="Clear selected conversations"
						/>
					</Tooltip>
				</>
			)}
		</div>
	);
}
