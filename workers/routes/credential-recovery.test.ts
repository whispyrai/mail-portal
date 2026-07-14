import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { privateNoStore } from "../lib/response-privacy.ts";
import type { Env } from "../types.ts";
import {
  createCredentialRecoveryHandler,
  type CredentialRecoveryHandlerDependencies,
} from "./credential-recovery.ts";

const recoveryToken = "recovery-secret";
const password = "correct horse battery staple";
const generatedMcpToken = "mcp_once_<unsafe>";

function testApp(input: {
  consumed?: Awaited<
    ReturnType<CredentialRecoveryHandlerDependencies["consume"]>
  >;
  reconciliationError?: unknown;
  consumeError?: unknown;
  reportError?: unknown;
}) {
  const events: string[] = [];
  const reports: Parameters<
    CredentialRecoveryHandlerDependencies["reportAgentReconciliation"]
  >[0][] = [];
  let consumeCount = 0;
  let reconcileCount = 0;
  const dependencies: CredentialRecoveryHandlerDependencies = {
    async hashPassword(value, pepper) {
      events.push("hash-password");
      assert.equal(value, password);
      assert.equal(pepper, "test-secret");
      return { hash: "password-hash", salt: "password-salt" };
    },
    generateMcpToken() {
      events.push("generate-mcp-token");
      return generatedMcpToken;
    },
    async hashToken(value) {
      events.push("hash-mcp-token");
      assert.equal(value, generatedMcpToken);
      return "mcp-token-hash";
    },
    async consume(_env, value) {
      events.push("consume");
      consumeCount += 1;
      assert.equal(value.token, recoveryToken);
      assert.equal(value.passwordHash, "password-hash");
      assert.equal(value.passwordSalt, "password-salt");
      assert.equal(
        value.mcpTokenHash,
        events.includes("generate-mcp-token") ? "mcp-token-hash" : null,
      );
      if (input.consumeError) throw input.consumeError;
      return input.consumed === undefined
        ? {
            userId: "user-1",
            loginEmail: "person+<unsafe>@example.com",
            outcome: "recovered" as const,
          }
        : input.consumed;
    },
    async reconcileAgentConnections(_env, userId) {
      events.push("reconcile");
      reconcileCount += 1;
      assert.equal(userId, "user-1");
      if (input.reconciliationError) throw input.reconciliationError;
    },
    reportAgentReconciliation(report) {
      events.push("report-reconciliation");
      reports.push(report);
      if (input.reportError) throw input.reportError;
    },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.onError((_error, c) => c.text("Internal Server Error", 500));
  app.use("*", privateNoStore);
  app.post("/account/recover", createCredentialRecoveryHandler(dependencies));
  return {
    app,
    events,
    reports,
    consumeCount: () => consumeCount,
    reconcileCount: () => reconcileCount,
  };
}

function request(
  app: Hono<{ Bindings: Env }>,
  overrides: Record<string, string> = {},
) {
  return app.request(
    "http://mail.wiserchat.ai/account/recover",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: recoveryToken,
        password,
        confirm: password,
        createMcp: "yes",
        ...overrides,
      }),
    },
    { JWT_SECRET: "test-secret", BRAND: "wiser" } as Env,
  );
}

test("recovery returns complete success only after Agent reconciliation", async () => {
  const target = testApp({});
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(body, /Your new credentials are active/);
  assert.match(body, /person\+&lt;unsafe&gt;@example\.com/);
  assert.match(body, /Existing mail-assistant connections were closed/);
  assert.match(body, /mcp_once_&lt;unsafe&gt;/);
  assert.match(body, /class="credential-token"/);
  assert.match(body, /Sign in normally/);
  assert.doesNotMatch(body, new RegExp(recoveryToken));
  assert.deepEqual(target.events, [
    "hash-password",
    "generate-mcp-token",
    "hash-mcp-token",
    "consume",
    "reconcile",
    "report-reconciliation",
  ]);
  assert.equal(target.consumeCount(), 1);
  assert.equal(target.reconcileCount(), 1);
  assert.equal(target.reports.length, 1);
  assert.deepEqual(target.reports[0], {
    actorUserId: "user-1",
    durationMs: target.reports[0]?.durationMs,
    status: "success",
    httpStatus: 200,
  });
  assert.ok((target.reports[0]?.durationMs ?? -1) >= 0);
});

test("any post-commit reconciliation failure returns truthful partial success", async () => {
  const privateFailure = new Error("rpc leaked infrastructure detail");
  privateFailure.name = "AgentRpcUnavailableError";
  const target = testApp({ reconciliationError: privateFailure });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 202);
  assert.match(body, /Your new credentials are active/);
  assert.match(body, /Connection cleanup is still finishing/);
  assert.match(body, /Cleanup will retry automatically/);
  assert.match(body, /Close any other portal tabs now/);
  assert.match(body, /Do not refresh or submit this recovery link again/);
  assert.match(body, /mcp_once_&lt;unsafe&gt;/);
  assert.doesNotMatch(body, /rpc leaked infrastructure detail/);
  assert.doesNotMatch(body, new RegExp(recoveryToken));
  assert.deepEqual(target.events, [
    "hash-password",
    "generate-mcp-token",
    "hash-mcp-token",
    "consume",
    "reconcile",
    "report-reconciliation",
  ]);
  assert.equal(target.consumeCount(), 1);
  assert.equal(target.reconcileCount(), 1);
  assert.equal(target.reports.length, 1);
  assert.deepEqual(target.reports[0], {
    actorUserId: "user-1",
    durationMs: target.reports[0]?.durationMs,
    status: "partial_success",
    httpStatus: 202,
    errorName: "AgentRpcUnavailableError",
  });
});

test("partial recovery without MCP issuance makes no token claim", async () => {
  const target = testApp({ reconciliationError: new Error("pending") });
  const response = await request(target.app, { createMcp: "" });
  const body = await response.text();

  assert.equal(response.status, 202);
  assert.match(body, /Connection cleanup is still finishing/);
  assert.doesNotMatch(body, /Copy your new MCP token now/);
  assert.doesNotMatch(body, /<code>/);
  assert.deepEqual(target.events, [
    "hash-password",
    "consume",
    "reconcile",
    "report-reconciliation",
  ]);
});

test("partial recovery reduces untrusted error names to bounded metadata", async () => {
  const privateFailure = new Error("secret error message");
  privateFailure.name = `Unsafe\n${recoveryToken}`;
  const target = testApp({ reconciliationError: privateFailure });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 202);
  assert.doesNotMatch(body, /secret error message/);
  assert.doesNotMatch(body, new RegExp(recoveryToken));
  assert.deepEqual(target.reports[0], {
    actorUserId: "user-1",
    durationMs: target.reports[0]?.durationMs,
    status: "partial_success",
    httpStatus: 202,
    errorName: "UnknownError",
  });
});

test("reporting failures cannot hide committed credentials or the one-time token", async () => {
  const target = testApp({
    reconciliationError: new Error("cleanup unavailable"),
    reportError: new Error("logging unavailable"),
  });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 202);
  assert.match(body, /Your new credentials are active/);
  assert.match(body, /Connection cleanup is still finishing/);
  assert.match(body, /mcp_once_&lt;unsafe&gt;/);
  assert.equal(target.consumeCount(), 1);
  assert.equal(target.reconcileCount(), 1);
  assert.equal(target.reports.length, 1);
});

test("invalid or consumed recovery links never start reconciliation", async () => {
  const target = testApp({ consumed: null });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 409);
  assert.match(body, /invalid, expired, or has already been used/);
  assert.doesNotMatch(body, new RegExp(generatedMcpToken));
  assert.equal(target.consumeCount(), 1);
  assert.equal(target.reconcileCount(), 0);
  assert.deepEqual(target.reports, []);
});

test("pre-commit failures remain failures and never claim recovery succeeded", async () => {
  const target = testApp({ consumeError: new Error("database unavailable") });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.equal(body, "Internal Server Error");
  assert.equal(target.consumeCount(), 1);
  assert.equal(target.reconcileCount(), 0);
  assert.deepEqual(target.reports, []);
});

test("recovery validation does not consume or reconcile malformed submissions", async () => {
  const target = testApp({});
  const response = await request(target.app, {
    password: "short",
    confirm: "different",
  });
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.match(body, /Passwords do not match/);
  assert.equal(target.consumeCount(), 0);
  assert.equal(target.reconcileCount(), 0);
});
