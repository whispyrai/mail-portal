export type IntelligenceCitations = { messageIds: string[] };
export type IntelligenceEvidence = IntelligenceCitations & { text: string };

export type ConversationIntelligenceResult = {
  summary: IntelligenceEvidence;
  priority: IntelligenceCitations & {
    level: "low" | "normal" | "high" | "urgent";
    rationale: string;
  };
  category: IntelligenceCitations & {
    value:
      | "action_required"
      | "waiting_on_us"
      | "waiting_on_them"
      | "scheduling"
      | "finance"
      | "support"
      | "sales"
      | "informational"
      | "other";
    rationale: string;
  };
  keyPoints: IntelligenceEvidence[];
  suggestedNextAction: IntelligenceEvidence & {
    type:
      | "reply"
      | "follow_up"
      | "schedule"
      | "review"
      | "archive"
      | "escalate"
      | "no_action";
    requiresHumanReview: true;
  };
  signals: {
    followUps: Array<IntelligenceEvidence & { dueAt?: string }>;
    commitments: Array<
      IntelligenceEvidence & { actor: string; dueAt?: string }
    >;
  };
};

export type ConversationIntelligenceResponse =
  | {
      state: "cached" | "generated";
      fingerprint: string;
      result: ConversationIntelligenceResult;
    }
  | { state: "budget_paused"; reason: string };

export class ConversationIntelligenceApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConversationIntelligenceApiError";
    this.status = status;
  }
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchConversationIntelligence(
  mailboxId: string,
  emailId: string,
  refresh = false,
  fetcher: FetchLike = fetch,
): Promise<ConversationIntelligenceResponse> {
  const response = await fetcher(
    `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/intelligence`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ConversationIntelligenceApiError(
      response.status,
      body.error ?? "Conversation intelligence is unavailable",
    );
  }
  return response.json() as Promise<ConversationIntelligenceResponse>;
}
