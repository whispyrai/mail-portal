import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("both isolated environments ship the scheduled maintenance entrypoint", () => {
  const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
  const config = readFileSync(
    new URL("../../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const verifier = readFileSync(
    new URL("../../scripts/verify-built-environment.mjs", import.meta.url),
    "utf8",
  );
  assert.match(app, /async scheduled\(controller: ScheduledController, env: Env\)/);
  assert.match(app, /runScheduledMaintenance\(env, controller\)/);
  assert.match(config, /"crons": \["\* \* \* \* \*", "17 \* \* \* \*"\]/);
  assert.match(verifier, /scheduled maintenance crons/);
});
