import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");

test("admin sets passwords deliberately and still never reveals other credentials", () => {
  assert.match(source, /name="password"/);
  assert.match(source, /action="\/admin\/users\/\$\{u\.id\}\/password"/);
  assert.match(source, /setUserPassword/);
  assert.match(source, /hashPassword\(password, c\.env\.JWT_SECRET\)/);
  assert.match(source, /ownershipConfirmedAt: Date\.now\(\)/);

  assert.doesNotMatch(source, /action="\/admin\/users\/\$\{u\.id\}\/mcp-token"/);
  assert.doesNotMatch(source, /MCP token issued/);
  assert.doesNotMatch(source, /name="recoveryEmail"/);
  assert.match(source, /maskedRecoveryAddress/);
  assert.match(source, /Revoke sessions and credentials/);
});

test("the admin console no longer issues setup invitations", () => {
  assert.doesNotMatch(source, /issueSetupLink/);
  assert.doesNotMatch(source, /Resend secure setup link/);
  assert.doesNotMatch(source, /credentialRecoveryWorkflow/);
  assert.doesNotMatch(source, /purpose: "setup"/);
  assert.doesNotMatch(source, /\/admin\/users\/\$\{u\.id\}\/setup/);
});
