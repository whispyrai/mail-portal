import type { Env } from "../types.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import {
  SavedViewError,
  createSavedViewService,
  parseSavedViewDefinition,
  type SavedViewRecord,
  type SavedViewStore,
} from "./saved-views.ts";
import { LIVE_MAILBOX_ACCESS_SQL } from "./live-mailbox-access-sql.ts";
import { RESOURCE_CREATE_REPLAY_WINDOW_MS } from "./resource-create-idempotency.ts";

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

interface SavedViewCreateOperationRow extends Partial<SavedViewD1Row> {
  allowed: number;
  operation_key: string | null;
  fingerprint: string | null;
  view_id: string | null;
  state: "active" | "superseded" | "unavailable" | null;
  operation_updated_at: number | null;
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

function isSavedViewNameConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed:\s*saved_views\.owner_user_id,\s*saved_views\.mailbox_address,\s*saved_views\.name/i.test(
      error.message,
    )
  );
}

export function savedViewD1Store(env: Pick<Env, "DB">): SavedViewStore {
  async function findCreateOutcome(input: {
    ownerUserId: string;
    mailboxAddress: string;
    operationKey: string;
    fingerprint: string;
    now: number;
  }) {
    const row = await env.DB.prepare(
      `SELECT ${LIVE_MAILBOX_ACCESS_SQL} AS allowed,
              operation.operation_key, operation.fingerprint, operation.view_id,
              operation.state, operation.updated_at AS operation_updated_at,
              view.id, view.owner_user_id, view.mailbox_address, view.name,
              view.filter_json, view.sort_column, view.sort_direction,
              view.created_at, view.updated_at
       FROM (SELECT 1) AS seed
       LEFT JOIN saved_view_create_operations AS operation
         ON operation.operation_key = ?
        AND operation.owner_user_id = ?
        AND operation.mailbox_address = ?
        AND (
          operation.state = 'active'
          OR operation.updated_at >= ?
        )
       LEFT JOIN saved_views AS view
         ON view.id = operation.view_id
        AND view.owner_user_id = operation.owner_user_id
        AND view.mailbox_address = operation.mailbox_address`,
    )
      .bind(
        input.mailboxAddress,
        input.ownerUserId,
        input.operationKey,
        input.ownerUserId,
        input.mailboxAddress,
        input.now - RESOURCE_CREATE_REPLAY_WINDOW_MS,
      )
      .first<SavedViewCreateOperationRow>();
    if (!row?.allowed) return { status: "forbidden" as const };
    if (!row.operation_key || !row.fingerprint || !row.state || !row.view_id) {
      return null;
    }
    if (row.fingerprint !== input.fingerprint) {
      return { status: "idempotency_conflict" as const };
    }
    if (row.state === "superseded" || row.state === "unavailable") {
      return {
        status:
          row.state === "superseded"
            ? ("creation_superseded" as const)
            : ("creation_unavailable" as const),
        resourceId: row.view_id,
        currentRevision:
          row.state === "superseded"
            ? (row.updated_at ?? row.operation_updated_at ?? input.now)
            : (row.operation_updated_at ?? input.now),
      };
    }
    if (
      row.id &&
      row.owner_user_id &&
      row.mailbox_address &&
      row.name &&
      row.filter_json &&
      row.sort_column &&
      row.sort_direction &&
      row.created_at != null &&
      row.updated_at != null
    ) {
      return {
        status: "replayed" as const,
        view: fromRow(row as SavedViewD1Row),
      };
    }
    return {
      status: "creation_unavailable" as const,
      resourceId: row.view_id,
      currentRevision: row.operation_updated_at ?? input.now,
    };
  }

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

    async createOrReplay({ row, operationKey, fingerprint }) {
      const replay = await findCreateOutcome({
        ownerUserId: row.ownerUserId,
        mailboxAddress: row.mailboxAddress,
        operationKey,
        fingerprint,
        now: row.updatedAt,
      });
      if (replay) return replay;
      try {
        const results = await env.DB.batch([
          env.DB.prepare(
            `DELETE FROM saved_view_create_operations
             WHERE operation_key IN (
               SELECT operation_key FROM saved_view_create_operations
               WHERE state IN ('superseded', 'unavailable') AND updated_at < ?
               ORDER BY CASE WHEN operation_key = ? THEN 0 ELSE 1 END,
                        updated_at, operation_key
               LIMIT 100
             )`,
          ).bind(
            row.updatedAt - RESOURCE_CREATE_REPLAY_WINDOW_MS,
            operationKey,
          ),
          env.DB.prepare(
            `INSERT INTO saved_views
             (id, owner_user_id, mailbox_address, name, filter_json,
              sort_column, sort_direction, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${LIVE_MAILBOX_ACCESS_SQL}
               AND NOT EXISTS (
                 SELECT 1 FROM saved_view_create_operations WHERE operation_key = ?
               )`,
          ).bind(
            row.id,
            row.ownerUserId,
            row.mailboxAddress,
            row.name,
            JSON.stringify(row.filters),
            row.sort.column,
            row.sort.direction,
            row.createdAt,
            row.updatedAt,
            row.mailboxAddress,
            row.ownerUserId,
            operationKey,
          ),
          env.DB.prepare(
            `INSERT INTO saved_view_create_operations
             (operation_key, fingerprint, owner_user_id, mailbox_address,
              view_id, state, updated_at)
             SELECT ?, ?, ?, ?, ?, 'active', ?
             WHERE changes() = 1`,
          ).bind(
            operationKey,
            fingerprint,
            row.ownerUserId,
            row.mailboxAddress,
            row.id,
            row.updatedAt,
          ),
        ]);
        if (results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1) {
          return { status: "created" as const, view: row };
        }
        return (
          (await findCreateOutcome({
            ownerUserId: row.ownerUserId,
            mailboxAddress: row.mailboxAddress,
            operationKey,
            fingerprint,
            now: row.updatedAt,
          })) ?? { status: "name_conflict" as const }
        );
      } catch (error) {
        if (!isSavedViewNameConstraint(error)) throw error;
        const outcome = await findCreateOutcome({
          ownerUserId: row.ownerUserId,
          mailboxAddress: row.mailboxAddress,
          operationKey,
          fingerprint,
          now: row.updatedAt,
        });
        return outcome ?? { status: "name_conflict" as const };
      }
    },

    async update(input) {
      const filterJson = JSON.stringify(input.definition.filters);
      try {
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE saved_views
						 SET name = ?, filter_json = ?, sort_column = ?, sort_direction = ?, updated_at = ?
						 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?
               AND ${LIVE_MAILBOX_ACCESS_SQL}
               AND (
                 name COLLATE BINARY <> ? COLLATE BINARY
                 OR filter_json <> ?
                 OR sort_column <> ?
                 OR sort_direction <> ?
               )`,
          ).bind(
            input.definition.name,
            filterJson,
            input.definition.sort.column,
            input.definition.sort.direction,
            input.updatedAt,
            input.id,
            input.ownerUserId,
            input.mailboxAddress,
            input.mailboxAddress,
            input.ownerUserId,
            input.definition.name,
            filterJson,
            input.definition.sort.column,
            input.definition.sort.direction,
          ),
          env.DB.prepare(
            `UPDATE saved_view_create_operations
             SET state = 'superseded', updated_at = ?
             WHERE owner_user_id = ? AND mailbox_address = ? AND view_id = ?
               AND state = 'active' AND changes() = 1`,
          ).bind(
            input.updatedAt,
            input.ownerUserId,
            input.mailboxAddress,
            input.id,
          ),
          env.DB.prepare(
            `SELECT ${LIVE_MAILBOX_ACCESS_SQL} AS allowed,
                    view.id, view.owner_user_id, view.mailbox_address, view.name,
                    view.filter_json, view.sort_column, view.sort_direction,
                    view.created_at, view.updated_at
             FROM (SELECT 1) AS seed
             LEFT JOIN saved_views AS view
               ON view.id = ? AND view.owner_user_id = ? AND view.mailbox_address = ?`,
          ).bind(
            input.mailboxAddress,
            input.ownerUserId,
            input.id,
            input.ownerUserId,
            input.mailboxAddress,
          ),
        ]);
        const authoritative = results[2]?.results?.[0] as
          | SavedViewCreateOperationRow
          | undefined;
        if (!authoritative?.allowed) {
          throw new SavedViewError("FORBIDDEN", "Mailbox access is required");
        }
        if (
          !authoritative.id ||
          !authoritative.owner_user_id ||
          !authoritative.mailbox_address ||
          !authoritative.name ||
          !authoritative.filter_json ||
          !authoritative.sort_column ||
          !authoritative.sort_direction ||
          authoritative.created_at == null ||
          authoritative.updated_at == null
        ) {
          throw new SavedViewError("NOT_FOUND", "Saved view was not found");
        }
        return fromRow(authoritative as SavedViewD1Row);
      } catch (error) {
        if (isSavedViewNameConstraint(error)) {
          throw new SavedViewError(
            "CONFLICT",
            "A saved view with this name already exists",
          );
        }
        throw error;
      }
    },

    async delete(id, ownerUserId, mailboxAddress) {
      const now = Date.now();
      const results = await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM saved_views
           WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?
             AND ${LIVE_MAILBOX_ACCESS_SQL}`,
        ).bind(id, ownerUserId, mailboxAddress, mailboxAddress, ownerUserId),
        env.DB.prepare(
          `UPDATE saved_view_create_operations
           SET state = 'unavailable', updated_at = ?
           WHERE owner_user_id = ? AND mailbox_address = ? AND view_id = ?
             AND state IN ('active', 'superseded') AND changes() = 1`,
        ).bind(now, ownerUserId, mailboxAddress, id),
        env.DB.prepare(`SELECT ${LIVE_MAILBOX_ACCESS_SQL} AS allowed`).bind(
          mailboxAddress,
          ownerUserId,
        ),
      ]);
      if (results[0]?.meta.changes) return true;
      const access = results[2]?.results?.[0] as
        | { allowed?: number }
        | undefined;
      if (!access?.allowed) {
        throw new SavedViewError("FORBIDDEN", "Mailbox access is required");
      }
      return false;
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
