import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useCreateSavedView } from "~/queries/saved-views";
import type { SavedViewDefinition } from "../../shared/saved-views.ts";

export default function SaveCurrentViewButton({
  mailboxId,
  definition,
  defaultName,
}: {
  mailboxId: string;
  definition: Omit<SavedViewDefinition, "name">;
  defaultName: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState("");
  const create = useCreateSavedView();
  const toast = useKumoToastManager();

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a name for this view.");
      return;
    }
    setError("");
    create.mutate(
      {
        mailboxId,
        definition: { ...definition, name: trimmedName },
      },
      {
        onSuccess: () => {
          setOpen(false);
          toast.add({ title: "Saved view created" });
        },
        onError: (mutationError) =>
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : "Could not save this view.",
          ),
      },
    );
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(defaultName);
          setError("");
        }
      }}
    >
      <Dialog.Trigger
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            size="sm"
            icon={<BookmarkSimpleIcon size={17} />}
          >
            Save current view
          </Button>
        )}
      />
      <Dialog size="sm" className="p-5 sm:p-6">
        <Dialog.Title className="text-base font-semibold text-kumo-default">
          Save current view
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
          Only you can see this view, including inside a Shared Mailbox.
        </Dialog.Description>
        <form onSubmit={save} className="mt-5 space-y-4">
          <Input
            label="View name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            required
          />
          {error && (
            <p role="alert" className="text-sm text-kumo-danger">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Saving…" : "Save view"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
