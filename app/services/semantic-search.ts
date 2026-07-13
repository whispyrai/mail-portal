import {
  parseSemanticSearchRequest,
  parseSemanticSearchResponse,
  type SemanticSearchResponse,
} from "../../shared/semantic-search.ts";
import { ApiError } from "./api.ts";

export type SearchSemanticEvidenceRequest = {
  query: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const SEMANTIC_SEARCH_TIMEOUT_MS = 25_000;

function safeSemanticSearchError(status: number): string {
  if (status === 401) return "Your session ended.";
  if (status === 403) return "Mailbox access changed.";
  if (status === 422)
    return "Meaning search cannot safely cover this Mailbox roster yet.";
  if (status === 429) return "Meaning search is busy. Try again in a moment.";
  if (status === 504) return "Meaning search took too long. Try again.";
  if (status === 503) return "Meaning search is temporarily unavailable.";
  return "Meaning search could not be completed.";
}

export async function searchSemanticEvidence(
  input: SearchSemanticEvidenceRequest,
): Promise<SemanticSearchResponse> {
  const request = parseSemanticSearchRequest({ query: input.query });
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? SEMANTIC_SEARCH_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch("/api/v1/semantic-search", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    body = await response.json().catch((error) => {
      if (timedOut) throw error;
      return null;
    });
  } catch (error) {
    if (timedOut) {
      throw new ApiError(504, { error: safeSemanticSearchError(504) });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
  if (!response.ok) {
    throw new ApiError(response.status, {
      error: safeSemanticSearchError(response.status),
    });
  }
  return parseSemanticSearchResponse(body);
}
