import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import {
	useCreateLabel,
	useDeleteLabel,
	useLabels,
	useUpdateLabel,
} from "~/queries/labels";
import type { Label, LabelColor } from "~/types";
import LabelChip from "./LabelChip";
import {
  canonicalCollapsedCreateName,
  CreateOperationIdentity,
} from "~/lib/create-operation-identity";
import { ApiError } from "~/services/api";

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
              onError: (error) =>
                toastManager.add({
                  title: errorMessage(error, "Could not delete label"),
                  variant: "error",
                }),
            },
          )
        }
      />
    </div>
  );
}

export default function ManageLabelsDialog({
  mailboxId,
  open,
  onOpenChange,
}: {
  mailboxId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: labels = [] } = useLabels(mailboxId);
  const createLabel = useCreateLabel();
  const toastManager = useKumoToastManager();
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>("blue");
  const [createError, setCreateError] = useState("");
  const createIdentity = useRef(new CreateOperationIdentity());
  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const canonicalName = canonicalCollapsedCreateName(name);
    if (!canonicalName) return;
    setCreateError("");
    const operationId = createIdentity.current.operationIdFor([
      mailboxId.toLowerCase(),
      "label",
      canonicalName,
      color,
    ]);
    createLabel.mutate(
      { mailboxId, name: canonicalName, color, operationId },
      {
        onSuccess: (result) => {
          toastManager.add({
            title: `${result.replayed ? "Recovered" : "Created"} ${canonicalName}`,
          });
          createIdentity.current.invalidate();
          setName("");
          setCreateError("");
        },
        onError: (error) => {
          const code =
            error instanceof ApiError ? String(error.body.code ?? "") : "";
          const message =
            code === "creation_superseded"
              ? "This label was created and later changed. It was not overwritten. Change the name or color to create another label."
              : code === "creation_unavailable"
                ? "This label was created and later deleted. It was not recreated. Change the name or color to create another label."
                : code === "create_idempotency_conflict"
                  ? "This recovery no longer matches the original label. Change the name or color to start a new create."
                  : error instanceof ApiError
                    ? error.message
                    : "We couldn’t confirm whether the label was created. Retry with the same name and color to recover it safely.";
          setCreateError(message);
        },
      },
    );
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!createLabel.isPending) onOpenChange(next);
      }}
    >
      <Dialog
        size="lg"
        className="min-w-0 max-h-[85vh] overflow-y-auto p-6 sm:min-w-[32rem]"
      >
        <Dialog.Title className="text-lg font-semibold">
          Manage mailbox labels
        </Dialog.Title>
        <p className="mt-1 text-sm text-kumo-subtle">
          Labels are shared by everyone with access to this mailbox. Deleting a
          label never deletes mail.
        </p>
        <form
          onSubmit={create}
          className="mt-5 grid gap-3 rounded-xl bg-kumo-tint p-4 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
        >
          <Input
            className="min-h-11"
            label="New label"
            placeholder="Waiting on client"
            value={name}
            disabled={createLabel.isPending}
            onChange={(event) => {
              const nextName = event.target.value;
              const intentChanged =
                createIdentity.current.invalidateIfIntentChanged([
                  mailboxId.toLowerCase(),
                  "label",
                  canonicalCollapsedCreateName(nextName),
                  color,
                ]);
              if (intentChanged) setCreateError("");
              setName(nextName);
            }}
          />
          <label className="text-xs font-medium text-kumo-subtle">
            Color
            <select
              disabled={createLabel.isPending}
              className="mt-1 h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm disabled:opacity-60"
              value={color}
              onChange={(event) => {
                const nextColor = event.target.value as LabelColor;
                const intentChanged =
                  createIdentity.current.invalidateIfIntentChanged([
                    mailboxId.toLowerCase(),
                    "label",
                    canonicalCollapsedCreateName(name),
                    nextColor,
                  ]);
                if (intentChanged) setCreateError("");
                setColor(nextColor);
              }}
            >
              {COLORS.map((value) => (
                <option key={value} value={value}>
                  {humanizeColor(value)}
                </option>
              ))}
            </select>
          </label>
          <Button
            className="min-h-11 w-full sm:w-auto"
            type="submit"
            loading={createLabel.isPending}
            disabled={!name.trim() || createLabel.isPending}
          >
            {createLabel.isPending ? "Creating" : "Create"}
          </Button>
        </form>
        {createError && (
          <p role="alert" className="mt-3 text-sm text-kumo-danger">
            {createError}
          </p>
        )}
        <div className="mt-5 space-y-2">
          {labels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-kumo-line p-8 text-center">
              <p className="text-sm text-kumo-subtle">No labels yet.</p>
              <div className="mt-3">
                <LabelChip
                  label={{ id: "preview", name: "Your first label", color }}
                />
              </div>
            </div>
          ) : (
            labels.map((label) => (
              <LabelEditor
                key={`${label.id}:${label.updatedAt ?? ""}`}
                mailboxId={mailboxId}
                label={label}
              />
            ))
          )}
        </div>
        <div className="sticky bottom-0 -mx-6 -mb-6 mt-5 flex justify-end border-t border-kumo-line bg-kumo-base px-6 py-4">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                disabled={createLabel.isPending}
                className="w-full sm:w-auto"
              >
                Done
              </Button>
            )}
          />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
