import type { Env } from "../types.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import {
  SavedViewError,
  createSavedViewService,
  parseSavedViewDefinition,
  type SavedViewRecord,
  type SavedViewStore,
} from "./saved-views.ts";

interface SavedViewD1Row {
  id: string;
  owner_user_id: string;
  mailbox_address: string;
  name: string;
  filter_json: string;
  sort_column: SavedViewRecord["sort"]["column"];
  sort_direction: SavedViewRecord["sort"]["direction"];
  created_at: number;
  updated_at: number;
}

function fromRow(row: SavedViewD1Row): SavedViewRecord {
  let filters: unknown;
  try {
    filters = JSON.parse(row.filter_json);
  } catch {
    throw new SavedViewError("INVALID", "Stored saved view is invalid");
  }
  const definition = parseSavedViewDefinition({
    name: row.name,
    filters,
    sort: { column: row.sort_column, direction: row.sort_direction },
  });
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    mailboxAddress: row.mailbox_address,
    ...definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

export function savedViewD1Store(env: Pick<Env, "DB">): SavedViewStore {
  return {
    async list(ownerUserId, mailboxAddress) {
      const result = await env.DB.prepare(
        `SELECT id, owner_user_id, mailbox_address, name, filter_json,
				        sort_column, sort_direction, created_at, updated_at
				 FROM saved_views
				 WHERE owner_user_id = ? AND mailbox_address = ?
				 ORDER BY updated_at DESC, name COLLATE NOCASE ASC`,
      )
        .bind(ownerUserId, mailboxAddress)
        .all<SavedViewD1Row>();
      return result.results.map(fromRow);
    },

    async get(id, ownerUserId, mailboxAddress) {
      const row = await env.DB.prepare(
        `SELECT id, owner_user_id, mailbox_address, name, filter_json,
				        sort_column, sort_direction, created_at, updated_at
				 FROM saved_views
				 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?`,
      )
        .bind(id, ownerUserId, mailboxAddress)
        .first<SavedViewD1Row>();
      return row ? fromRow(row) : undefined;
    },

    async create(row) {
      try {
        await env.DB.prepare(
          `INSERT INTO saved_views
					 (id, owner_user_id, mailbox_address, name, filter_json,
					  sort_column, sort_direction, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            row.id,
            row.ownerUserId,
            row.mailboxAddress,
            row.name,
            JSON.stringify(row.filters),
            row.sort.column,
            row.sort.direction,
            row.createdAt,
            row.updatedAt,
          )
          .run();
        return row;
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new SavedViewError(
            "CONFLICT",
            "A saved view with this name already exists",
          );
        }
        throw error;
      }
    },

    async update(row) {
      try {
        const result = await env.DB.prepare(
          `UPDATE saved_views
					 SET name = ?, filter_json = ?, sort_column = ?, sort_direction = ?, updated_at = ?
					 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?`,
        )
          .bind(
            row.name,
            JSON.stringify(row.filters),
            row.sort.column,
            row.sort.direction,
            row.updatedAt,
            row.id,
            row.ownerUserId,
            row.mailboxAddress,
          )
          .run();
        if (!result.meta.changes) {
          throw new SavedViewError("NOT_FOUND", "Saved view was not found");
        }
        return row;
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new SavedViewError(
            "CONFLICT",
            "A saved view with this name already exists",
          );
        }
        throw error;
      }
    },

    async delete(id, ownerUserId, mailboxAddress) {
      const result = await env.DB.prepare(
        "DELETE FROM saved_views WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?",
      )
        .bind(id, ownerUserId, mailboxAddress)
        .run();
      return Boolean(result.meta.changes);
    },
  };
}

export function savedViewService(env: Env) {
  return createSavedViewService({
    store: savedViewD1Store(env),
    canAccessMailbox: (userId, mailboxAddress) =>
      mailboxAccess(env).canAccessMailbox(userId, mailboxAddress),
  });
}
