import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./recover-inbound.mjs", import.meta.url),
  "utf8",
);

test("the recovery CLI never retries a committed mutation with an incomplete audit", () => {
  const retryDecision = source.indexOf(
    "shouldRetryRecoveryResponse(finalResponse.status, responseBody)",
  );
  const retryDelay = source.indexOf("Recovery attempt ${attempt}/3 failed");
  const partialReport = source.lastIndexOf(
    "incompleteRecoveryAuditMessage(responseBody)",
  );
  assert.ok(retryDecision > 0);
  assert.ok(retryDecision < retryDelay);
  assert.ok(partialReport > retryDelay);
  assert.match(source, /process\.exitCode = 2/);
});

test("the recovery CLI treats an unverified commit as terminal manual verification", () => {
  const retryDecision = source.indexOf(
    "shouldRetryRecoveryResponse(finalResponse.status, responseBody)",
  );
  const retryDelay = source.indexOf("Recovery attempt ${attempt}/3 failed");
  const terminalReport = source.lastIndexOf(
    "unverifiedRecoveryCommitMessage(responseBody)",
  );
  assert.ok(retryDecision > 0);
  assert.ok(retryDecision < retryDelay);
  assert.ok(terminalReport > retryDelay);
});

test("the recovery CLI uses origin-bearing request builders for both mutations", () => {
  assert.match(source, /buildLoginRequest\(\s*baseUrl,\s*args\.email/);
  assert.match(source, /buildRecoveryRequest\(/);
});

test("the recovery CLI delegates target validation and contains no retired test domain", () => {
  assert.match(source, /validateRecoveryTarget\(args\.base, args\.mailbox\)/);
  assert.doesNotMatch(source, /test\.wiserchat\.ai/);
});
