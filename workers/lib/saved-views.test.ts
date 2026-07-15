import assert from "node:assert/strict";
import test from "node:test";
import {
  SavedViewError,
  createSavedViewService,
  parseSavedViewDefinition,
  savedViewSearchParams,
  type SavedViewRecord,
  type SavedViewStore,
} from "./saved-views.ts";

function record(overrides: Partial<SavedViewRecord> = {}): SavedViewRecord {
  return {
    id: "view_1",
    ownerUserId: "usr_1",
    mailboxAddress: "support@example.com",
    name: "Needs attention",
    filters: { folder: "inbox", isRead: false, labelId: "label_urgent" },
    sort: { column: "date", direction: "DESC" },
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function memoryStore(seed: SavedViewRecord[] = []) {
  const rows = new Map(seed.map((row) => [row.id, row]));
  const operations = new Map<string, { fingerprint: string; viewId: string }>();
  const calls: string[] = [];
  const store: SavedViewStore = {
    async list(ownerUserId, mailboxAddress) {
      calls.push("list");
      return [...rows.values()].filter(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.mailboxAddress === mailboxAddress,
      );
    },
    async get(id, ownerUserId, mailboxAddress) {
      calls.push("get");
      const row = rows.get(id);
      return row?.ownerUserId === ownerUserId &&
        row.mailboxAddress === mailboxAddress
        ? row
        : undefined;
    },
    async createOrReplay({ row, operationKey, fingerprint }) {
      calls.push("createOrReplay");
      const operation = operations.get(operationKey);
      if (operation) {
        if (operation.fingerprint !== fingerprint) {
          return { status: "idempotency_conflict" };
        }
        const existing = rows.get(operation.viewId);
        return existing
          ? { status: "replayed", view: existing }
          : {
              status: "creation_unavailable",
              resourceId: operation.viewId,
              currentRevision: row.updatedAt,
            };
      }
      if (
        [...rows.values()].some(
          (existing) =>
            existing.ownerUserId === row.ownerUserId &&
            existing.mailboxAddress === row.mailboxAddress &&
            existing.name.toLowerCase() === row.name.toLowerCase(),
        )
      ) {
        return { status: "name_conflict" };
      }
      operations.set(operationKey, { fingerprint, viewId: row.id });
      rows.set(row.id, row);
      return { status: "created", view: row };
    },
    async update(input) {
      calls.push("update");
      const current = rows.get(input.id);
      if (
        !current ||
        current.ownerUserId !== input.ownerUserId ||
        current.mailboxAddress !== input.mailboxAddress
      ) {
        throw new SavedViewError("NOT_FOUND", "Saved view was not found");
      }
      const row = {
        ...current,
        ...input.definition,
        updatedAt: input.updatedAt,
      };
      rows.set(input.id, row);
      return row;
    },
    async delete(id, ownerUserId, mailboxAddress) {
      calls.push("delete");
      const row = await store.get(id, ownerUserId, mailboxAddress);
      if (!row) return false;
      rows.delete(id);
      return true;
    },
  };
  return { store, calls, rows };
}

test("saved view definitions are bounded and preserve every supported filter", () => {
  const definition = parseSavedViewDefinition({
    name: "  VIP unread  ",
    filters: {
      query: "renewal",
      folder: "inbox",
      from: "customer@example.com",
      to: "team@example.com",
      subject: "Contract",
      dateStart: "2026-01-01T00:00:00.000Z",
      dateEnd: "2026-12-31T23:59:59.999Z",
      isRead: false,
      isStarred: true,
      hasAttachment: true,
      labelId: "label_vip",
    },
    sort: { column: "sender", direction: "ASC" },
  });

  assert.equal(definition.name, "VIP unread");
  assert.equal(definition.filters.labelId, "label_vip");
  assert.deepEqual(savedViewSearchParams(definition), {
    query: "renewal",
    folder: "inbox",
    from: "customer@example.com",
    to: "team@example.com",
    subject: "Contract",
    date_start: "2026-01-01T00:00:00.000Z",
    date_end: "2026-12-31T23:59:59.999Z",
    is_read: "false",
    is_starred: "true",
    has_attachment: "true",
    label_id: "label_vip",
    sortColumn: "sender",
    sortDirection: "ASC",
  });
});

test("saved views preserve the exact Search v2 grammar", () => {
	const searchQuery =
		'renewal "signed proposal" from:alice from:bob filename:terms.pdf';
	const definition = parseSavedViewDefinition({
		name: "Renewals",
		filters: { searchQuery },
		sort: { column: "date", direction: "DESC" },
	});
	assert.deepEqual(savedViewSearchParams(definition), {
		q: searchQuery,
		sortColumn: "date",
		sortDirection: "DESC",
	});
});

test("saved views preserve Search v2 default relevance ordering", () => {
	const definition = parseSavedViewDefinition({
		name: "Relevant renewals",
		filters: {
			searchQuery: "renewal proposal",
			useDefaultSearchOrder: true,
		},
		sort: { column: "date", direction: "DESC" },
	});
	assert.deepEqual(savedViewSearchParams(definition), {
		q: "renewal proposal",
	});
});

test("invalid, oversized, unsupported, and broadening filters fail closed", () => {
  for (const input of [
    { name: "", filters: {}, sort: { column: "date", direction: "DESC" } },
    {
      name: "x",
      filters: { query: "x".repeat(501) },
      sort: { column: "date", direction: "DESC" },
    },
    {
      name: "x",
      filters: { hasAttachment: false },
      sort: { column: "date", direction: "DESC" },
    },
    {
      name: "x",
      filters: { unknown: "unsafe" },
      sort: { column: "date", direction: "DESC" },
    },
    { name: "x", filters: {}, sort: { column: "body", direction: "DESC" } },
    {
      name: "x",
      filters: { dateStart: "not-a-date" },
      sort: { column: "date", direction: "DESC" },
    },
  ]) {
    assert.throws(() => parseSavedViewDefinition(input), SavedViewError);
  }
});

test("every operation rechecks live mailbox access and revocation never deletes rows", async () => {
  const existing = record();
  const memory = memoryStore([existing]);
  let allowed = true;
  let checks = 0;
  const service = createSavedViewService({
    store: memory.store,
    canAccessMailbox: async () => {
      checks++;
      return allowed;
    },
    now: () => 20,
    id: () => "view_new",
  });

  assert.equal((await service.list("usr_1", "support@example.com")).length, 1);
  assert.equal(
    (await service.use("view_1", "usr_1", "support@example.com")).id,
    "view_1",
  );
  await service.create(
    "usr_1",
    "support@example.com",
    {
      name: "Starred",
      filters: { isStarred: true },
      sort: { column: "date", direction: "DESC" },
    },
    "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
  );
  await service.update("view_1", "usr_1", "support@example.com", {
    name: "Unread",
    filters: { isRead: false },
    sort: { column: "date", direction: "DESC" },
  });
  await service.delete("view_new", "usr_1", "support@example.com");
  assert.equal(checks, 5);

  allowed = false;
  for (const operation of [
    () => service.list("usr_1", "support@example.com"),
    () => service.use("view_1", "usr_1", "support@example.com"),
    () =>
      service.update("view_1", "usr_1", "support@example.com", {
        name: "Nope",
        filters: {},
        sort: { column: "date", direction: "DESC" },
      }),
    () => service.delete("view_1", "usr_1", "support@example.com"),
  ]) {
    await assert.rejects(
      operation,
      (error: unknown) =>
        error instanceof SavedViewError && error.code === "FORBIDDEN",
    );
  }
  assert.equal(memory.rows.has("view_1"), true);
  assert.equal(memory.calls.filter((call) => call === "delete").length, 1);
});

test("saved views are private to their owner even inside a shared mailbox", async () => {
  const memory = memoryStore([record()]);
  const service = createSavedViewService({
    store: memory.store,
    canAccessMailbox: async () => true,
  });

  assert.deepEqual(await service.list("usr_2", "support@example.com"), []);
  await assert.rejects(
    () => service.use("view_1", "usr_2", "support@example.com"),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "NOT_FOUND",
  );
});

test("saved view creation requires a caller-owned UUID operation identity", async () => {
  const memory = memoryStore();
  const service = createSavedViewService({
    store: memory.store,
    canAccessMailbox: async () => true,
  });
  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        {
          name: "Urgent",
          filters: { isRead: false },
          sort: { column: "date", direction: "DESC" },
        },
        "not-a-uuid",
      ),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "INVALID",
  );
  assert.equal(memory.calls.includes("createOrReplay"), false);
});
