import type { Env } from "../types.ts";
import type {
  ConversationIntelligenceEvidenceMessage,
  ConversationIntelligenceEvidenceProjection,
} from "./conversation-intelligence-evidence.ts";
import {
  CONVERSATION_INTELLIGENCE_AI_CONFIG,
  buildConversationIntelligenceCacheKey,
  buildConversationIntelligencePrompt,
  fingerprintConversationIntelligenceInput,
  normalizeConversationIntelligenceInput,
  parseConversationIntelligenceResult,
  type ConversationIntelligenceResult,
  type ConversationIntelligenceAttachmentInput,
  type ConversationIntelligenceMessageInput,
  type NormalizedConversationIntelligenceInput,
} from "./conversation-intelligence.ts";
import {
  calculateAiUsageCostMicros,
  resolveAiCostControlConfig,
  type AiUsageDecision,
  type BeginAiUsageInput,
} from "./ai-cost-control.ts";
import {
  createAiCostController,
  getCachedAiResponse,
  putCachedAiResponse,
} from "./ai-cost-control-d1.ts";
import { storedAttachmentKey } from "./attachments.ts";
import { stripHtmlToText } from "./email-helpers.ts";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const MAX_ATTACHMENT_TEXT_READS = 10;

type EvidenceReaderStub = {
  getConversationIntelligenceEvidence(
    emailId: string,
  ): Promise<ConversationIntelligenceEvidenceProjection>;
};

export class ConversationIntelligenceNotFoundError extends Error {
  constructor() {
    super("Conversation was not found");
    this.name = "ConversationIntelligenceNotFoundError";
  }
}

export class ConversationIntelligenceUnsupportedStateError extends Error {
  readonly folderId: "draft" | "outbox";

  constructor(folderId: "draft" | "outbox") {
    super(
      "Conversation intelligence is unavailable for Drafts and Outbox messages.",
    );
    this.name = "ConversationIntelligenceUnsupportedStateError";
    this.folderId = folderId;
  }
}

function textAttachment(mimetype: string): boolean {
  const type = mimetype.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/csv"
  );
}

function recipients(email: ConversationIntelligenceEvidenceMessage): string[] {
  return [email.recipient, email.cc, email.bcc]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function gatherConversationIntelligenceEvidence(
  stub: EvidenceReaderStub,
  bucket: Pick<R2Bucket, "get">,
  emailId: string,
): Promise<NormalizedConversationIntelligenceInput> {
  const projected = await stub.getConversationIntelligenceEvidence(emailId);
  if (projected.state === "unsupported") {
    throw new ConversationIntelligenceUnsupportedStateError(projected.folderId);
  }
  if (projected.state === "not_found") {
    throw new ConversationIntelligenceNotFoundError();
  }

  let textReads = 0;
  const input: ConversationIntelligenceMessageInput[] = [];
  for (const message of projected.messages) {
    const attachments: ConversationIntelligenceAttachmentInput[] = [];
    for (const attachment of (message.attachments ?? []).slice(0, 5)) {
      let text = "";
      if (
        textReads < MAX_ATTACHMENT_TEXT_READS &&
        attachment.size <= MAX_ATTACHMENT_TEXT_BYTES &&
        textAttachment(attachment.mimetype)
      ) {
        textReads++;
        try {
          const object = await bucket.get(
            storedAttachmentKey({
              email_id: message.id,
              id: attachment.id,
              filename: attachment.filename,
              r2_key: attachment.r2Key,
            }),
          );
          text =
            object && object.size <= MAX_ATTACHMENT_TEXT_BYTES
              ? await object.text()
              : "";
        } catch {
          // Metadata remains useful; unavailable text never blocks analysis.
        }
      }
      attachments.push({
        filename: attachment.filename,
        mediaType: attachment.mimetype,
        text,
      });
    }
    input.push({
      id: message.id,
      sender: message.sender,
      recipients: recipients(message),
      sentAt: message.date,
      subject: message.subject,
      text: stripHtmlToText(message.body ?? ""),
      attachments,
    });
  }
  return normalizeConversationIntelligenceInput(input);
}

export type ConversationIntelligenceRuntimeResponse =
  | {
      state: "cached" | "generated";
      fingerprint: string;
      result: ConversationIntelligenceResult;
    }
  | { state: "budget_paused"; reason: string };

export interface ConversationIntelligenceRuntimeDependencies {
  readEvidence(
    emailId: string,
  ): Promise<NormalizedConversationIntelligenceInput>;
  getCached(cacheKey: string, mailboxId: string): Promise<unknown | null>;
  putCached(
    cacheKey: string,
    mailboxId: string,
    value: ConversationIntelligenceResult,
  ): Promise<void>;
  beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision>;
  startUsage(reservationId: string): Promise<boolean>;
  completeUsage(
    reservationId: string,
    actual: {
      actualCostMicros: number;
      promptTokens: number;
      completionTokens: number;
    },
  ): Promise<unknown>;
  failUsage(
    reservationId: string,
    failure?: {
      errorCode?: string;
      actualCostMicros?: number;
      promptTokens?: number;
      completionTokens?: number;
    },
  ): Promise<unknown>;
  runModel(
    model: string,
    prompt: { system: string; user: string },
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
  model?: string;
}

export async function runConversationIntelligence(
  dependencies: ConversationIntelligenceRuntimeDependencies,
  input: {
    mailboxId: string;
    actorUserId: string;
    emailId: string;
    force?: boolean;
  },
): Promise<ConversationIntelligenceRuntimeResponse> {
  const mailboxId = input.mailboxId.trim().toLowerCase();
  const evidence = await dependencies.readEvidence(input.emailId);
  const allowedMessageIds = new Set(
    evidence.messages.map((message) => message.id),
  );
  const fingerprint = await fingerprintConversationIntelligenceInput(evidence);
  const model = dependencies.model ?? "cheap-model";
  const cacheKey = await buildConversationIntelligenceCacheKey(evidence, {
    model,
    mailboxId,
  });

  if (!input.force) {
    const cached = await dependencies.getCached(cacheKey, mailboxId);
    if (cached !== null) {
      try {
        const result = parseConversationIntelligenceResult(
          JSON.stringify(cached),
          allowedMessageIds,
        );
        await dependencies.beginUsage({
          feature: CONVERSATION_INTELLIGENCE_AI_CONFIG.feature,
          actorUserId: input.actorUserId,
          mailboxId,
          requestedTier: "cheap",
          estimatedCostMicros:
            CONVERSATION_INTELLIGENCE_AI_CONFIG.estimatedCostMicros,
          cacheKey,
          cacheHit: true,
        });
        return { state: "cached", fingerprint, result };
      } catch {
        // Corrupt or obsolete cache entries are never served as intelligence.
      }
    }
  }

  const decision = await dependencies.beginUsage({
    feature: CONVERSATION_INTELLIGENCE_AI_CONFIG.feature,
    actorUserId: input.actorUserId,
    mailboxId,
    requestedTier: "cheap",
    estimatedCostMicros:
      CONVERSATION_INTELLIGENCE_AI_CONFIG.estimatedCostMicros,
    cacheKey,
    cacheHit: false,
  });
  if (decision.decision === "block" || !decision.reservationId) {
    return {
      state: "budget_paused",
      reason: decision.reason ?? "inference_unavailable",
    };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  try {
    if (!(await dependencies.startUsage(decision.reservationId))) {
      throw new Error("AI usage reservation could not be started");
    }
    const response = await dependencies.runModel(
      decision.model,
      buildConversationIntelligencePrompt(evidence),
    );
    promptTokens = response.promptTokens;
    completionTokens = response.completionTokens;
    let result: ConversationIntelligenceResult;
    try {
      result = parseConversationIntelligenceResult(
        response.text,
        allowedMessageIds,
      );
    } catch {
      throw new Error("The model returned invalid intelligence output");
    }
    const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
      promptTokens,
      completionTokens,
    });
    await dependencies.completeUsage(decision.reservationId, {
      actualCostMicros:
        actualCostMicros ||
        CONVERSATION_INTELLIGENCE_AI_CONFIG.estimatedCostMicros,
      promptTokens,
      completionTokens,
    });
    try {
      await dependencies.putCached(cacheKey, mailboxId, result);
    } catch {
      // The validated result remains usable; a cache outage must not turn a
      // completed, charged inference into a false provider failure.
    }
    return { state: "generated", fingerprint, result };
  } catch (error) {
    const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
      promptTokens,
      completionTokens,
    });
    await dependencies.failUsage(decision.reservationId, {
      errorCode:
        error instanceof Error && /invalid intelligence/i.test(error.message)
          ? "invalid_intelligence_output"
          : "conversation_intelligence_failed",
      ...(actualCostMicros > 0 ? { actualCostMicros } : {}),
      promptTokens,
      completionTokens,
    });
    throw error;
  }
}

export function createConversationIntelligenceRuntime(
  env: Env,
  stub: unknown,
): ConversationIntelligenceRuntimeDependencies {
  const config = resolveAiCostControlConfig(env);
  const cost = createAiCostController(env, config);
  return {
    model: config.cheapModel,
    readEvidence: (emailId) =>
      gatherConversationIntelligenceEvidence(
        stub as EvidenceReaderStub,
        env.BUCKET,
        emailId,
      ),
    getCached: (cacheKey, mailboxId) =>
      getCachedAiResponse(env, { cacheKey, mailboxId }),
    putCached: (cacheKey, mailboxId, value) =>
      putCachedAiResponse(env, {
        cacheKey,
        mailboxId,
        feature: CONVERSATION_INTELLIGENCE_AI_CONFIG.feature,
        value,
        ttlMs: CACHE_TTL_MS,
      }),
    beginUsage: (input) => cost.beginUsage(input),
    startUsage: (reservationId) => cost.startUsage(reservationId),
    completeUsage: (reservationId, actual) =>
      cost.completeUsage(reservationId, actual),
    failUsage: (reservationId, failure) =>
      cost.failUsage(reservationId, failure),
    runModel: async (model, prompt) => {
      const ai = env.AI as unknown as {
        run(model: string, input: Record<string, unknown>): Promise<unknown>;
      };
      const response = (await ai.run(model, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: CONVERSATION_INTELLIGENCE_AI_CONFIG.maxTokens,
        temperature: CONVERSATION_INTELLIGENCE_AI_CONFIG.temperature,
      })) as {
        response?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: (response.response ?? "").trim(),
        promptTokens: Math.max(
          0,
          Math.floor(response.usage?.prompt_tokens ?? 0),
        ),
        completionTokens: Math.max(
          0,
          Math.floor(response.usage?.completion_tokens ?? 0),
        ),
      };
    },
  };
}
