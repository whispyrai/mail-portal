import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("every live authorization mutation awaits durable Agent reconciliation", () => {
  for (const relativePath of [
    "../routes/shared-mailbox-admin.ts",
    "../routes/admin.ts",
    "../routes/credential-recovery.ts",
    "../index.ts",
    "./account-lifecycle-runtime.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(
      source,
      /requireAgentConnectionReconciliation/,
      `${relativePath} must await the durable reconciliation fast path`,
    );
    assert.doesNotMatch(
      source,
      /agentConnectionRevoker/,
      `${relativePath} must not bypass the durable outbox`,
    );
  }
});
