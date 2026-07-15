import { z } from "zod";
import {
  SAVED_VIEW_SORT_COLUMNS,
  savedViewSearchParams,
  type SavedViewDefinition,
  type SavedViewFilters,
  type SavedViewSort,
} from "../../shared/saved-views.ts";
import {
  resourceCreateFingerprint,
  resourceCreateOperationKey,
} from "./resource-create-idempotency.ts";

export { savedViewSearchParams } from "../../shared/saved-views.ts";

export type SavedViewErrorCode =
  | "INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CREATE_IDEMPOTENCY_CONFLICT"
  | "CREATION_SUPERSEDED"
  | "CREATION_UNAVAILABLE";

export class SavedViewError extends Error {
  readonly code: SavedViewErrorCode;
  readonly resourceId?: string;
  readonly currentRevision?: number;

  constructor(
    code: SavedViewErrorCode,
    message: string,
    details: { resourceId?: string; currentRevision?: number } = {},
  ) {
    super(message);
    this.name = "SavedViewError";
    this.code = code;
    this.resourceId = details.resourceId;
    this.currentRevision = details.currentRevision;
  }
}

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z
  .string()
  .max(40)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Date must be an ISO-compatible timestamp",
  );

const SavedViewFiltersSchema = z
  .object({
	searchQuery: boundedText(500).optional(),
	useDefaultSearchOrder: z.literal(true).optional(),
    query: boundedText(500).optional(),
    folder: boundedText(128).optional(),
    from: boundedText(320).optional(),
    to: boundedText(320).optional(),
    subject: boundedText(300).optional(),
    dateStart: isoDate.optional(),
    dateEnd: isoDate.optional(),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    // The existing mailbox search supports presence, not absence. Reject false
    // so a stored filter can never silently broaden when applied.
    hasAttachment: z.literal(true).optional(),
    labelId: boundedText(128).optional(),
  })
  .strict();

const SavedViewSortSchema = z
  .object({
    column: z.enum(SAVED_VIEW_SORT_COLUMNS),
    direction: z.enum(["ASC", "DESC"]),
  })
  .strict();

const SavedViewDefinitionSchema = z
  .object({
    name: boundedText(80),
    filters: SavedViewFiltersSchema,
    sort: SavedViewSortSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.filters.dateStart &&
      value.filters.dateEnd &&
      Date.parse(value.filters.dateStart) > Date.parse(value.filters.dateEnd)
    ) {
      context.addIssue({
        code: "custom",
        path: ["filters", "dateEnd"],
        message: "End date must not precede start date",
      });
    }
  });

export function parseSavedViewDefinition(input: unknown): SavedViewDefinition {
  const result = SavedViewDefinitionSchema.safeParse(input);
  if (!result.success || JSON.stringify(input).length > 4_096) {
    throw new SavedViewError("INVALID", "Saved view definition is invalid");
  }
  return result.data;
}

export interface SavedViewRecord {
  id: string;
  ownerUserId: string;
  mailboxAddress: string;
  name: string;
  filters: SavedViewFilters;
  sort: SavedViewSort;
  createdAt: number;
  updatedAt: number;
}

export interface SavedViewStore {
  list(ownerUserId: string, mailboxAddress: string): Promise<SavedViewRecord[]>;
  get(
    id: string,
    ownerUserId: string,
    mailboxAddress: string,
  ): Promise<SavedViewRecord | undefined>;
  createOrReplay(input: {
    row: SavedViewRecord;
    operationKey: string;
    fingerprint: string;
  }): Promise<
    | { status: "created" | "replayed"; view: SavedViewRecord }
    | { status: "idempotency_conflict" | "forbidden" | "name_conflict" }
    | {
        status: "creation_superseded" | "creation_unavailable";
        resourceId: string;
        currentRevision: number;
      }
  >;
  update(input: {
    id: string;
    ownerUserId: string;
    mailboxAddress: string;
    definition: SavedViewDefinition;
    updatedAt: number;
  }): Promise<SavedViewRecord>;
  delete(
    id: string,
    ownerUserId: string,
    mailboxAddress: string,
  ): Promise<boolean>;
}

export interface SavedViewServiceDependencies {
  store: SavedViewStore;
  canAccessMailbox(userId: string, mailboxAddress: string): Promise<boolean>;
  now?: () => number;
  id?: () => string;
}

export function createSavedViewService(
  dependencies: SavedViewServiceDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const id = dependencies.id ?? (() => `view_${crypto.randomUUID()}`);

  async function requireAccess(userId: string, mailboxAddress: string) {
    if (!(await dependencies.canAccessMailbox(userId, mailboxAddress))) {
      throw new SavedViewError("FORBIDDEN", "Mailbox access is required");
    }
  }

  async function owned(
    viewId: string,
    userId: string,
    mailboxAddress: string,
  ): Promise<SavedViewRecord> {
    const row = await dependencies.store.get(viewId, userId, mailboxAddress);
    if (!row) throw new SavedViewError("NOT_FOUND", "Saved view was not found");
    return row;
  }

  return {
    async list(userId: string, mailboxAddress: string) {
      const mailbox = mailboxAddress.toLowerCase();
      await requireAccess(userId, mailbox);
      return dependencies.store.list(userId, mailbox);
    },

    async use(viewId: string, userId: string, mailboxAddress: string) {
      const mailbox = mailboxAddress.toLowerCase();
      await requireAccess(userId, mailbox);
      return owned(viewId, userId, mailbox);
    },

    async create(
      userId: string,
      mailboxAddress: string,
      input: unknown,
      operationId: string,
    ) {
      const mailbox = mailboxAddress.toLowerCase();
      await requireAccess(userId, mailbox);
      const definition = parseSavedViewDefinition(input);
      if (!z.string().uuid().safeParse(operationId).success) {
        throw new SavedViewError(
          "INVALID",
          "Saved view operation ID is invalid",
        );
      }
      const timestamp = now();
      const row = {
        id: id(),
        ownerUserId: userId,
        mailboxAddress: mailbox,
        ...definition,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const [operationKey, fingerprint] = await Promise.all([
        resourceCreateOperationKey({
          kind: "saved_view",
          mailboxId: mailbox,
          actor: { kind: "user", id: userId },
          operationId,
        }),
        resourceCreateFingerprint({
          kind: "saved_view",
          payload: [definition.name, definition.filters, definition.sort],
        }),
      ]);
      const result = await dependencies.store.createOrReplay({
        row,
        operationKey,
        fingerprint,
      });
      if (result.status === "created" || result.status === "replayed") {
        return { ...result.view, replayed: result.status === "replayed" };
      }
      if (result.status === "forbidden") {
        throw new SavedViewError("FORBIDDEN", "Mailbox access is required");
      }
      if (result.status === "name_conflict") {
        throw new SavedViewError(
          "CONFLICT",
          "A saved view with this name already exists",
        );
      }
      if (result.status === "idempotency_conflict") {
        throw new SavedViewError(
          "CREATE_IDEMPOTENCY_CONFLICT",
          "This create retry no longer matches the original saved view",
        );
      }
      if (!("resourceId" in result)) {
        throw new Error("Saved view create returned an unknown outcome");
      }
      throw new SavedViewError(
        result.status === "creation_superseded"
          ? "CREATION_SUPERSEDED"
          : "CREATION_UNAVAILABLE",
        result.status === "creation_superseded"
          ? "The saved view was created and later changed"
          : "The saved view was created and later deleted",
        {
          resourceId: result.resourceId,
          currentRevision: result.currentRevision,
        },
      );
    },

    async update(
      viewId: string,
      userId: string,
      mailboxAddress: string,
      input: unknown,
    ) {
      const mailbox = mailboxAddress.toLowerCase();
      await requireAccess(userId, mailbox);
      const definition = parseSavedViewDefinition(input);
      return dependencies.store.update({
        id: viewId,
        ownerUserId: userId,
        mailboxAddress: mailbox,
        definition,
        updatedAt: now(),
      });
    },

    async delete(viewId: string, userId: string, mailboxAddress: string) {
      const mailbox = mailboxAddress.toLowerCase();
      await requireAccess(userId, mailbox);
      if (!(await dependencies.store.delete(viewId, userId, mailbox))) {
        throw new SavedViewError("NOT_FOUND", "Saved view was not found");
      }
    },
  };
}
