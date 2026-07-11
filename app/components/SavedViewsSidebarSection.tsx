import { Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import {
  BookmarkSimpleIcon,
  PencilSimpleIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { NavLink } from "react-router";
import { savedViewRoute } from "~/lib/saved-view-navigation";
import {
  useDeleteSavedView,
  useSavedViews,
  useUpdateSavedView,
} from "~/queries/saved-views";
import type { SavedView } from "../../shared/saved-views.ts";

export default function SavedViewsSidebarSection({
  mailboxId,
  onNavigate,
}: {
  mailboxId: string;
  onNavigate?: () => void;
}) {
  const { data: views = [], isLoading, isError } = useSavedViews(mailboxId);
  const update = useUpdateSavedView();
  const remove = useDeleteSavedView();
  const [managerOpen, setManagerOpen] = useState(false);
  const [editing, setEditing] = useState<SavedView | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");

  const beginEdit = (view: SavedView) => {
    setEditing(view);
    setEditName(view.name);
    setError("");
  };

  const rename = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !editName.trim()) return;
    update.mutate(
      {
        mailboxId,
        viewId: editing.id,
        definition: {
          name: editName.trim(),
          filters: editing.filters,
          sort: editing.sort,
        },
      },
      {
        onSuccess: () => setEditing(null),
        onError: (mutationError) =>
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : "Could not rename this view.",
          ),
      },
    );
  };

  const deleteView = (view: SavedView) => {
    if (!window.confirm(`Delete the saved view “${view.name}”?`)) return;
    remove.mutate({ mailboxId, viewId: view.id });
  };

  return (
    <section className="pt-5" aria-labelledby="saved-views-heading">
      <div className="mb-1.5 flex items-center justify-between px-3">
        <h2
          id="saved-views-heading"
          className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle"
        >
          Saved views
        </h2>
        <Tooltip content="Manage saved views" asChild>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            icon={<SlidersHorizontalIcon size={16} />}
            onClick={() => setManagerOpen(true)}
            aria-label="Manage saved views"
          />
        </Tooltip>
      </div>
      {isLoading && (
        <p role="status" className="px-3 py-2 text-xs text-kumo-subtle">
          Loading saved views…
        </p>
      )}
      {isError && (
        <p role="alert" className="px-3 py-2 text-xs text-kumo-danger">
          Saved views are unavailable.
        </p>
      )}
      {!isLoading && !isError && views.length === 0 && (
        <p className="px-3 py-2 text-xs text-kumo-subtle">
          Save a search or folder view to find it here.
        </p>
      )}
      {views.map((view) => (
        <NavLink
          key={view.id}
          to={savedViewRoute(mailboxId, view.id)}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-kumo-fill font-semibold text-kumo-default"
                : "text-kumo-strong hover:bg-kumo-tint"
            }`
          }
        >
          <BookmarkSimpleIcon size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{view.name}</span>
        </NavLink>
      ))}

      <Dialog.Root
        open={managerOpen}
        onOpenChange={(next) => {
          setManagerOpen(next);
          if (!next) setEditing(null);
        }}
      >
        <Dialog
          size="lg"
          className="max-h-[min(720px,calc(100dvh-1rem))] overflow-y-auto p-5 sm:p-6"
        >
          <Dialog.Title className="text-base font-semibold text-kumo-default">
            Manage saved views
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
            Renaming or deleting a view affects only your account.
          </Dialog.Description>
          <div className="mt-5 space-y-2">
            {views.length === 0 && (
              <p className="py-6 text-center text-sm text-kumo-subtle">
                No saved views yet.
              </p>
            )}
            {views.map((view) => (
              <div
                key={view.id}
                className="rounded-lg border border-kumo-line p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                    {view.name}
                  </span>
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={<PencilSimpleIcon size={16} />}
                    onClick={() => beginEdit(view)}
                    aria-label={`Rename ${view.name}`}
                  />
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={<TrashIcon size={16} />}
                    onClick={() => deleteView(view)}
                    aria-label={`Delete ${view.name}`}
                  />
                </div>
                {editing?.id === view.id && (
                  <form
                    onSubmit={rename}
                    className="mt-3 space-y-3 border-t border-kumo-line pt-3"
                  >
                    <Input
                      label="View name"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      maxLength={80}
                      autoFocus
                      required
                    />
                    {error && (
                      <p role="alert" className="text-sm text-kumo-danger">
                        {error}
                      </p>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={update.isPending || !editName.trim()}
                      >
                        Rename
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary">
                  Done
                </Button>
              )}
            />
          </div>
        </Dialog>
      </Dialog.Root>
    </section>
  );
}
