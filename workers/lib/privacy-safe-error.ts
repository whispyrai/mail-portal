const RECOVERY_TELEMETRY_ERROR_NAMES = new Set([
  "AbortError",
  "AgentConnectionReconciliationError",
  "AgentRpcUnavailableError",
  "AggregateError",
  "AiCacheRetentionBacklogError",
  "CredentialRecoveryKeyUnavailableError",
  "CredentialRecoveryKeyVersionError",
  "CredentialRecoveryPayloadCorruptError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

/**
 * Error names are metadata only when they are code-owned constants. Unknown
 * names can contain credentials or identity data even when they look like a
 * normal JavaScript identifier, so they collapse to one closed value.
 */
export function privacySafeErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "UnknownError";
    const name = error.name;
    return RECOVERY_TELEMETRY_ERROR_NAMES.has(name) ? name : "UnknownError";
  } catch {
    return "UnknownError";
  }
}
