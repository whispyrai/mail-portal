import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { privateNoStore } from "../lib/response-privacy.ts";
import type { Env } from "../types.ts";
import {
  createCredentialRecoveryPage,
  createCredentialRecoveryHandler,
  createCredentialRecoveryRequestPage,
  createCredentialRecoveryRequestHandler,
  credentialRecoveryPage,
  credentialRecoveryRequestPage,
  handleCredentialRecovery,
  handleCredentialRecoveryRequest,
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
    async isEnabled() {
      return true;
    },
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
  overrides: Record<string, string | undefined> = {},
) {
  const body = new URLSearchParams({
    token: recoveryToken,
    password,
    confirm: password,
    createMcp: "yes",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) body.delete(name);
    else body.set(name, value);
  }
  return app.request(
    "http://mail.wiserchat.ai/account/recover",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
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

test("all four public recovery routes fail closed before request parsing or recovery work", async () => {
  const calls: string[] = [];
  const isEnabled = async () => {
    calls.push("control");
    return false;
  };
  const app = new Hono<{ Bindings: Env }>();
  app.get("/account/recover", createCredentialRecoveryPage(isEnabled));
  app.get(
    "/account/recover/request",
    createCredentialRecoveryRequestPage(isEnabled),
  );
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      isEnabled,
      async enqueue() {
        calls.push("enqueue");
        return { kind: "queued" };
      },
      async runMaintenance() {
        calls.push("maintenance");
      },
    }),
  );
  app.post(
    "/account/recover",
    createCredentialRecoveryHandler({
      isEnabled,
      async hashPassword() {
        calls.push("hash-password");
        return { hash: "hash", salt: "salt" };
      },
      generateMcpToken() {
        calls.push("generate-token");
        return "token";
      },
      async hashToken() {
        calls.push("hash-token");
        return "hash";
      },
      async consume() {
        calls.push("consume");
        return null;
      },
      async reconcileAgentConnections() {
        calls.push("reconcile");
      },
      reportAgentReconciliation() {
        calls.push("report");
      },
    }),
  );

  const requests = [
    new Request(
      `https://mail.wiserchat.ai/account/recover?token=${recoveryToken}`,
    ),
    new Request("https://mail.wiserchat.ai/account/recover/request"),
    new Request("https://mail.wiserchat.ai/account/recover/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "this=%C0%AF&body=must-not-be-parsed",
    }),
    new Request("https://mail.wiserchat.ai/account/recover", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${recoveryToken}&password=${password}`,
    }),
  ];
  for (const request of requests) {
    const response = await app.request(request, { BRAND: "wiser" } as Env);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(body, /temporarily unavailable/i);
    assert.doesNotMatch(body, new RegExp(recoveryToken));
  }
  assert.deepEqual(calls, ["control", "control", "control", "control"]);
});

test("all four production recovery routes stay disabled before migration 0012 exists", async () => {
  let prepareCalls = 0;
  const env = {
    BRAND: "whispyr",
    DB: {
      prepare() {
        prepareCalls += 1;
        throw new Error("no such table: credential_recovery_control");
      },
    },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.get("/account/recover", credentialRecoveryPage);
  app.get("/account/recover/request", credentialRecoveryRequestPage);
  app.post("/account/recover", handleCredentialRecovery);
  app.post("/account/recover/request", handleCredentialRecoveryRequest);

  for (const [path, method] of [
    ["/account/recover?token=must-not-reflect", "GET"],
    ["/account/recover/request", "GET"],
    ["/account/recover", "POST"],
    ["/account/recover/request", "POST"],
  ] as const) {
    const response = await app.request(
      `https://mail.whispyrcrm.com${path}`,
      {
        method,
        ...(method === "POST"
          ? {
              headers: {
                "content-type": "application/x-www-form-urlencoded",
              },
              body: "malformed=%C0%AF",
            }
          : {}),
      },
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(await response.text(), /must-not-reflect|no such table/);
  }
  assert.equal(prepareCalls, 4);
});

test("public recovery acknowledges only after durable enqueue and uses waitUntil only for draining", async () => {
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  const app = new Hono<{ Bindings: Env }>();
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      async isEnabled() {
        return true;
      },
      async enqueue(_env, input) {
        events.push(`enqueue:${input.email}:${input.ip}`);
        return { kind: "queued" };
      },
      async runMaintenance() {
        events.push("maintenance");
      },
    }),
  );
  const response = await app.fetch(
    new Request("https://attacker.example/account/recover/request", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: new URLSearchParams({ email: "member@wiserchat.ai" }),
    }),
    { BRAND: "wiser" } as Env,
    {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
  );

  assert.equal(response.status, 202);
  assert.match(await response.text(), /If the account is eligible/);
  assert.deepEqual(events, [
    "enqueue:member@wiserchat.ai:203.0.113.9",
    "maintenance",
  ]);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
});

test("public recovery returns a generic retryable 503 when durable enqueue fails", async () => {
  let maintenanceCalls = 0;
  const app = new Hono<{ Bindings: Env }>();
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      async isEnabled() {
        return true;
      },
      async enqueue() {
        throw new Error("private database detail");
      },
      async runMaintenance() {
        maintenanceCalls += 1;
      },
    }),
  );
  const response = await app.fetch(
    new Request("https://mail.wiserchat.ai/account/recover/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "member@wiserchat.ai" }),
    }),
    { BRAND: "wiser" } as Env,
    {
      waitUntil() {
        throw new Error("waitUntil must not run before enqueue");
      },
      passThroughOnException() {},
      props: {},
    },
  );
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /temporarily unavailable/i);
  assert.doesNotMatch(body, /database detail|member@wiserchat/i);
  assert.equal(maintenanceCalls, 0);
});

test("throwing waitUntil cannot rewrite a committed recovery enqueue into an error", async () => {
  let enqueued = false;
  const app = new Hono<{ Bindings: Env }>();
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      async isEnabled() {
        return true;
      },
      async enqueue() {
        enqueued = true;
        return { kind: "queued" };
      },
      async runMaintenance() {},
    }),
  );
  const response = await app.fetch(
    new Request("https://mail.wiserchat.ai/account/recover/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "member@wiserchat.ai" }),
    }),
    { BRAND: "wiser" } as Env,
    {
      waitUntil() {
        throw new Error("runtime rejected scheduling after commit");
      },
      passThroughOnException() {},
      props: {},
    },
  );
  assert.equal(enqueued, true);
  assert.equal(response.status, 202);
  assert.match(await response.text(), /If the account is eligible/);
});

test("oversized public recovery bodies are suppressed before enqueue", async () => {
  let enqueueCalls = 0;
  const app = new Hono<{ Bindings: Env }>();
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      async isEnabled() {
        return true;
      },
      async enqueue() {
        enqueueCalls += 1;
        return { kind: "queued" };
      },
      async runMaintenance() {},
    }),
  );
  const response = await app.request(
    "https://mail.wiserchat.ai/account/recover/request",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `email=${"a".repeat(2_000)}`,
    },
    { BRAND: "wiser" } as Env,
  );
  assert.equal(response.status, 202);
  assert.equal(enqueueCalls, 0);
});

test("public recovery accepts a valid form split across stream chunks", async () => {
  const enqueued: string[] = [];
  const app = new Hono<{ Bindings: Env }>();
  app.post(
    "/account/recover/request",
    createCredentialRecoveryRequestHandler({
      async isEnabled() {
        return true;
      },
      async enqueue(_env, input) {
        enqueued.push(input.email);
        return { kind: "suppressed" };
      },
      async runMaintenance() {},
    }),
  );
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("email=member%40"));
      controller.enqueue(encoder.encode("wiserchat.ai"));
      controller.close();
    },
  });
  const response = await app.fetch(
    new Request("https://mail.wiserchat.ai/account/recover/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    { BRAND: "wiser" } as Env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(enqueued, ["member@wiserchat.ai"]);
});

test("duplicate, extra, and invalidly encoded public fields never enqueue", async () => {
  for (const body of [
    "email=one%40wiserchat.ai&email=two%40wiserchat.ai",
    "email=member%40wiserchat.ai&role=ADMIN",
    "email=%C0%AF",
    "email=member%40wiserchat.ai&__proto__=hostile",
    "email=member%40wiserchat.ai&constructor=hostile",
    "email=member%40wiserchat.ai&toString=hostile",
  ]) {
    let enqueueCalls = 0;
    const app = new Hono<{ Bindings: Env }>();
    app.post(
      "/account/recover/request",
      createCredentialRecoveryRequestHandler({
        async isEnabled() {
          return true;
        },
        async enqueue() {
          enqueueCalls += 1;
          return { kind: "queued" };
        },
        async runMaintenance() {},
      }),
    );
    const response = await app.request(
      "https://mail.wiserchat.ai/account/recover/request",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      { BRAND: "wiser" } as Env,
    );
    assert.equal(response.status, 202);
    assert.equal(enqueueCalls, 0);
  }
});

test("queued and intentionally suppressed recovery requests are response-indistinguishable", async () => {
  const responses: Array<{ status: number; body: string }> = [];
  for (const kind of ["queued", "suppressed"] as const) {
    const app = new Hono<{ Bindings: Env }>();
    app.post(
      "/account/recover/request",
      createCredentialRecoveryRequestHandler({
        async isEnabled() {
          return true;
        },
        async enqueue() {
          return { kind };
        },
        async runMaintenance() {},
      }),
    );
    const response = await app.fetch(
      new Request("https://mail.wiserchat.ai/account/recover/request", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "same-shape@wiserchat.ai" }),
      }),
      { BRAND: "wiser" } as Env,
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );
    responses.push({ status: response.status, body: await response.text() });
  }
  assert.deepEqual(responses[0], responses[1]);
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
  const response = await request(target.app, { createMcp: undefined });
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

test("consume rejects duplicate, extra, and over-bound fields before password work", async () => {
  const invalidBodies = [
    new URLSearchParams([
      ["token", recoveryToken],
      ["token", recoveryToken],
      ["password", password],
      ["confirm", password],
    ]).toString(),
    new URLSearchParams({
      token: recoveryToken,
      password,
      confirm: password,
      role: "ADMIN",
    }).toString(),
    new URLSearchParams({
      token: recoveryToken,
      password: "p".repeat(1_025),
      confirm: "p".repeat(1_025),
    }).toString(),
    `token=${recoveryToken}&password=${"p".repeat(9_000)}&confirm=${password}`,
    `token=${recoveryToken}&password=${password}&confirm=${password}&__proto__=hostile`,
    `token=${recoveryToken}&password=${password}&confirm=${password}&constructor=hostile`,
    `token=${recoveryToken}&password=${password}&confirm=${password}&toString=hostile`,
  ];
  for (const body of invalidBodies) {
    const target = testApp({});
    const response = await target.app.request(
      "http://mail.wiserchat.ai/account/recover",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      { JWT_SECRET: "test-secret", BRAND: "wiser" } as Env,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(target.events, []);
    assert.equal(target.consumeCount(), 0);
  }
});

test("partial recovery reduces untrusted error names to bounded metadata", async () => {
  const privateFailure = new Error("secret error message");
  privateFailure.name = "PrivateSecretValue";
  const target = testApp({ reconciliationError: privateFailure });
  const response = await request(target.app);
  const body = await response.text();

  assert.equal(response.status, 202);
  assert.doesNotMatch(body, /secret error message/);
  assert.doesNotMatch(body, new RegExp(recoveryToken));
  assert.doesNotMatch(body, /PrivateSecretValue/);
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
