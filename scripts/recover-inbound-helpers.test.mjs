import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWithTimeout,
  recoveryCompletionMessage,
} from "./recover-inbound-helpers.mjs";

test("recovery requests abort after the configured timeout", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      fetchWithTimeout(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(options.signal.reason),
            );
          }),
        "https://mail.wiserchat.ai/admin/recover-inbound/example",
        { method: "POST" },
        10,
      ),
      (error) => error?.name === "TimeoutError",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("recovery output reports the actual skipped reason", () => {
  assert.equal(
    recoveryCompletionMessage({ status: "skipped", reason: "deleted" }),
    "Recovery complete: no projection was written (deleted)",
  );
});
