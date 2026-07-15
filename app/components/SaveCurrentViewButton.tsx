import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useCreateSavedView } from "~/queries/saved-views";
import type { SavedViewDefinition } from "../../shared/saved-views.ts";
import { CreateOperationIdentity } from "~/lib/create-operation-identity";
import { SavedViewApiError } from "~/services/saved-views";

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
  const identity = useRef(new CreateOperationIdentity());
  const definitionIdentity = JSON.stringify(definition);
  const createContext = JSON.stringify([mailboxId.toLowerCase(), definition]);
  const previousCreateContext = useRef(createContext);

  useEffect(() => {
    if (previousCreateContext.current === createContext) return;
    previousCreateContext.current = createContext;
    identity.current.invalidate();
    setError("");
    if (!open) setName(defaultName);
  }, [createContext, defaultName, definitionIdentity, open]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a name for this view.");
      return;
    }
    setError("");
    const operationId = identity.current.operationIdFor([
      mailboxId.toLowerCase(),
      "saved-view",
      trimmedName,
      definition,
    ]);
    create.mutate(
      {
        mailboxId,
        definition: { ...definition, name: trimmedName },
        operationId,
      },
      {
        onSuccess: (result) => {
          identity.current.invalidate();
          setName(defaultName);
          setError("");
          setOpen(false);
          toast.add({
            title: result.replayed
              ? "Saved view recovered"
              : "Saved view created",
          });
        },
        onError: (mutationError) => {
          const code =
            mutationError instanceof SavedViewApiError
              ? mutationError.code
              : "";
          setError(
            code === "creation_superseded"
              ? "This view was created and later changed. It was not overwritten. Change the name or filters to save another view."
              : code === "creation_unavailable"
                ? "This view was created and later deleted. It was not recreated. Change the name or filters to save another view."
                : code === "create_idempotency_conflict"
                  ? "This recovery no longer matches the original view. Change the name or filters to start a new save."
                  : mutationError instanceof SavedViewApiError
                    ? mutationError.message
                    : "We couldn’t confirm whether the view was saved. Retry with the same name to recover it safely.",
          );
        },
      },
    );
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (next && !identity.current.hasActiveOperation()) {
          setName(defaultName);
          setError("");
        }
        setOpen(next);
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
            onChange={(event) => {
              const nextName = event.target.value;
              const intentChanged = identity.current.invalidateIfIntentChanged([
                mailboxId.toLowerCase(),
                "saved-view",
                nextName.trim(),
                definition,
              ]);
              if (intentChanged) setError("");
              setName(nextName);
            }}
            disabled={create.isPending}
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
                <Button
                  {...props}
                  variant="secondary"
                  disabled={create.isPending}
                  className="min-h-11 w-full sm:w-auto"
                >
                  Cancel
                </Button>
              )}
            />
            <Button
              type="submit"
              loading={create.isPending}
              disabled={create.isPending || !name.trim()}
              className="min-h-11 w-full sm:w-auto"
            >
              {create.isPending ? "Saving…" : "Save view"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
