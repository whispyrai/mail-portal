import type { Email } from "postal-mime";
import type { InboundArchivePointer } from "../../inbound-email.ts";
import type { EmailStorageDependencies } from "../store-email.ts";
import {
  exactRecoveryArchiveAuthority,
  recoverInboundEmail,
} from "./recover-inbound.ts";
import { safeErrorCode } from "../safe-error-code.ts";
import { mailTelemetryLogRef } from "../mail-telemetry.ts";

type RecoveryAuditBucket = {
  put(
    key: string,
    value: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      onlyIf: { etagDoesNotMatch: string };
    },
  ): Promise<unknown | null>;
};

type RecoveryOperator = { id: string; email: string };

type RecoveryAuditRuntime = {
  now(): Date;
  randomUUID(): string;
};

export type AuditedProjectionResult =
  | { status: "recovered"; ambiguousCommit: boolean }
  | { status: "skipped"; reason: "deleted" | "duplicate" }
  | {
      status: "repaired";
      generation: number;
      ambiguousCommit?: boolean;
    }
  | {
      status: "already_repaired" | "cleanup_conflict" | "stale_marker";
      generation?: number;
    }
  | { status: "deleted" | "missing" | "not_live_inbound" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function projectAuditedProjectionResult(
  value: unknown,
): AuditedProjectionResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("Manual recovery result is invalid");
  }
  if (
    value.status === "recovered" &&
    typeof value.ambiguousCommit === "boolean"
  ) {
    return { status: "recovered", ambiguousCommit: value.ambiguousCommit };
  }
  if (
    value.status === "skipped" &&
    (value.reason === "deleted" || value.reason === "duplicate")
  ) {
    return { status: "skipped", reason: value.reason };
  }
  if (value.status === "repaired" && validGeneration(value.generation)) {
    if (
      value.ambiguousCommit !== undefined &&
      typeof value.ambiguousCommit !== "boolean"
    ) {
      throw new Error("Manual recovery result is invalid");
    }
    return {
      status: "repaired",
      generation: value.generation,
      ...(value.ambiguousCommit === undefined
        ? {}
        : { ambiguousCommit: value.ambiguousCommit }),
    };
  }
  if (
    value.status === "already_repaired" ||
    value.status === "cleanup_conflict" ||
    value.status === "stale_marker"
  ) {
    if (value.generation !== undefined && !validGeneration(value.generation)) {
      throw new Error("Manual recovery result is invalid");
    }
    return {
      status: value.status,
      ...(value.generation === undefined
        ? {}
        : { generation: value.generation }),
    };
  }
  if (
    value.status === "deleted" ||
    value.status === "missing" ||
    value.status === "not_live_inbound"
  ) {
    return { status: value.status };
  }
  throw new Error("Manual recovery result is invalid");
}

const defaultRuntime: RecoveryAuditRuntime = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

export class AuditedInboundRecoveryError extends Error {
  readonly stage: "request_audit" | "projection" | "completion_audit";
  readonly auditId: string;
  readonly result?: AuditedProjectionResult;

  constructor(
    stage: "request_audit" | "projection" | "completion_audit",
    auditId: string,
    cause: unknown,
    result?: AuditedProjectionResult,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AuditedInboundRecoveryError";
    this.stage = stage;
    this.auditId = auditId;
    this.result = result;
  }
}

export async function recoverInboundEmailWithAudit(
  input: {
    auditBucket: RecoveryAuditBucket;
    dependencies: EmailStorageDependencies;
    parsed?: Email;
    pointer: InboundArchivePointer;
    operator: RecoveryOperator;
    recover?: () => Promise<unknown>;
  },
  runtime: RecoveryAuditRuntime = defaultRuntime,
) {
  const auditId = runtime.randomUUID();
  const auditPrefix = `system/recovery-audits/${input.pointer.ingressId}/${auditId}`;
  const requestedAt = runtime.now().toISOString();
  const auditContext = {
    auditId,
    ingressId: input.pointer.ingressId,
    mailboxId: input.pointer.mailboxId,
    rawKey: input.pointer.rawKey,
    requestedAt,
    operator: { id: input.operator.id, email: input.operator.email },
  };

  try {
    const requested = await input.auditBucket.put(
      `${auditPrefix}-requested.json`,
      JSON.stringify({ ...auditContext, status: "requested" }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { status: "requested" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (!requested) throw new Error("R2 rejected recovery request audit");
  } catch (error) {
    throw new AuditedInboundRecoveryError("request_audit", auditId, error);
  }

  let result: AuditedProjectionResult;
  try {
    if (input.recover) {
      result = projectAuditedProjectionResult(await input.recover());
    } else {
      if (!input.parsed) throw new Error("Recovery source is unavailable");
      result = projectAuditedProjectionResult(
        await recoverInboundEmail(input.dependencies, input.parsed, {
          archiveAuthority: exactRecoveryArchiveAuthority(input.pointer),
        }),
      );
    }
  } catch (error) {
    try {
      const failed = await input.auditBucket.put(
        `${auditPrefix}-failed.json`,
        JSON.stringify({
          ...auditContext,
          status: "failed",
          failedAt: runtime.now().toISOString(),
          errorCode: safeErrorCode(error, "MANUAL_RECOVERY_PROJECTION_FAILED"),
        }),
        {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { status: "failed" },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      );
      if (!failed) throw new Error("R2 rejected recovery failure audit");
    } catch (auditError) {
      const [auditRef, ingressRef] = await Promise.all([
        mailTelemetryLogRef("audit", auditId),
        mailTelemetryLogRef("ingress", input.pointer.ingressId),
      ]);
      console.error("[mail-recovery] failure audit degraded", {
        auditRef,
        errorCode: safeErrorCode(
          auditError,
          "MANUAL_RECOVERY_FAILURE_AUDIT_FAILED",
        ),
        ingressRef,
        operation: "manual_inbound_recovery_audit",
        status: "degraded",
      });
    }
    throw new AuditedInboundRecoveryError("projection", auditId, error);
  }

  const recoveredAt = runtime.now().toISOString();
  try {
    const completed = await input.auditBucket.put(
      `${auditPrefix}-completed.json`,
      JSON.stringify({
        ...auditContext,
        status: "completed",
        recoveredAt,
        result,
      }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { status: "completed" },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (!completed) throw new Error("R2 rejected recovery completion audit");
  } catch (error) {
    throw new AuditedInboundRecoveryError(
      "completion_audit",
      auditId,
      error,
      result,
    );
  }

  return { auditId, recoveredAt, result };
}
