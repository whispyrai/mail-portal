import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLoginRequest,
  buildRecoveryRequest,
  fetchWithTimeout,
  incompleteRecoveryAuditMessage,
  isIncompleteRecoveryAudit,
  isUnverifiedRecoveryCommit,
  recoveryCompletionMessage,
  shouldRetryRecoveryResponse,
  unverifiedRecoveryCommitMessage,
  validateRecoveryTarget,
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

test("recovery target validation permits only current production mail domains", () => {
  assert.equal(
    validateRecoveryTarget(
      "https://mail.wiserchat.ai",
      "hello@wiserchat.ai",
    ).ok,
    true,
  );
  assert.equal(
    validateRecoveryTarget(
      "https://mail.whispyrcrm.com",
      "hello@whispyrcrm.com",
    ).ok,
    true,
  );
  assert.equal(
    validateRecoveryTarget(
      "https://mail.wiserchat.ai",
      "hello@preview.wiserchat.ai",
    ).ok,
    false,
  );
  assert.equal(
    validateRecoveryTarget(
      "https://mail.wiserchat.ai/path",
      "hello@wiserchat.ai",
    ).ok,
    false,
  );
  assert.equal(
    validateRecoveryTarget("not-a-url", "hello@wiserchat.ai").error,
    "--base must be a valid absolute URL",
  );
  assert.equal(
    validateRecoveryTarget("https://mail.wiserchat.ai", "@wiserchat.ai").error,
    "--mailbox must be a valid email address",
  );
  assert.equal(
    validateRecoveryTarget(
      "https://mail.wiserchat.ai",
      "one@two@wiserchat.ai",
    ).ok,
    false,
  );
});

test("login and recovery mutations send the exact approved portal Origin", () => {
  const baseUrl = new URL("https://mail.wiserchat.ai/");
  const login = buildLoginRequest(baseUrl, "admin@example.com", "secret");
  assert.equal(login.url, "https://mail.wiserchat.ai/login");
  assert.equal(login.options.headers.origin, "https://mail.wiserchat.ai");
  assert.equal(
    login.options.headers["content-type"],
    "application/x-www-form-urlencoded",
  );

  const recovery = buildRecoveryRequest(
    baseUrl,
    "session=opaque",
    "hello@wiserchat.ai",
    "ingress-1",
  );
  assert.equal(
    recovery.url,
    "https://mail.wiserchat.ai/admin/recover-inbound/hello%40wiserchat.ai?ingressId=ingress-1",
  );
  assert.deepEqual(recovery.options.headers, {
    cookie: "session=opaque",
    origin: "https://mail.wiserchat.ai",
  });
});

test("incomplete completion audits are partial success and carry no-retry guidance", () => {
  const response = {
    status: "repaired",
    auditStatus: "incomplete",
    auditId: "audit-1",
  };
  assert.equal(isIncompleteRecoveryAudit(response), true);
  assert.equal(isIncompleteRecoveryAudit({ status: "repaired" }), false);
  assert.match(incompleteRecoveryAuditMessage(response), /was repaired/);
  assert.match(incompleteRecoveryAuditMessage(response), /mutation committed/);
  assert.match(incompleteRecoveryAuditMessage(response), /Do not rerun recovery/);
  assert.match(incompleteRecoveryAuditMessage(response), /audit-1/);
  assert.match(
    incompleteRecoveryAuditMessage({
      status: "stale_marker",
      auditStatus: "incomplete",
    }),
    /reached the reported outcome/,
  );
});

test("unverified commits are terminal manual-verification outcomes", () => {
  const response = {
    error: "Repair outcome could not be verified",
    commitStatus: "unverified",
    auditId: "audit-2",
    recoveryGuidance:
      "Do not retry blindly. Inspect the current generation and repair marker first.",
  };
  assert.equal(isUnverifiedRecoveryCommit(response), true);
  assert.equal(isUnverifiedRecoveryCommit({ commitStatus: "committed" }), false);
  assert.match(
    unverifiedRecoveryCommitMessage(response),
    /Repair outcome could not be verified/,
  );
  assert.match(unverifiedRecoveryCommitMessage(response), /Do not retry blindly/);
  assert.match(unverifiedRecoveryCommitMessage(response), /audit-2/);
});

test("only safe transient recovery failures remain retryable", () => {
  assert.equal(shouldRetryRecoveryResponse(503, { error: "Unavailable" }), true);
  assert.equal(
    shouldRetryRecoveryResponse(503, {
      status: "repaired",
      auditStatus: "incomplete",
    }),
    false,
  );
  assert.equal(
    shouldRetryRecoveryResponse(503, { commitStatus: "unverified" }),
    false,
  );
  assert.equal(shouldRetryRecoveryResponse(400, { error: "Invalid" }), false);
});

test("recovery completion copy is truthful for every server outcome", () => {
  assert.match(recoveryCompletionMessage({ status: "repaired" }), /content was repaired/);
  assert.match(
    recoveryCompletionMessage({ status: "repaired", ambiguousCommit: true }),
    /generation marker proved the commit/,
  );
  assert.match(recoveryCompletionMessage({ status: "recovered" }), /projection was restored/);
  assert.match(recoveryCompletionMessage({ status: "deleted" }), /remains deleted/);
  assert.match(recoveryCompletionMessage({ status: "missing" }), /still missing/);
  assert.match(recoveryCompletionMessage({ status: "stale_marker" }), /marker was stale/);
  assert.match(recoveryCompletionMessage({ status: "already_repaired" }), /already committed/);
  assert.equal(
    recoveryCompletionMessage({ status: "future_status" }),
    "Recovery finished with an unrecognized status (future_status)",
  );
  assert.equal(
    recoveryCompletionMessage({}),
    "Recovery finished with an unrecognized outcome",
  );
});
