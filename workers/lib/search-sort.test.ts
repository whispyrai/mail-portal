import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchSort } from "./search-sort.ts";

test("search sorting accepts only the saved view allowlist", () => {
  assert.deepEqual(normalizeSearchSort("sender", "ASC"), {
    column: "sender",
    direction: "ASC",
  });
  assert.deepEqual(normalizeSearchSort("body; DROP TABLE emails", "SIDEWAYS"), {
    column: "date",
    direction: "DESC",
  });
});
