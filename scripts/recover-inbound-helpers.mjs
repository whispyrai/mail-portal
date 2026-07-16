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

export function buildLoginRequest(baseUrl, email, password) {
  return {
    url: `${baseUrl.origin}/login`,
    options: {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl.origin,
      },
      body: new URLSearchParams({ email, password }),
      redirect: "manual",
    },
  };
}

export function buildRecoveryRequest(
  baseUrl,
  cookie,
  mailbox,
  ingressId,
) {
  const query = new URLSearchParams({ ingressId });
  return {
    url: `${baseUrl.origin}/admin/recover-inbound/${encodeURIComponent(mailbox)}?${query}`,
    options: {
      method: "POST",
      headers: { cookie, origin: baseUrl.origin },
    },
  };
}

const approvedRecoveryDomains = new Map([
  ["mail.wiserchat.ai", new Set(["wiserchat.ai"])],
  ["mail.whispyrcrm.com", new Set(["whispyrcrm.com"])],
]);

export function validateRecoveryTarget(base, mailbox) {
  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return { ok: false, error: "--base must be a valid absolute URL" };
  }
  const normalizedMailbox = mailbox.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalizedMailbox)) {
    return { ok: false, error: "--mailbox must be a valid email address" };
  }
  const mailboxDomain = normalizedMailbox.split("@")[1];
  const allowedMailboxDomains = approvedRecoveryDomains.get(baseUrl.hostname);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    !allowedMailboxDomains?.has(mailboxDomain)
  ) {
    return {
      ok: false,
      error: "--base must be an approved HTTPS mail portal origin matching --mailbox",
    };
  }
  return { ok: true, baseUrl };
}

export function isIncompleteRecoveryAudit(responseBody) {
  return (
    responseBody &&
    typeof responseBody === "object" &&
    responseBody.auditStatus === "incomplete" &&
    typeof responseBody.status === "string"
  );
}

export function isUnverifiedRecoveryCommit(responseBody) {
  return (
    responseBody &&
    typeof responseBody === "object" &&
    responseBody.commitStatus === "unverified"
  );
}

export function shouldRetryRecoveryResponse(responseStatus, responseBody) {
  return (
    responseStatus >= 500 &&
    !isIncompleteRecoveryAudit(responseBody) &&
    !isUnverifiedRecoveryCommit(responseBody)
  );
}

export function incompleteRecoveryAuditMessage(responseBody) {
  const mutationCommitted =
    responseBody.status === "repaired" ||
    responseBody.status === "recovered" ||
    responseBody.status === "already_repaired";
  const outcome = mutationCommitted
    ? "The mailbox mutation committed"
    : "The mailbox operation reached the reported outcome";
  const auditId =
    typeof responseBody.auditId === "string" ? responseBody.auditId : "returned auditId";
  return `${recoveryCompletionMessage(responseBody)} ${outcome}, but its completion audit is incomplete. Do not rerun recovery until an operator verifies the current mailbox manifest and completion audit using ${auditId}.`;
}

export function unverifiedRecoveryCommitMessage(responseBody) {
  const outcome =
    typeof responseBody.error === "string" && responseBody.error.length > 0
      ? responseBody.error
      : "Recovery outcome could not be verified";
  const guidance =
    typeof responseBody.recoveryGuidance === "string" &&
    responseBody.recoveryGuidance.length > 0
      ? responseBody.recoveryGuidance
      : "Do not retry until an operator verifies the current mailbox state.";
  const auditId =
    typeof responseBody.auditId === "string" && responseBody.auditId.length > 0
      ? responseBody.auditId
      : "unavailable";
  return `${outcome}. ${guidance} Audit identity: ${auditId}.`;
}

export function recoveryCompletionMessage(responseBody) {
  switch (responseBody.status) {
    case "repaired":
      return responseBody.ambiguousCommit
        ? "Recovery complete: derived content was repaired; the repair RPC response was ambiguous but the generation marker proved the commit"
        : "Recovery complete: derived content was repaired";
    case "recovered":
      return responseBody.ambiguousCommit
        ? "Recovery complete: the missing projection was restored; mailbox state proved an ambiguous commit"
        : "Recovery complete: the missing projection was restored";
    case "skipped": {
      const reason =
        typeof responseBody.reason === "string" && responseBody.reason.length > 0
          ? responseBody.reason
          : "unknown";
      return `Recovery complete: no projection was written (${reason})`;
    }
    case "deleted":
      return "Recovery complete: the archived message remains deleted and no projection was written";
    case "missing":
      return "Recovery complete: the mailbox projection is still missing and no repair was written";
    case "stale_marker":
      return "Recovery complete: the anomaly marker was stale and no repair was written";
    case "already_repaired":
      return "Recovery complete: this anomaly repair had already committed";
    default:
      return typeof responseBody.status === "string"
        ? `Recovery finished with an unrecognized status (${responseBody.status})`
        : "Recovery finished with an unrecognized outcome";
  }
}
