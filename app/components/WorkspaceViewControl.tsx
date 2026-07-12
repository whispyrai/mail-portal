import { Button, Popover } from "@cloudflare/kumo";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useUIStore } from "~/hooks/useUIStore";
import {
	LIST_PANE_WIDTH_PRESETS,
	type MailDensity,
} from "~/lib/workspace-preferences";

interface ViewOptionProps {
	name: string;
	value: string;
	checked: boolean;
	title: string;
	description: string;
	onSelect: () => void;
}

function ViewOption({
	name,
	value,
	checked,
	title,
	description,
	onSelect,
}: ViewOptionProps) {
	return (
		<label
			className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors focus-within:ring-2 focus-within:ring-kumo-ring ${
				checked
					? "border-kumo-brand bg-kumo-tint"
					: "border-kumo-line bg-kumo-base hover:bg-kumo-tint"
			}`}
		>
			<input
				type="radio"
				name={name}
				value={value}
				checked={checked}
				onChange={onSelect}
				className="h-4 w-4 shrink-0 accent-kumo-brand"
			/>
			<span className="min-w-0">
				<span className="block text-sm font-medium text-kumo-default">
					{title}
				</span>
				<span className="mt-0.5 block text-xs leading-4 text-kumo-subtle">
					{description}
				</span>
			</span>
		</label>
	);
}

const DENSITY_OPTIONS: ReadonlyArray<{
	value: MailDensity;
	title: string;
	description: string;
}> = [
	{
		value: "comfortable",
		title: "Comfortable",
		description: "More breathing room for scanning.",
	},
	{
		value: "compact",
		title: "Compact",
		description: "Fit more conversations on screen.",
	},
];

export default function WorkspaceViewControl() {
	const {
		mailDensity,
		listPaneWidth,
		conversationIntelligenceExpanded,
		setMailDensity,
		setListPaneWidth,
		setConversationIntelligenceExpanded,
	} = useUIStore();
	const isCustomListPaneWidth = !LIST_PANE_WIDTH_PRESETS.some(
		(option) => option.value === listPaneWidth,
	);

	return (
		<Popover>
			<Popover.Trigger asChild>
				<Button
					variant="ghost"
					size="sm"
					icon={<SlidersHorizontalIcon size={20} aria-hidden="true" />}
					aria-label="Mail workspace view"
					className="min-h-11 min-w-11 shrink-0 px-2"
				>
					<span className="hidden lg:inline">View</span>
				</Button>
			</Popover.Trigger>
			<Popover.Content
				side="bottom"
				align="end"
				positionMethod="fixed"
				className="max-h-[calc(100dvh-1rem)] w-[min(22rem,calc(100vw-1rem))] gap-0 overflow-y-auto p-4"
			>
				<Popover.Title>Workspace view</Popover.Title>
				<Popover.Description className="mt-1 text-sm leading-5">
					Tune this mailbox for the way you work. Choices stay on this
					browser.
				</Popover.Description>

				<fieldset className="mt-4">
					<legend className="text-sm font-semibold text-kumo-default">Density</legend>
					<div className="mt-2 grid grid-cols-2 gap-2">
						{DENSITY_OPTIONS.map((option) => (
							<ViewOption
								key={option.value}
								name="mail-density"
								value={option.value}
								checked={mailDensity === option.value}
								title={option.title}
								description={option.description}
								onSelect={() => setMailDensity(option.value)}
							/>
						))}
					</div>
				</fieldset>

				<fieldset className="mt-4 border-t border-kumo-line pt-4">
					<legend className="text-sm font-semibold text-kumo-default">List width</legend>
					<div className="mt-2 grid gap-2">
						{LIST_PANE_WIDTH_PRESETS.map((option) => (
							<ViewOption
								key={option.value}
								name="list-pane-width"
								value={String(option.value)}
								checked={listPaneWidth === option.value}
								title={option.label}
								description={`${option.value}px conversation list`}
								onSelect={() => setListPaneWidth(option.value)}
							/>
						))}
						{isCustomListPaneWidth && (
							<ViewOption
								name="list-pane-width"
								value={String(listPaneWidth)}
								checked
								title={`Custom · ${listPaneWidth}px`}
								description="Saved from your last drag resize."
								onSelect={() => setListPaneWidth(listPaneWidth)}
							/>
						)}
					</div>
					<p className="mt-2 text-xs leading-4 text-kumo-subtle md:hidden">
						On phones, mail stays single-column, so list width applies when
						you return to a larger screen.
					</p>
				</fieldset>

				<fieldset className="mt-4 border-t border-kumo-line pt-4">
					<legend className="text-sm font-semibold text-kumo-default">Intelligence panel</legend>
					<div className="mt-2 grid grid-cols-2 gap-2">
						<ViewOption
							name="conversation-intelligence"
							value="collapsed"
							checked={!conversationIntelligenceExpanded}
							title="Collapsed"
							description="Keep reading focused."
							onSelect={() => setConversationIntelligenceExpanded(false)}
						/>
						<ViewOption
							name="conversation-intelligence"
							value="expanded"
							checked={conversationIntelligenceExpanded}
							title="Expanded"
							description="Keep AI context open."
							onSelect={() => setConversationIntelligenceExpanded(true)}
						/>
					</div>
				</fieldset>
			</Popover.Content>
		</Popover>
	);
}
