import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../types.ts";
import {
  CREDENTIAL_RECOVERY_DELIVERY_LIMITS,
  dispatchCredentialRecoveryPreparedSend,
  drainCredentialRecoveryDeliveries,
  type CredentialRecoveryDeliveryPayload,
  type LeasedCredentialRecoveryDelivery,
} from "./credential-recovery-delivery-outbox.ts";
import { CredentialRecoveryKeyUnavailableError } from "./credential-recovery-crypto.ts";
import type { SesObservedOutcome } from "./outbound-delivery-contract.ts";

const delivery: LeasedCredentialRecoveryDelivery = {
  id: "delivery-1",
  tokenId: "token-1",
  leaseToken: "lease-1",
  attemptCount: 0,
  encrypted: { keyVersion: 1, iv: "iv", ciphertext: "ciphertext" },
};

const payload: CredentialRecoveryDeliveryPayload = {
  to: "owner@personal.example",
  loginEmail: "member@wiserchat.ai",
  recoveryUrl: "https://mail.wiserchat.ai/account/recover?token=raw-secret",
  expiresAt: 86_401_000,
};

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function captureDeliveryLogs<T>(operation: () => Promise<T>) {
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    return { result: await operation(), logs };
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
}

function deliveryTransitions(logs: unknown[][]) {
  return logs
    .map((entry) => entry[1])
    .filter(
      (
        entry,
      ): entry is {
        operation: string;
        phase: string;
        outcome: string;
        errorCode?: string;
        errorName?: string;
        ambiguous?: boolean;
      } =>
        typeof entry === "object" &&
        entry !== null &&
        "operation" in entry &&
        entry.operation === "credential_recovery_delivery",
    );
}

test("a hanging provider is actively aborted before the dispatch lease can overlap", async () => {
  let observedSignal: AbortSignal | undefined;
  const startedAt = performance.now();
  const outcome = await dispatchCredentialRecoveryPreparedSend(
    {
      dispatch(signal) {
        observedSignal = signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    },
    10,
  );
  assert.equal(outcome.kind, "transport_ambiguous");
  assert.equal(observedSignal?.aborted, true);
  assert.ok(performance.now() - startedAt < 1_000);
  assert.ok(
    CREDENTIAL_RECOVERY_DELIVERY_LIMITS.providerTimeoutMs <
      CREDENTIAL_RECOVERY_DELIVERY_LIMITS.dispatchLeaseMs,
  );
});

function dependencies(
  outcome: SesObservedOutcome,
  events: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    now: () => 1_000,
    async lease() {
      return [delivery];
    },
    async preflight() {
      events.push("preflight");
      return "ready" as const;
    },
    async decrypt() {
      events.push("decrypt");
      return payload;
    },
    async fence() {
      events.push("fence");
      return true;
    },
    async send() {
      events.push("send");
      return outcome;
    },
    async markDelivered() {
      events.push("delivered");
      return true;
    },
    async retry(_env: Env, _delivery: unknown, errorCode: string) {
      events.push(`retry:${errorCode}`);
      return true;
    },
    async park() {
      events.push("park");
      return true;
    },
    ...overrides,
  };
}

test("provider acceptance becomes durable delivered state", async () => {
  const events: string[] = [];
  const result = await drainCredentialRecoveryDeliveries(
    {} as Env,
    dependencies({ kind: "accepted", messageId: "ses-message-1" }, events),
  );
  assert.deepEqual(result, {
    acceptedCount: 1,
    failedCount: 0,
    hasMore: false,
  });
  assert.deepEqual(events, [
    "preflight",
    "decrypt",
    "fence",
    "send",
    "delivered",
  ]);
});

for (const [outcome, errorCode] of [
  [{ kind: "not_dispatched", detail: "safe" }, "SES_NOT_DISPATCHED"],
  [{ kind: "http_error", status: 503 }, "SES_HTTP_503"],
  [{ kind: "invalid_success_response" }, "SES_INVALID_SUCCESS_RESPONSE"],
  [{ kind: "transport_ambiguous", detail: "safe" }, "SES_TRANSPORT_AMBIGUOUS"],
] satisfies Array<[SesObservedOutcome, string]>) {
  test(`${outcome.kind} remains durably retryable`, async () => {
    const events: string[] = [];
    const result = await drainCredentialRecoveryDeliveries(
      {} as Env,
      dependencies(outcome, events),
    );
    assert.equal(result.acceptedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(events, [
      "preflight",
      "decrypt",
      "fence",
      "send",
      `retry:${errorCode}`,
    ]);
  });
}

test("provider acceptance followed by completion failure leaves the lease recoverable", async () => {
  const events: string[] = [];
  const result = await drainCredentialRecoveryDeliveries(
    {} as Env,
    dependencies(
      { kind: "accepted", messageId: "ses-message-1" },
      events,
      {
        async markDelivered() {
          events.push("completion-failed");
          throw new Error("D1 unavailable after acceptance");
        },
      },
    ),
  );
  assert.deepEqual(result, {
    acceptedCount: 0,
    failedCount: 1,
    hasMore: false,
  });
  assert.deepEqual(events, [
    "preflight",
    "decrypt",
    "fence",
    "send",
    "completion-failed",
  ]);
});

test("expired or consumed tokens are never dispatched", async () => {
  const events: string[] = [];
  const result = await drainCredentialRecoveryDeliveries(
    {} as Env,
    dependencies(
      { kind: "accepted", messageId: "must-not-send" },
      events,
      {
        async preflight() {
          events.push("terminal");
          return "terminal";
        },
      },
    ),
  );
  assert.deepEqual(result, {
    acceptedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.deepEqual(events, ["terminal"]);
});

test("consume or supersede after preflight wins the final dispatch fence", async () => {
  const events: string[] = [];
  const result = await drainCredentialRecoveryDeliveries(
    {} as Env,
    dependencies(
      { kind: "accepted", messageId: "must-not-send" },
      events,
      {
        async decrypt() {
          events.push("decrypt-then-cancel");
          return payload;
        },
        async fence() {
          events.push("fence-cancelled");
          return false;
        },
      },
    ),
  );
  assert.deepEqual(result, {
    acceptedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.deepEqual(events, [
    "preflight",
    "decrypt-then-cancel",
    "fence-cancelled",
  ]);
});

test("permanent payload corruption parks without dispatch", async () => {
  const events: string[] = [];
  const result = await drainCredentialRecoveryDeliveries(
    {} as Env,
    dependencies(
      { kind: "accepted", messageId: "must-not-send" },
      events,
      {
        async decrypt() {
          events.push("decrypt-failed");
          throw new Error("authenticated decryption failed");
        },
      },
    ),
  );
  assert.equal(result.failedCount, 1);
  assert.deepEqual(events, ["preflight", "decrypt-failed", "park"]);
});

test("a slow first provider call cannot starve the preleased batch tail", async () => {
  const secondDelivery: LeasedCredentialRecoveryDelivery = {
    ...delivery,
    id: "delivery-2",
    tokenId: "token-2",
    leaseToken: "lease-2",
  };
  const releaseFirst = deferred<void>();
  const secondAccepted = deferred<void>();
  const firstPayload = { ...payload, loginEmail: "first@wiserchat.ai" };
  const secondPayload = { ...payload, loginEmail: "second@wiserchat.ai" };

  const drain = drainCredentialRecoveryDeliveries({} as Env, {
    now: () => 1_000,
    async lease() {
      return [delivery, secondDelivery];
    },
    async preflight() {
      return "ready";
    },
    async decrypt(_env, current) {
      return current.id === delivery.id ? firstPayload : secondPayload;
    },
    async fence() {
      return true;
    },
    async send(_env, currentPayload) {
      if (currentPayload.loginEmail === firstPayload.loginEmail) {
        await releaseFirst.promise;
        return { kind: "accepted", messageId: "first-message" };
      }
      return { kind: "accepted", messageId: "second-message" };
    },
    async markDelivered(_env, current) {
      if (current.id === secondDelivery.id) secondAccepted.resolve();
      return true;
    },
    async retry() {
      return true;
    },
    async park() {
      return true;
    },
  });

  let starvationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secondAccepted.promise,
      new Promise<never>((_resolve, reject) => {
        starvationTimer = setTimeout(
          () => reject(new Error("preleased batch tail was starved")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (starvationTimer) clearTimeout(starvationTimer);
    releaseFirst.resolve();
  }
  assert.deepEqual(await drain, {
    acceptedCount: 2,
    failedCount: 0,
    hasMore: false,
  });
});

test("delivery drain logs are structured and exclude private correlation values", async () => {
  const privateDelivery: LeasedCredentialRecoveryDelivery = {
    ...delivery,
    id: "private-delivery-id",
    tokenId: "private-token-id",
    leaseToken: "private-attempt-id",
  };
  const privatePayload = {
    ...payload,
    recoveryUrl:
      "https://mail.wiserchat.ai/account/recover?token=private-raw-token",
  };
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    assert.deepEqual(
      await drainCredentialRecoveryDeliveries(
        {} as Env,
        dependencies(
          { kind: "accepted", messageId: "private-provider-message-id" },
          [],
          {
            async lease() {
              return [privateDelivery];
            },
            async decrypt() {
              return privatePayload;
            },
          },
        ),
      ),
      {
        acceptedCount: 1,
        failedCount: 0,
        hasMore: false,
      },
    );
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  const serialized = JSON.stringify(logs);
  for (const privateValue of [
    privateDelivery.id,
    privateDelivery.tokenId,
    privateDelivery.leaseToken,
    "private-raw-token",
    "private-provider-message-id",
    privatePayload.to,
    privatePayload.loginEmail,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue));
  }
  assert.match(serialized, /credential_recovery_delivery_drain/);
  assert.match(serialized, /"acceptedCount":1/);
  assert.match(serialized, /"failedCount":0/);
});

test("every delivery failure phase emits actionable privacy-safe telemetry", async () => {
  const privateErrorText =
    "owner@personal.example private-delivery-id private-raw-token";
  const privateErrorName = "PrivateSecretValue";
  const scenarios: Array<{
    name: string;
    overrides: Record<string, unknown>;
    expected: Array<Partial<ReturnType<typeof deliveryTransitions>[number]>>;
  }> = [
    {
      name: "preflight exception",
      overrides: {
        async preflight() {
          throw new TypeError(privateErrorText);
        },
      },
      expected: [
        { phase: "preflight", outcome: "failed", errorName: "TypeError" },
      ],
    },
    {
      name: "private identifier-shaped error name",
      overrides: {
        async preflight() {
          const error = new Error("safe message");
          error.name = privateErrorName;
          throw error;
        },
      },
      expected: [
        { phase: "preflight", outcome: "failed", errorName: "UnknownError" },
      ],
    },
    {
      name: "payload key retry settlement lost",
      overrides: {
        async decrypt() {
          throw new CredentialRecoveryKeyUnavailableError();
        },
        async resolve() {
          return false;
        },
      },
      expected: [
        {
          phase: "settlement",
          outcome: "lost",
          errorCode: "PAYLOAD_KEY_UNAVAILABLE",
          errorName: "CredentialRecoveryKeyUnavailableError",
        },
      ],
    },
    {
      name: "payload key retry settlement exception",
      overrides: {
        async decrypt() {
          throw new CredentialRecoveryKeyUnavailableError();
        },
        async resolve() {
          throw new RangeError(privateErrorText);
        },
      },
      expected: [
        {
          phase: "settlement",
          outcome: "failed",
          errorCode: "PAYLOAD_KEY_UNAVAILABLE",
          errorName: "RangeError",
        },
      ],
    },
    {
      name: "payload corruption park exception",
      overrides: {
        async decrypt() {
          throw new Error(privateErrorText);
        },
        async park() {
          throw new SyntaxError(privateErrorText);
        },
      },
      expected: [
        {
          phase: "park",
          outcome: "failed",
          errorCode: "PAYLOAD_CORRUPT",
          errorName: "SyntaxError",
        },
      ],
    },
    {
      name: "prepare exception then retry",
      overrides: {
        async prepare() {
          throw new EvalError(privateErrorText);
        },
        async resolve() {
          return true;
        },
      },
      expected: [
        {
          phase: "prepare",
          outcome: "failed",
          errorCode: "SES_NOT_DISPATCHED",
          errorName: "EvalError",
        },
        {
          phase: "settlement",
          outcome: "retry_scheduled",
          errorCode: "SES_NOT_DISPATCHED",
        },
      ],
    },
    {
      name: "prepare settlement exception",
      overrides: {
        async prepare() {
          return { kind: "not_dispatched" as const };
        },
        async resolve() {
          throw new URIError(privateErrorText);
        },
      },
      expected: [
        {
          phase: "settlement",
          outcome: "failed",
          errorCode: "SES_NOT_DISPATCHED",
          errorName: "URIError",
        },
      ],
    },
    {
      name: "dispatch fence lost",
      overrides: {
        async fence() {
          return "lost" as const;
        },
      },
      expected: [{ phase: "fence", outcome: "lost" }],
    },
    {
      name: "dispatch fence exception",
      overrides: {
        async fence() {
          throw new AggregateError([], privateErrorText);
        },
      },
      expected: [
        { phase: "fence", outcome: "failed", errorName: "AggregateError" },
      ],
    },
    {
      name: "dispatch exception remains ambiguous",
      overrides: {
        async send() {
          throw new ReferenceError(privateErrorText);
        },
        async resolve() {
          return true;
        },
      },
      expected: [
        {
          phase: "dispatch",
          outcome: "ambiguous",
          errorCode: "SES_TRANSPORT_AMBIGUOUS",
          errorName: "ReferenceError",
          ambiguous: true,
        },
        {
          phase: "settlement",
          outcome: "retry_scheduled",
          errorCode: "SES_TRANSPORT_AMBIGUOUS",
          ambiguous: true,
        },
      ],
    },
    {
      name: "provider acceptance commit lost",
      overrides: {
        async markDelivered() {
          return false;
        },
      },
      expected: [{ phase: "commit", outcome: "lost" }],
    },
    {
      name: "provider acceptance commit exception",
      overrides: {
        async markDelivered() {
          throw new Error(privateErrorText);
        },
      },
      expected: [
        { phase: "commit", outcome: "failed", errorName: "Error" },
      ],
    },
    {
      name: "provider rejection settlement lost",
      overrides: {
        async resolve() {
          return false;
        },
      },
      expected: [
        {
          phase: "settlement",
          outcome: "lost",
          errorCode: "SES_HTTP_503",
          ambiguous: false,
        },
      ],
    },
    {
      name: "provider rejection settlement exception",
      overrides: {
        async resolve() {
          throw new TypeError(privateErrorText);
        },
      },
      expected: [
        {
          phase: "settlement",
          outcome: "failed",
          errorCode: "SES_HTTP_503",
          errorName: "TypeError",
          ambiguous: false,
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    const baseOutcome: SesObservedOutcome =
      scenario.name.startsWith("provider rejection")
        ? { kind: "http_error", status: 503 }
        : { kind: "accepted", messageId: "private-provider-message-id" };
    const { logs } = await captureDeliveryLogs(() =>
      drainCredentialRecoveryDeliveries(
        {} as Env,
        dependencies(baseOutcome, [], scenario.overrides),
      ),
    );
    const transitions = deliveryTransitions(logs);
    for (const expected of scenario.expected) {
      assert.ok(
        transitions.some((transition) =>
          Object.entries(expected).every(
            ([key, value]) =>
              transition[key as keyof typeof transition] === value,
          ),
        ),
        `${scenario.name}: missing ${JSON.stringify(expected)} in ${JSON.stringify(transitions)}`,
      );
    }
    assert.doesNotMatch(JSON.stringify(logs), /owner@personal|private-|raw-token/);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(privateErrorName));
  }
});
