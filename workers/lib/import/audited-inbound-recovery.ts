import type { Email } from "postal-mime";
import type { InboundArchivePointer } from "../../inbound-email.ts";
import type { EmailStorageDependencies } from "../store-email.ts";
import { recoverInboundEmail } from "./recover-inbound.ts";

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

type RecoveryResult = Awaited<ReturnType<typeof recoverInboundEmail>>;

const defaultRuntime: RecoveryAuditRuntime = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

export class AuditedInboundRecoveryError extends Error {
  readonly stage: "request_audit" | "projection" | "completion_audit";
  readonly auditId: string;

  constructor(
    stage: "request_audit" | "projection" | "completion_audit",
    auditId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AuditedInboundRecoveryError";
    this.stage = stage;
    this.auditId = auditId;
  }
}

export async function recoverInboundEmailWithAudit(
  input: {
    auditBucket: RecoveryAuditBucket;
    dependencies: EmailStorageDependencies;
    parsed?: Email;
    pointer: InboundArchivePointer;
    operator: RecoveryOperator;
    recover?: () => Promise<RecoveryResult>;
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
    operator: input.operator,
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

  let result: Awaited<ReturnType<typeof recoverInboundEmail>>;
  try {
    if (input.recover) {
      result = await input.recover();
    } else {
      if (!input.parsed) throw new Error("Recovery source is unavailable");
      result = await recoverInboundEmail(input.dependencies, input.parsed, {
        ingressId: input.pointer.ingressId,
        archivedAt: input.pointer.archivedAt,
      });
    }
  } catch (error) {
    try {
      const failed = await input.auditBucket.put(
        `${auditPrefix}-failed.json`,
        JSON.stringify({
          ...auditContext,
          status: "failed",
          failedAt: runtime.now().toISOString(),
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { status: "failed" },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      );
      if (!failed) throw new Error("R2 rejected recovery failure audit");
    } catch (auditError) {
      console.error("[mail-recovery] failure audit degraded", {
        auditId,
        errorCode: "MANUAL_RECOVERY_FAILURE_AUDIT_FAILED",
        errorMessage:
          auditError instanceof Error ? auditError.message : String(auditError),
        ingressId: input.pointer.ingressId,
        mailboxId: input.pointer.mailboxId,
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
    throw new AuditedInboundRecoveryError("completion_audit", auditId, error);
  }

  return { auditId, recoveredAt, result };
}
