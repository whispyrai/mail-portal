import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationIntelligenceUnsupportedStateError,
  gatherConversationIntelligenceEvidence,
  runConversationIntelligence,
  type ConversationIntelligenceRuntimeDependencies,
} from "./conversation-intelligence-runtime.ts";

const validatedResult = {
  summary: { text: "A customer needs a reply.", messageIds: ["m1"] },
  priority: {
    level: "high" as const,
    rationale: "A deadline is stated.",
    messageIds: ["m1"],
  },
  category: {
    value: "action_required" as const,
    rationale: "The sender asked a question.",
    messageIds: ["m1"],
  },
  keyPoints: [{ text: "Reply by Friday.", messageIds: ["m1"] }],
  suggestedNextAction: {
    type: "reply" as const,
    text: "Draft a reply for human review.",
    messageIds: ["m1"],
    requiresHumanReview: true as const,
  },
  signals: {
    followUps: [{ text: "Reply by Friday.", messageIds: ["m1"] }],
    commitments: [],
  },
};

function harness(
  overrides: Partial<ConversationIntelligenceRuntimeDependencies> = {},
) {
  const calls = {
    provider: 0,
    begin: [] as Array<Record<string, unknown>>,
    started: 0,
    completed: 0,
    failed: 0,
    cached: 0,
  };
  const dependencies: ConversationIntelligenceRuntimeDependencies = {
    readEvidence: async () => ({
      version: 1,
      messages: [
        {
          id: "m1",
          sender: "client@example.com",
          recipients: ["team@example.com"],
          sentAt: "2026-07-11T10:00:00.000Z",
          subject: "Question",
          text: "Please reply by Friday.",
          attachments: [],
        },
      ],
    }),
    getCached: async () => null,
    putCached: async () => {
      calls.cached++;
    },
    beginUsage: async (input) => {
      calls.begin.push(input as Record<string, unknown>);
      return {
        decision: "allow",
        mode: "paid",
        tier: "cheap",
        model: "cheap-model",
        reservationId: "res-1",
        ledgerRecorded: true,
        reviewRequired: false,
      };
    },
    startUsage: async () => {
      calls.started++;
      return true;
    },
    completeUsage: async () => {
      calls.completed++;
    },
    failUsage: async () => {
      calls.failed++;
    },
    runModel: async () => {
      calls.provider++;
      return {
        text: JSON.stringify(validatedResult),
        promptTokens: 100,
        completionTokens: 50,
      };
    },
    ...overrides,
  };
  return { dependencies, calls };
}

test("evidence gathering follows the selected email's authoritative thread and bounds attachment text", async () => {
  const bucketReads: string[] = [];
  const result = await gatherConversationIntelligenceEvidence(
    {
      async getConversationIntelligenceEvidence() {
        return {
          state: "ready" as const,
          messages: [
          {
            id: "m1",
            sender: "a@example.com",
            recipient: "team@example.com",
            subject: "Start",
            body: "hello",
            date: "2026-07-10T10:00:00Z",
            attachments: [
              {
                id: "a1",
                filename: "notes.txt",
                mimetype: "text/plain",
                size: 20,
              },
              {
                id: "a2",
                filename: "metadata-lied.txt",
                mimetype: "text/plain",
                size: 20,
              },
            ],
          },
          {
            id: "m2",
            sender: "b@example.com",
            recipient: "team@example.com",
            subject: "Re",
            body: "latest",
            date: "2026-07-11T11:00:00Z",
            attachments: [],
          },
        ],
        };
      },
    },
    {
      async get(key: string) {
        bucketReads.push(key);
        if (key.includes("metadata-lied")) {
          return {
            size: 64 * 1024 + 1,
            text: async () => {
              throw new Error("oversized object must not be materialized");
            },
          };
        }
        return { size: 19, text: async () => "attachment evidence" };
      },
    } as never,
    "m2",
  );

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["m1", "m2"],
  );
  assert.equal(
    result.messages[0]?.attachments.find(
      (attachment) => attachment.filename === "notes.txt",
    )?.text,
    "attachment evidence",
  );
  assert.equal(
    result.messages[0]?.attachments.find(
      (attachment) => attachment.filename === "metadata-lied.txt",
    )?.text,
    "",
  );
  assert.deepEqual(bucketReads, [
    "attachments/m1/a1/notes.txt",
    "attachments/m1/a2/metadata-lied.txt",
  ]);
});

test("selected Draft and Outbox messages explicitly reject intelligence before reading attachments", async () => {
  for (const folderId of ["draft", "outbox"] as const) {
    let bucketReads = 0;
    await assert.rejects(
      () =>
        gatherConversationIntelligenceEvidence(
          {
            async getConversationIntelligenceEvidence() {
              return { state: "unsupported" as const, folderId };
            },
          },
          {
            async get() {
              bucketReads++;
              return null;
            },
          } as never,
          "selected",
        ),
      (error: unknown) =>
        error instanceof ConversationIntelligenceUnsupportedStateError &&
        error.folderId === folderId,
    );
    assert.equal(bucketReads, 0);
  }
});

test("a validated mailbox-scoped cache hit returns without provider inference", async () => {
  const { dependencies, calls } = harness({
    getCached: async () => validatedResult,
    beginUsage: async (input) => {
      calls.begin.push(input as Record<string, unknown>);
      return {
        decision: "allow",
        mode: "cached",
        tier: "cheap",
        model: "cheap-model",
        ledgerRecorded: true,
        reviewRequired: false,
      };
    },
  });
  const response = await runConversationIntelligence(dependencies, {
    mailboxId: "team@example.com",
    actorUserId: "usr-1",
    emailId: "m1",
  });

  assert.equal(response.state, "cached");
  assert.equal(calls.provider, 0);
  assert.equal(calls.begin[0]?.cacheHit, true);
  assert.equal(calls.begin[0]?.mailboxId, "team@example.com");
});

test("a cache miss reserves cheap inference, validates output, reconciles cost, and caches only the result", async () => {
  let stored: unknown;
  const { dependencies, calls } = harness({
    putCached: async (_key, _mailboxId, value) => {
      stored = value;
      calls.cached++;
    },
  });
  const response = await runConversationIntelligence(dependencies, {
    mailboxId: "team@example.com",
    actorUserId: "usr-1",
    emailId: "m1",
    force: true,
  });

  assert.equal(response.state, "generated");
  assert.equal(calls.provider, 1);
  assert.equal(calls.started, 1);
  assert.equal(calls.completed, 1);
  assert.equal(calls.failed, 0);
  assert.deepEqual(stored, validatedResult);
  assert.equal(calls.begin[0]?.requestedTier, "cheap");
  assert.equal(calls.begin[0]?.feature, "conversation_intelligence");
});

test("a cache write outage does not discard already validated and reconciled intelligence", async () => {
  const { dependencies, calls } = harness({
    putCached: async () => {
      throw new Error("D1 unavailable");
    },
  });
  const response = await runConversationIntelligence(dependencies, {
    mailboxId: "team@example.com",
    actorUserId: "usr-1",
    emailId: "m1",
  });
  assert.equal(response.state, "generated");
  assert.equal(calls.completed, 1);
  assert.equal(calls.failed, 0);
});

test("budget pauses and invalid model output never cache or imply mailbox actions", async () => {
  const paused = harness({
    beginUsage: async () => ({
      decision: "block",
      reason: "admin_review_required",
      reviewRequired: true,
      fallback: "deterministic_only",
      ledgerRecorded: true,
    }),
  });
  const pausedResponse = await runConversationIntelligence(
    paused.dependencies,
    {
      mailboxId: "team@example.com",
      actorUserId: "usr-1",
      emailId: "m1",
    },
  );
  assert.deepEqual(pausedResponse, {
    state: "budget_paused",
    reason: "admin_review_required",
  });
  assert.equal(paused.calls.provider, 0);

  const invalid = harness({
    runModel: async () => ({
      text: "not-json",
      promptTokens: 5,
      completionTokens: 2,
    }),
  });
  await assert.rejects(
    () =>
      runConversationIntelligence(invalid.dependencies, {
        mailboxId: "team@example.com",
        actorUserId: "usr-1",
        emailId: "m1",
      }),
    /invalid intelligence/i,
  );
  assert.equal(invalid.calls.failed, 1);
  assert.equal(invalid.calls.cached, 0);
});
