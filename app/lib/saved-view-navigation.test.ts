import assert from "node:assert/strict";
import test from "node:test";
import {
  definitionFromFolderView,
  definitionFromSearchView,
  savedViewRoute,
} from "./saved-view-navigation.ts";

test("folder views preserve label and sort filters", () => {
  const definition = definitionFromFolderView({
    folder: "inbox",
    searchParams: new URLSearchParams(
      "label_id=label_vip&sortColumn=sender&sortDirection=ASC",
    ),
  });
  assert.deepEqual(definition, {
    filters: { folder: "inbox", labelId: "label_vip" },
    sort: { column: "sender", direction: "ASC" },
  });
});

test("search views compose every current structured operator without dropping labels", () => {
  const definition = definitionFromSearchView({
    query:
      "renewal from:client@example.com in:inbox is:unread is:starred has:attachment after:2026-01-01 before:2026-02-01",
    searchParams: new URLSearchParams("label_id=label_vip"),
  });
  assert.equal(definition.filters.query, "renewal");
  assert.equal(definition.filters.from, "client@example.com");
  assert.equal(definition.filters.folder, "inbox");
  assert.equal(definition.filters.isRead, false);
  assert.equal(definition.filters.isStarred, true);
  assert.equal(definition.filters.hasAttachment, true);
  assert.equal(definition.filters.labelId, "label_vip");
  assert.match(definition.filters.dateStart!, /^2026-01-01/);
  assert.match(definition.filters.dateEnd!, /^2026-02-01/);
});

test("unsupported sort values fail closed to deterministic date ordering", () => {
  assert.deepEqual(
    definitionFromFolderView({
      folder: "inbox",
      searchParams: new URLSearchParams(
        "sortColumn=body&sortDirection=SIDEWAYS",
      ),
    }).sort,
    { column: "date", direction: "DESC" },
  );
  assert.equal(
    savedViewRoute("support@example.com", "view/unsafe"),
    "/mailbox/support%40example.com/views/view%2Funsafe",
  );
});
