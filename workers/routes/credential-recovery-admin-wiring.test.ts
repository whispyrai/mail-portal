import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("self-service recovery delivers through the encrypted outbox, never inline", () => {
  const runtime = readFileSync(
    new URL("../lib/credential-recovery-runtime.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runtime, /sendEmailWithOutcome|prepareSesSend|fetch\(/);
});

test("recovery imposes no password length requirement", () => {
  const page = readFileSync(
    new URL("./credential-recovery.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(page, /minlength/);
  assert.doesNotMatch(page, /password\.length < \d+/);
  assert.doesNotMatch(page, /at least \d+ characters/);
  assert.match(page, /!password \|\|/);
});
