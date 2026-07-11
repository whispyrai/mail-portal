import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
	useCreateLabel,
	useDeleteLabel,
	useLabels,
	useUpdateLabel,
} from "~/queries/labels";
import type { Label, LabelColor } from "~/types";
import LabelChip from "./LabelChip";

const COLORS: LabelColor[] = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

function humanizeColor(color: LabelColor) {
	return color.charAt(0).toUpperCase() + color.slice(1);
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message ? error.message : fallback;
}

function LabelEditor({ mailboxId, label }: { mailboxId: string; label: Label }) {
	const updateLabel = useUpdateLabel();
	const deleteLabel = useDeleteLabel();
	const toastManager = useKumoToastManager();
	const [name, setName] = useState(label.name);
	const [color, setColor] = useState<LabelColor>(label.color);
	return (
		<div className="grid gap-2 rounded-lg border border-kumo-line p-3 sm:grid-cols-[1fr_8rem_auto_auto] sm:items-end">
			<Input className="min-h-11" label="Name" value={name} onChange={(event) => setName(event.target.value)} />
			<label className="text-xs font-medium text-kumo-subtle">Color
				<select className="mt-1 h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm" value={color} onChange={(event) => setColor(event.target.value as LabelColor)}>
					{COLORS.map((value) => <option key={value} value={value}>{humanizeColor(value)}</option>)}
				</select>
			</label>
			<Button className="min-h-11" size="sm" variant="secondary" disabled={!name.trim() || updateLabel.isPending} onClick={() => updateLabel.mutate(
				{ mailboxId, labelId: label.id, name, color },
				{
					onSuccess: () => toastManager.add({ title: `Updated ${name.trim()}` }),
					onError: (error) => toastManager.add({ title: errorMessage(error, "Could not update label"), variant: "error" }),
				},
			)}>Save</Button>
			<Button className="min-h-11 min-w-11" shape="square" size="sm" variant="ghost" icon={<TrashIcon size={16} />} aria-label={`Delete ${label.name}`} onClick={() => window.confirm(`Delete “${label.name}”? Messages will not be deleted.`) && deleteLabel.mutate(
				{ mailboxId, labelId: label.id },
				{
					onSuccess: () => toastManager.add({ title: `Deleted ${label.name}` }),
					onError: (error) => toastManager.add({ title: errorMessage(error, "Could not delete label"), variant: "error" }),
				},
			)} />
		</div>
	);
}

export default function ManageLabelsDialog({ mailboxId, open, onOpenChange }: { mailboxId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { data: labels = [] } = useLabels(mailboxId);
	const createLabel = useCreateLabel();
	const toastManager = useKumoToastManager();
	const [name, setName] = useState("");
	const [color, setColor] = useState<LabelColor>("blue");
	const create = (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		createLabel.mutate(
			{ mailboxId, name, color },
			{
				onSuccess: () => {
					toastManager.add({ title: `Created ${name.trim()}` });
					setName("");
				},
				onError: (error) => toastManager.add({ title: errorMessage(error, "Could not create label"), variant: "error" }),
			},
		);
	};
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="lg" className="max-h-[85vh] overflow-y-auto p-6">
				<Dialog.Title className="text-lg font-semibold">Manage mailbox labels</Dialog.Title>
				<p className="mt-1 text-sm text-kumo-subtle">Labels are shared by everyone with access to this mailbox. Deleting a label never deletes mail.</p>
				<form onSubmit={create} className="mt-5 grid gap-3 rounded-xl bg-kumo-tint p-4 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
					<Input className="min-h-11" label="New label" placeholder="Waiting on client" value={name} onChange={(event) => setName(event.target.value)} />
					<label className="text-xs font-medium text-kumo-subtle">Color
						<select className="mt-1 h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm" value={color} onChange={(event) => setColor(event.target.value as LabelColor)}>
							{COLORS.map((value) => <option key={value} value={value}>{humanizeColor(value)}</option>)}
						</select>
					</label>
					<Button className="min-h-11" type="submit" disabled={!name.trim() || createLabel.isPending}>Create</Button>
				</form>
				<div className="mt-5 space-y-2">
					{labels.length === 0 ? <div className="rounded-lg border border-dashed border-kumo-line p-8 text-center"><p className="text-sm text-kumo-subtle">No labels yet.</p><div className="mt-3"><LabelChip label={{ id: "preview", name: "Your first label", color }} /></div></div> : labels.map((label) => <LabelEditor key={`${label.id}:${label.updatedAt ?? ""}`} mailboxId={mailboxId} label={label} />)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
