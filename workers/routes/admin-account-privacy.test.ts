import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");

test("admin account management never accepts or reveals replacement credentials", () => {
  assert.doesNotMatch(source, /action="\/admin\/users\/\$\{u\.id\}\/password"/);
  assert.doesNotMatch(
    source,
    /action="\/admin\/users\/\$\{u\.id\}\/mcp-token"/,
  );
  assert.doesNotMatch(source, /name="password"/);
  assert.doesNotMatch(source, /MCP token issued/);
  assert.doesNotMatch(source, /name="recoveryEmail"/);
  assert.match(source, /recoveryAddressFor/);
  assert.match(source, /Resend secure setup link/);
  assert.match(source, /ownership_confirmed_at/);
  assert.doesNotMatch(source, /Secure recovery link sent/);
  assert.match(source, /Revoke sessions and credentials/);
});
