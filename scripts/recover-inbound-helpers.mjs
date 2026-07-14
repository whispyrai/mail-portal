export async function fetchWithTimeout(
  fetchImplementation,
  url,
  options,
  timeoutMs,
) {
  return fetchImplementation(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function recoveryCompletionMessage(responseBody) {
  if (responseBody.status !== "skipped") {
    return "Recovery complete: the archived message was restored";
  }
  const reason =
    typeof responseBody.reason === "string" && responseBody.reason.length > 0
      ? responseBody.reason
      : "unknown";
  return `Recovery complete: no projection was written (${reason})`;
}
