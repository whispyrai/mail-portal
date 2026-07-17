import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("admin setup issuance uses the encrypted outbox and canonical brand origin", () => {
  const admin = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
  const runtime = readFileSync(
    new URL("../lib/credential-recovery-runtime.ts", import.meta.url),
    "utf8",
  );

  assert.match(admin, /credentialRecoveryWorkflow\(c\.env\)\.issue\(/);
  assert.match(admin, /origin: resolveBrand\(c\.env\.BRAND\)\.mailOrigin/);
  assert.match(admin, /const maintenance = drainCredentialRecoveryDeliveries\(c\.env\)/);
  assert.match(admin, /waitUntil\(maintenance\)/);
  assert.doesNotMatch(runtime, /sendEmailWithOutcome|prepareSesSend|fetch\(/);
});
