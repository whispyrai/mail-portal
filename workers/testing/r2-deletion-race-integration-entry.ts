import { eq, sql } from "drizzle-orm";
import { Folders } from "../../shared/folders.ts";
import * as schema from "../db/schema.ts";
import { MailboxDO } from "../durableObject/index.ts";
import { inboundDerivedContentRepairCommandFingerprint } from "../lib/inbound-derived-content-repair-attempt.ts";
import type { Env } from "../types.ts";

const MAILBOX_ID = "team@example.com";

function inboundAuthority(emailId: string, variant = "exact") {
  return {
    schemaVersion: 1 as const,
    ingressId: emailId,
    rawKey: `raw/2026/07/17/10/00/${emailId}.eml`,
    mailboxId: MAILBOX_ID,
    rawSize: 4,
    rawSha256: variant === "exact" ? "a".repeat(64) : "d".repeat(64),
    archivedAt: "2026-07-17T10:00:00.000Z",
    etag: `archive-etag-${variant}`,
    version: "archive-version",
  };
}

function directInboundAuthority(emailId: string, variant = "exact") {
  return {
    schemaVersion: 1 as const,
    ingressId: emailId,
    mailboxId: MAILBOX_ID,
    rawSize: 4,
    rawSha256: variant === "exact" ? "a".repeat(64) : "c".repeat(64),
    receivedAt: "2026-07-17T10:00:00.000Z",
  };
}

function bodyKey(emailId: string, attemptId: string): string {
  return `email-bodies/${emailId}/${attemptId}/0.body`;
}

function importObjectKey(
  emailId: string,
  claimToken: string,
  ordinal: number,
): string {
  return `attachments/${emailId}/${emailId}-${claimToken.replaceAll("-", "")}-${ordinal}/file-${ordinal}.bin`;
}

export class R2DeletionRaceTestMailboxDO extends MailboxDO {
  #throwNextImportHead = false;

  protected override async headR2Object(r2Key: string): Promise<R2Object | null> {
    if (this.#throwNextImportHead) {
      this.#throwNextImportHead = false;
      throw new Error("controlled import HEAD failure");
    }
    return super.headR2Object(r2Key);
  }

  async putObjectForTest(input: {
    r2Key: string;
    body: string;
  }): Promise<void> {
    await this.env.BUCKET.put(input.r2Key, input.body);
  }

  async seedImportPromotionForTest(input: {
    emailId: string;
    claimToken: string;
    count: number;
    rawSha256?: string;
  }): Promise<{ proofFingerprint: string }> {
    const identitySource = input.rawSha256 ? "raw-sha256" : "message-id";
    const claim = await this.claimImportedEmail(
      input.emailId,
	  input.rawSha256 ? input.emailId : `${input.emailId.slice(0, 31)}0`,
      input.claimToken,
      identitySource,
      input.rawSha256 ?? null,
    );
    if (claim.status !== "claimed") throw new Error("test import claim failed");
    await this.beginImportedEmailPromotionIntent(
      input.emailId,
      input.claimToken,
      input.count,
      input.count * 4,
    );
    for (let offset = 0; offset < input.count; offset += 20) {
      await this.appendImportedEmailPromotionIntent(
        input.emailId,
        input.claimToken,
        Array.from(
          { length: Math.min(20, input.count - offset) },
          (_, index) => ({
            ordinal: offset + index,
            r2Key: importObjectKey(
              input.emailId,
              input.claimToken,
              offset + index,
            ),
            byteLength: 4,
          }),
        ),
      );
    }
    const sealed = await this.sealImportedEmailPromotionIntent(
      input.emailId,
      input.claimToken,
    );
    return { proofFingerprint: sealed.proofFingerprint };
  }

  async replayLastImportAppendForTest(input: {
    emailId: string;
    claimToken: string;
    count: number;
  }): Promise<unknown> {
    const start = Math.max(0, input.count - (input.count % 20 || 20));
    const objects = Array.from({ length: input.count - start }, (_, index) => ({
      ordinal: start + index,
      r2Key: importObjectKey(input.emailId, input.claimToken, start + index),
      byteLength: 4,
    }));
    const append = await this.appendImportedEmailPromotionIntent(
      input.emailId,
      input.claimToken,
      objects,
    );
    const seal = await this.sealImportedEmailPromotionIntent(
      input.emailId,
      input.claimToken,
    );
    return { append, seal };
  }

  async putImportObjectRangeForTest(input: {
    emailId: string;
    claimToken: string;
    start: number;
    count: number;
  }): Promise<void> {
    for (let offset = 0; offset < input.count; offset += 20) {
      await Promise.all(
        Array.from(
          { length: Math.min(20, input.count - offset) },
          (_, index) =>
            this.env.BUCKET.put(
              importObjectKey(
                input.emailId,
                input.claimToken,
                input.start + offset + index,
              ),
              "body",
            ),
        ),
      );
    }
  }

  async countPresentImportObjectsForTest(input: {
    emailId: string;
    claimToken: string;
    count: number;
  }): Promise<{ presentCount: number }> {
    if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 100) {
      throw new Error("test import presence count is out of bounds");
    }
    let presentCount = 0;
    for (let offset = 0; offset < input.count; offset += 20) {
      const page = await Promise.all(
        Array.from(
          { length: Math.min(20, input.count - offset) },
          (_, index) =>
            this.env.BUCKET.head(
              importObjectKey(
                input.emailId,
                input.claimToken,
                offset + index,
              ),
            ),
        ),
      );
      presentCount += page.filter(Boolean).length;
    }
    return { presentCount };
  }

  seedActiveDeletionForTest(input: { emailId: string; r2Key: string }): void {
    const now = new Date().toISOString();
    this.db
      .insert(schema.r2DeletionOutbox)
      .values({
        r2_key: input.r2Key,
        email_id: input.emailId,
        projection_attempt_id: null,
        state: "deleting",
        claim_generation: 1,
        lease_token: crypto.randomUUID(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        attempts: 0,
        next_attempt_at: now,
        last_error: null,
        created_at: now,
      })
      .run();
  }

  createImportedForTest(input: {
    emailId: string;
    claimToken: string;
    proofFingerprint: string;
    count: number;
    rawSha256?: string;
  }): Promise<unknown> {
    return this.createImportedEmail(
      Folders.ARCHIVE,
      {
        id: input.emailId,
        subject: "Imported Message",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        date: new Date().toISOString(),
        read: true,
        body: "body",
        thread_id: input.emailId,
        recipient_memory_origin: "admin_import",
      },
      Array.from({ length: input.count }, (_, index) => ({
        id: `${input.emailId}-${input.claimToken.replaceAll("-", "")}-${index}`,
        email_id: input.emailId,
        filename: `file-${index}.bin`,
        mimetype: "application/octet-stream",
        size: 4,
        r2_key: importObjectKey(input.emailId, input.claimToken, index),
      })),
      MAILBOX_ID,
      input.claimToken,
      input.proofFingerprint,
      input.rawSha256 ? "raw-sha256" : "message-id",
      input.rawSha256 ?? null,
	  input.rawSha256 ? input.emailId : `${input.emailId.slice(0, 31)}0`,
    );
  }

  async createImportedThenLoseResponseForTest(input: {
    emailId: string;
    claimToken: string;
    proofFingerprint: string;
    count: number;
  }): Promise<never> {
    const result = await this.createImportedForTest(input);
    if (
      !result ||
      typeof result !== "object" ||
      !("status" in result) ||
      result.status !== "stored"
    ) {
      throw new Error("controlled import create did not commit");
    }
    throw new Error("controlled lost import create response");
  }

  finalizeImportForTest(input: {
    emailId: string;
    claimToken: string;
    proofFingerprint: string;
  }): Promise<unknown> {
    return this.finalizeImportedEmailPromotionIntent(
      input.emailId,
      input.claimToken,
      input.proofFingerprint,
    );
  }

  deleteImportedEmailForTest(input: { emailId: string }): void {
    this.db.delete(schema.emails).where(eq(schema.emails.id, input.emailId)).run();
  }

  readImportSourceEvidenceForTest(input: { emailId: string }): unknown {
    return [
      ...this.ctx.storage.sql.exec<{ raw_sha256: string; created_at: number }>(
        `SELECT raw_sha256, created_at FROM import_source_identities
         WHERE email_id = ? LIMIT 1`,
        input.emailId,
      ),
    ][0] ?? null;
  }

  async failNextImportHeadForTest(input: {
    emailId: string;
    claimToken: string;
    proofFingerprint: string;
  }): Promise<{ error: string }> {
    this.#throwNextImportHead = true;
    try {
      await this.finalizeImportedEmailPromotionIntent(
        input.emailId,
        input.claimToken,
        input.proofFingerprint,
      );
      throw new Error("controlled import HEAD failure did not occur");
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown" };
    }
  }

  expireImportLeaseForTest(input: { emailId: string; claimToken: string }): void {
    this.ctx.storage.sql.exec(
      `UPDATE import_promotion_intents SET lease_expires_at = 0
       WHERE email_id = ? AND claim_token = ? AND state = 'reconciling'`,
      input.emailId,
      input.claimToken,
    );
  }

  expireImportForTest(input: { emailId: string; claimToken: string }): void {
    this.ctx.storage.sql.exec(
      `UPDATE import_generation_claims SET expires_at = 0
       WHERE message_id = ? AND claim_token = ?`,
      input.emailId,
      input.claimToken,
    );
    this.ctx.storage.sql.exec(
      `UPDATE import_promotion_intents SET next_reconcile_at = 0
       WHERE email_id = ? AND claim_token = ?`,
      input.emailId,
      input.claimToken,
    );
  }

  dueImportWatchForTest(input: { emailId: string; claimToken: string }): void {
    this.ctx.storage.sql.exec(
      `UPDATE import_promotion_intents SET next_reconcile_at = 0
       WHERE email_id = ? AND claim_token = ?`,
      input.emailId,
      input.claimToken,
    );
  }

  async readImportStateForTest(input: {
    emailId: string;
    claimToken: string;
    r2Key: string;
  }): Promise<unknown> {
    return {
      intent: [...this.ctx.storage.sql.exec(
        `SELECT * FROM import_promotion_intents
         WHERE email_id = ? AND claim_token = ?`,
        input.emailId,
        input.claimToken,
      )][0],
      object: [...this.ctx.storage.sql.exec(
        `SELECT * FROM import_promotion_intent_objects
         WHERE email_id = ? AND claim_token = ? AND r2_key = ?`,
        input.emailId,
        input.claimToken,
        input.r2Key,
      )][0],
      claim: [...this.ctx.storage.sql.exec(
        `SELECT * FROM import_generation_claims WHERE message_id = ?`,
        input.emailId,
      )][0],
      outbox: this.db
        .select()
        .from(schema.r2DeletionOutbox)
        .where(eq(schema.r2DeletionOutbox.r2_key, input.r2Key))
        .get(),
      outboxTotal: this.db
        .select({ total: sql<number>`COUNT(*)` })
        .from(schema.r2DeletionOutbox)
        .get()?.total ?? 0,
      email: this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(eq(schema.emails.id, input.emailId))
        .get(),
      attachmentCount:
        this.db
          .select({ total: sql<number>`COUNT(*)` })
          .from(schema.attachments)
          .where(eq(schema.attachments.email_id, input.emailId))
          .get()?.total ?? 0,
      objectExists: (await this.env.BUCKET.head(input.r2Key)) !== null,
    };
  }

  async seedCleanupForTest(input: {
    emailId: string;
    attemptId: string | null;
    r2Key: string;
    body: string;
  }): Promise<void> {
    await this.env.BUCKET.put(input.r2Key, input.body);
    const createdAt = new Date(Date.now() - 1_000).toISOString();
    this.db
      .insert(schema.r2DeletionOutbox)
      .values({
        r2_key: input.r2Key,
        email_id: input.emailId,
        projection_attempt_id: input.attemptId,
        state: "pending",
        claim_generation: 0,
        lease_token: null,
        lease_expires_at: null,
        attempts: 0,
        next_attempt_at: createdAt,
        last_error: null,
        created_at: createdAt,
      })
      .run();
  }

  seedCleanupBatchForTest(input: {
    emailId: string;
    attemptId: string;
    count: number;
  }): void {
    const createdAt = new Date(Date.now() - 1_000).toISOString();
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < input.count; index += 1) {
        this.db
          .insert(schema.r2DeletionOutbox)
          .values({
            r2_key: `email-bodies/${input.emailId}/${input.attemptId}/${index}.body`,
            email_id: input.emailId,
            projection_attempt_id: input.attemptId,
            state: "pending",
            claim_generation: 0,
            lease_token: null,
            lease_expires_at: null,
            attempts: 0,
            next_attempt_at: createdAt,
            last_error: null,
            created_at: createdAt,
          })
          .run();
      }
    });
  }

  async createInboundForTest(input: {
    emailId: string;
    attemptId: string;
    authorityVariant?: string;
    ownedKey?: string;
    ownedKeys?: string[];
    cleanupKey?: string;
    cleanupKeys?: string[];
  }): Promise<unknown> {
    const ownedKeys =
      input.ownedKeys ?? (input.ownedKey ? [input.ownedKey] : []);
    const cleanupKeys =
      input.cleanupKeys ?? (input.cleanupKey ? [input.cleanupKey] : []);
    const proof = [
      ...ownedKeys.map((r2Key) => ({ r2Key, byteLength: 4 })),
      ...cleanupKeys.map((r2Key) => ({ r2Key, byteLength: 4 })),
    ];
    return this.createInboundEmail({
      folder: Folders.INBOX,
      email: {
        id: input.emailId,
        subject: "Race proof",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        cc: null,
        bcc: null,
        date: new Date().toISOString(),
        read: false,
        body: "body",
        in_reply_to: null,
        email_references: null,
        thread_id: input.emailId,
        message_id: `<${input.emailId}@example.com>`,
        raw_headers: "[]",
        recipient_memory_origin: "live_inbound",
        snooze_wake_thread_id: null,
        follow_up_reply_mailbox_address: null,
        automation_trigger: "live_inbound",
        push_notification: {
          title: "New email",
          body: "Race proof",
          icon: "/icon.png",
          badge: "/badge.png",
          clickUrl: `/mailbox/${encodeURIComponent(MAILBOX_ID)}/open/${input.emailId}`,
          data: { emailId: input.emailId, mailboxId: MAILBOX_ID },
        },
      },
      attachments: [],
      bodyObjects: ownedKeys.map((r2Key, partIndex) => ({
        id: `${input.emailId}-body-${partIndex}`,
        email_id: input.emailId,
        part_index: partIndex,
        content_type: "text/plain",
        charset: "utf-8",
        r2_key: r2Key,
        byte_length: 4,
      })),
      mailboxAddress: MAILBOX_ID,
      allowTerminalRecovery: true,
      archiveAuthority: inboundAuthority(
        input.emailId,
        input.authorityVariant,
      ),
      projectionAttemptId: input.attemptId,
      derivedContentProof: proof,
    });
  }

  async createDirectInboundForTest(input: {
    emailId: string;
    attemptId: string;
    authorityVariant?: string;
    ownedKey?: string;
    ownedKeys?: string[];
    cleanupKey?: string;
    cleanupKeys?: string[];
  }): Promise<unknown> {
    const ownedKeys =
      input.ownedKeys ?? (input.ownedKey ? [input.ownedKey] : []);
    const cleanupKeys =
      input.cleanupKeys ?? (input.cleanupKey ? [input.cleanupKey] : []);
    const proof = [
      ...ownedKeys.map((r2Key) => ({ r2Key, byteLength: 4 })),
      ...cleanupKeys.map((r2Key) => ({ r2Key, byteLength: 4 })),
    ];
    const authority = directInboundAuthority(
      input.emailId,
      input.authorityVariant,
    );
    return this.createDirectInboundEmail({
      folder: Folders.INBOX,
      email: {
        id: input.emailId,
        subject: "Direct race proof",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        cc: null,
        bcc: null,
        date: authority.receivedAt,
        read: false,
        body: "body",
        in_reply_to: null,
        email_references: null,
        thread_id: input.emailId,
        message_id: `<${input.emailId}@example.com>`,
        raw_headers: "[]",
        recipient_memory_origin: "live_inbound",
        snooze_wake_thread_id: null,
        follow_up_reply_mailbox_address: null,
        automation_trigger: "live_inbound",
        push_notification: {
          title: "New email",
          body: "Direct race proof",
          icon: "/icon.png",
          badge: "/badge.png",
          clickUrl: `/mailbox/${encodeURIComponent(MAILBOX_ID)}/open/${input.emailId}`,
          data: { emailId: input.emailId, mailboxId: MAILBOX_ID },
        },
      },
      attachments: [],
      bodyObjects: ownedKeys.map((r2Key, partIndex) => ({
        id: `${input.emailId}-body-${partIndex}`,
        email_id: input.emailId,
        part_index: partIndex,
        content_type: "text/plain",
        charset: "utf-8",
        r2_key: r2Key,
        byte_length: 4,
      })),
      mailboxAddress: MAILBOX_ID,
      allowTerminalRecovery: true,
      directAuthority: authority,
      projectionExpiresAt: Date.now() + 30_000,
      projectionAttemptId: input.attemptId,
      derivedContentProof: proof,
    });
  }

  async createDirectInboundThenLoseResponseForTest(input: {
    emailId: string;
    attemptId: string;
  }): Promise<never> {
    const result = await this.createDirectInboundForTest(input);
    if (
      !result ||
      typeof result !== "object" ||
      !("status" in result) ||
      result.status !== "stored"
    ) {
      throw new Error("controlled direct inbound create did not commit");
    }
    throw new Error("controlled lost direct inbound create response");
  }

  async readDirectInboundAuthorityForTest(input: {
    emailId: string;
    authorityVariant?: string;
  }): Promise<unknown> {
    const authority = directInboundAuthority(
      input.emailId,
      input.authorityVariant,
    );
    return {
      projection: await this.getDirectInboundProjectionAuthority(authority),
      deletion: await this.getDirectInboundDeletionAuthority(authority),
      archivedProjection: await this.getInboundProjectionAuthority(
        inboundAuthority(input.emailId),
      ),
      archivedDeletion: await this.getInboundDeletionAuthority(
        inboundAuthority(input.emailId),
      ),
    };
  }

  deleteDirectInboundForTest(input: { emailId: string }): Promise<unknown> {
    return this.deleteEmail(input.emailId);
  }

  async readInboundAuthorityForTest(input: {
    emailId: string;
    authorityVariant?: string;
  }): Promise<unknown> {
    const authority = inboundAuthority(
      input.emailId,
      input.authorityVariant,
    );
    return {
      projection: await this.getInboundProjectionAuthority(authority),
      deletion: await this.getInboundDeletionAuthority(authority),
    };
  }

  recordInboundTerminalFailureForTest(input: {
    emailId: string;
    authorityVariant?: string;
  }): Promise<"deleted" | "ledgered" | "stored"> {
    return this.recordInboundTerminalFailure({
      id: input.emailId,
      archiveAuthority: inboundAuthority(
        input.emailId,
        input.authorityVariant,
      ),
      queueRef: "a".repeat(16),
      attempts: 11,
      errorCode: "QUEUE_RETRY_EXHAUSTED",
    });
  }

  readInboundOwnerStateForTest(input: { emailId: string }): {
    archiveState: string | null;
    directState: string | null;
    emailExists: boolean;
    tombstoneDeletedAt: string | null;
  } {
    const archive = this.db
      .select({ state: schema.inboundDeliveryAuthorities.state })
      .from(schema.inboundDeliveryAuthorities)
      .where(eq(schema.inboundDeliveryAuthorities.id, input.emailId))
      .get();
    const direct = this.db
      .select({ state: schema.directInboundDeliveryAuthorities.state })
      .from(schema.directInboundDeliveryAuthorities)
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.emailId))
      .get();
    const email = this.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.emailId))
      .get();
    const tombstone = this.db
      .select({ deletedAt: schema.emailDeletionTombstones.deleted_at })
      .from(schema.emailDeletionTombstones)
      .where(eq(schema.emailDeletionTombstones.id, input.emailId))
      .get();
    return {
      archiveState: archive?.state ?? null,
      directState: direct?.state ?? null,
      emailExists: email !== undefined,
      tombstoneDeletedAt: tombstone?.deletedAt ?? null,
    };
  }

  seedInboundOwnerCorruptionForTest(input: {
    emailId: string;
    mode:
      | "both_projected"
      | "direct_deleted_with_live_email"
      | "direct_projected_with_tombstone";
  }): Promise<void> | void {
    if (input.mode === "both_projected") {
      const authority = inboundAuthority(input.emailId);
      this.db
        .insert(schema.inboundDeliveryAuthorities)
        .values({
          id: authority.ingressId,
          schema_version: authority.schemaVersion,
          raw_key: authority.rawKey,
          mailbox_id: authority.mailboxId,
          raw_size: authority.rawSize,
          raw_sha256: authority.rawSha256,
          archived_at: authority.archivedAt,
          archive_etag: authority.etag,
          archive_version: authority.version,
          generation: 1,
          state: "projected",
          deleted_at: null,
        })
        .run();
      return;
    }
    const deletedAt = "2026-07-17T10:20:00.000Z";
    if (input.mode === "direct_projected_with_tombstone") {
      this.db
        .insert(schema.emailDeletionTombstones)
        .values({ id: input.emailId, deleted_at: deletedAt })
        .run();
      return;
    }
    this.db
      .update(schema.directInboundDeliveryAuthorities)
      .set({
        state: "deleted",
        generation: 2,
        deleted_at: deletedAt,
      })
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.emailId))
      .run();
    this.db
      .insert(schema.emailDeletionTombstones)
      .values({ id: input.emailId, deleted_at: deletedAt })
      .run();
  }

  async deleteInboundAndCaptureForTest(input: {
    emailId: string;
  }): Promise<{ error: string | null }> {
    try {
      await this.deleteEmail(input.emailId);
      return { error: null };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "unknown",
      };
    }
  }

  seedForeignTombstoneForTest(input: { emailId: string }): void {
    this.db
      .insert(schema.emailDeletionTombstones)
      .values({
        id: input.emailId,
        deleted_at: "2026-07-17T10:25:00.000Z",
      })
      .run();
  }

  async seedInboundAuthorityStateForTest(input: {
    emailId: string;
    mode:
      | "deleted_exact"
      | "deleted_with_live_email"
      | "deleted_without_tombstone"
      | "projected_with_live_email_and_tombstone"
      | "projected_with_imported_email"
      | "projected_without_email";
  }): Promise<void> {
    const authority = inboundAuthority(input.emailId);
    const insertAuthority = (
      state: "deleted" | "projected",
      deletedAt: string | null,
    ) => {
      this.db
        .insert(schema.inboundDeliveryAuthorities)
        .values({
          id: authority.ingressId,
          schema_version: authority.schemaVersion,
          raw_key: authority.rawKey,
          mailbox_id: authority.mailboxId,
          raw_size: authority.rawSize,
          raw_sha256: authority.rawSha256,
          archived_at: authority.archivedAt,
          archive_etag: authority.etag,
          archive_version: authority.version,
          generation: state === "deleted" ? 2 : 1,
          state,
          deleted_at: deletedAt,
        })
        .run();
    };

    if (input.mode === "projected_without_email") {
      insertAuthority("projected", null);
      return;
    }
    if (input.mode === "projected_with_imported_email") {
      await this.createGenericForTest({ emailId: input.emailId });
      insertAuthority("projected", null);
      return;
    }
    if (input.mode === "deleted_without_tombstone") {
      insertAuthority("deleted", "2026-07-17T10:10:00.000Z");
      return;
    }

    await this.createInboundForTest({
      emailId: input.emailId,
      attemptId: crypto.randomUUID(),
    });
    if (input.mode === "projected_with_live_email_and_tombstone") {
      this.db
        .insert(schema.emailDeletionTombstones)
        .values({
          id: input.emailId,
          deleted_at: "2026-07-17T10:10:00.000Z",
        })
        .run();
      return;
    }
    if (input.mode === "deleted_exact") {
      await this.deleteEmail(input.emailId);
      return;
    }
    const deletedAt = "2026-07-17T10:10:00.000Z";
    this.db
      .update(schema.inboundDeliveryAuthorities)
      .set({ state: "deleted", generation: 2, deleted_at: deletedAt })
      .where(eq(schema.inboundDeliveryAuthorities.id, input.emailId))
      .run();
    this.db
      .insert(schema.emailDeletionTombstones)
      .values({ id: input.emailId, deleted_at: deletedAt })
      .run();
  }

  createGenericForTest(input: {
    emailId: string;
    r2Key?: string;
    r2Keys?: string[];
  }): Promise<unknown> {
    const r2Keys = input.r2Keys ?? (input.r2Key ? [input.r2Key] : []);
    return this.createEmail(
      Folders.INBOX,
      {
        id: input.emailId,
        subject: "Imported message",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        cc: null,
        bcc: null,
        date: new Date().toISOString(),
        read: false,
        body: "body",
        in_reply_to: null,
        email_references: null,
        thread_id: input.emailId,
        message_id: `<${input.emailId}@example.com>`,
        raw_headers: "[]",
        recipient_memory_origin: "accepted_outbound",
      },
      r2Keys.map((r2Key, index) => ({
        id: `${input.emailId}-att-${index}`,
        email_id: input.emailId,
        filename: `attachment-${index}.bin`,
        mimetype: "application/octet-stream",
        size: 4,
        content_id: null,
        disposition: "attachment",
        r2_key: r2Key,
      })),
    );
  }

  createLegacyOwnerForTest(input: {
    emailId: string;
    attachmentId: string;
    filename: string;
  }): Promise<unknown> {
    return this.createEmail(
      Folders.INBOX,
      {
        id: input.emailId,
        subject: "Legacy owner",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        date: new Date().toISOString(),
        read: false,
        body: "body",
        thread_id: input.emailId,
        recipient_memory_origin: "accepted_outbound",
      },
      [
        {
          id: input.attachmentId,
          email_id: input.emailId,
          filename: input.filename,
          mimetype: "application/octet-stream",
          size: 4,
          r2_key: null,
        },
      ],
    );
  }

  async seedOwnedCleanupRacesForTest(input: {
    bodyAttemptId: string;
  }): Promise<{ explicitKey: string; legacyKey: string; bodyKey: string }> {
    const explicitKey = "imports/owned-explicit/attachment.bin";
    const legacyKey = "attachments/owned-legacy/owned-legacy-att/legacy.bin";
    const ownedBodyKey = bodyKey("owned-body", input.bodyAttemptId);
    await Promise.all([
      this.env.BUCKET.put(explicitKey, "body"),
      this.env.BUCKET.put(legacyKey, "body"),
      this.env.BUCKET.put(ownedBodyKey, "body"),
    ]);
    await this.createGenericForTest({
      emailId: "owned-explicit",
      r2Key: explicitKey,
    });
    await this.createEmail(
      Folders.INBOX,
      {
        id: "owned-legacy",
        subject: "Legacy import",
        sender: "sender@example.com",
        sender_name: "Sender",
        recipient: MAILBOX_ID,
        date: new Date().toISOString(),
        read: false,
        body: "body",
        thread_id: "owned-legacy",
        recipient_memory_origin: "accepted_outbound",
      },
      [
        {
          id: "owned-legacy-att",
          email_id: "owned-legacy",
          filename: "legacy.bin",
          mimetype: "application/octet-stream",
          size: 4,
          r2_key: null,
        },
      ],
    );
    await this.createInboundForTest({
      emailId: "owned-body",
      attemptId: input.bodyAttemptId,
      ownedKey: ownedBodyKey,
    });
    const createdAt = new Date(Date.now() - 1_000).toISOString();
    for (const [emailId, r2Key, attemptId] of [
      ["owned-explicit", explicitKey, null],
      ["owned-legacy", legacyKey, null],
      ["owned-body", ownedBodyKey, input.bodyAttemptId],
    ] as Array<[string, string, string | null]>) {
      this.db
        .insert(schema.r2DeletionOutbox)
        .values({
          r2_key: r2Key,
          email_id: emailId,
          projection_attempt_id: attemptId,
          state: "pending",
          claim_generation: 0,
          lease_token: null,
          lease_expires_at: null,
          attempts: 0,
          next_attempt_at: createdAt,
          last_error: null,
          created_at: createdAt,
        })
        .run();
    }
    await this.ctx.storage.deleteAlarm();
    return { explicitKey, legacyKey, bodyKey: ownedBodyKey };
  }

  async repairInboundForTest(input: {
    emailId: string;
    attemptId: string;
    ownedKey?: string;
    ownedKeys?: string[];
  }): Promise<unknown> {
    const manifest = await this.getInboundDerivedContentManifest(input.emailId);
    if (manifest.status !== "live_inbound") return manifest;
    const ownedKeys =
      input.ownedKeys ?? (input.ownedKey ? [input.ownedKey] : []);
    const commandWithoutFingerprint = {
      attemptId: input.attemptId,
      emailId: input.emailId,
      expectedGeneration: manifest.generation,
      markerId: "marker_12345678",
      body: "repaired body",
      attachments: [],
      bodyObjects: ownedKeys.map((r2Key, partIndex) => ({
        id: `${input.emailId}-body-${partIndex}`,
        email_id: input.emailId,
        part_index: partIndex,
        content_type: "text/plain" as const,
        charset: "utf-8",
        r2_key: r2Key,
        byte_length: 4,
      })),
    };
    return this.repairInboundDerivedContent({
      ...commandWithoutFingerprint,
      commandFingerprint: await inboundDerivedContentRepairCommandFingerprint(
        commandWithoutFingerprint,
      ),
    });
  }

  async runAlarmForTest(): Promise<{ scheduledAlarm: number | null }> {
    await this.alarm();
    const scheduledAlarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.deleteAlarm();
    return { scheduledAlarm };
  }

	async queueLegacyCleanupForTest(input: { emailId: string; r2Key: string }) {
		await this.env.BUCKET.put(input.r2Key, "body");
		await this.queueAttachmentCleanup(input.emailId, [input.r2Key]);
		return { status: "queued" as const };
	}

	async expireLegacyCleanupForTest(recoveryRef?: string) {
		const queue = (await this.ctx.storage.get<Array<{
			id: string;
			state?: string;
			nextAttemptAt?: number;
		}>>("attachment-cleanup:queue")) ?? [];
		for (const job of queue) {
			if (!recoveryRef || job.id === recoveryRef) job.nextAttemptAt = Date.now() - 1;
		}
		await this.ctx.storage.put("attachment-cleanup:queue", queue);
		return { status: "due" as const };
	}

	listParkedLegacyCleanupForTest() {
		return this.listParkedAttachmentCleanupJobs(100);
	}

	repairLegacyCleanupForTest(input: {
		recoveryRef: string;
		expectedGeneration: number;
	}) {
		return this.repairParkedAttachmentCleanupJob(
			input.recoveryRef,
			{ operationKey: "repair-legacy-test", expectedGeneration: input.expectedGeneration },
			{ kind: "user", id: "admin-1" },
		);
	}

	listParkedR2DeletionForTest() {
		return this.listParkedR2DeletionRecoveries(undefined, 100);
	}

	repairR2DeletionForTest(input: {
		recoveryRef: string;
		expectedGeneration: number;
	}) {
		return this.repairParkedR2Deletion(
			input.recoveryRef,
			{ operationKey: "repair-r2-test", expectedGeneration: input.expectedGeneration },
			{ kind: "user", id: "admin-1" },
		);
	}

  clearAlarmForTest(): Promise<void> {
    return this.ctx.storage.deleteAlarm();
  }

  readOutboxCountForTest(): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.r2DeletionOutbox)
        .get()?.count ?? 0
    );
  }

  expireDeletionLeaseForTest(r2Key: string): void {
    this.db
      .update(schema.r2DeletionOutbox)
      .set({ lease_expires_at: new Date(0).toISOString() })
      .where(eq(schema.r2DeletionOutbox.r2_key, r2Key))
      .run();
  }

  async readRaceStateForTest(input: {
    emailId: string;
    attemptId: string;
    r2Key: string;
  }): Promise<unknown> {
    return {
      objectExists: (await this.env.BUCKET.head(input.r2Key)) !== null,
      outbox: this.db
        .select()
        .from(schema.r2DeletionOutbox)
        .where(eq(schema.r2DeletionOutbox.r2_key, input.r2Key))
        .get(),
      retiredAttempt: this.db
        .select()
        .from(schema.inboundDerivedContentRetiredAttempts)
        .where(
          eq(
            schema.inboundDerivedContentRetiredAttempts.attempt_id,
            input.attemptId,
          ),
        )
        .get(),
      exactFence: this.db
        .select()
        .from(schema.r2RetiredKeyFences)
        .where(eq(schema.r2RetiredKeyFences.r2_key, input.r2Key))
        .get(),
      email: this.db
        .select({ id: schema.emails.id, body: schema.emails.body })
        .from(schema.emails)
        .where(eq(schema.emails.id, input.emailId))
        .get(),
      attachmentCount:
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.attachments)
          .where(eq(schema.attachments.email_id, input.emailId))
          .get()?.count ?? 0,
      repairAttempt: this.db
        .select()
        .from(schema.inboundDerivedContentRepairAttempts)
        .where(
          eq(
            schema.inboundDerivedContentRepairAttempts.attempt_id,
            input.attemptId,
          ),
        )
        .get(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}

type RaceTestStub = DurableObjectStub<R2DeletionRaceTestMailboxDO>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.MAILBOX.get(
      env.MAILBOX.idFromName(url.searchParams.get("mailbox") ?? MAILBOX_ID),
    ) as RaceTestStub;
    const body = await request.json();
    let value: unknown;
    switch (url.pathname) {
      case "/seed":
        value = await stub.seedCleanupForTest(body as never);
        break;
      case "/put":
        value = await stub.putObjectForTest(body as never);
        break;
      case "/import-seed":
        value = await stub.seedImportPromotionForTest(body as never);
        break;
      case "/import-replay-last":
        value = await stub.replayLastImportAppendForTest(body as never);
        break;
      case "/import-put-range":
        value = await stub.putImportObjectRangeForTest(body as never);
        break;
      case "/import-count-present":
        value = await stub.countPresentImportObjectsForTest(body as never);
        break;
      case "/import-seed-active-deletion":
        value = await stub.seedActiveDeletionForTest(body as never);
        break;
      case "/import-create":
        value = await stub.createImportedForTest(body as never);
        break;
      case "/import-create-lose-response":
        try {
          await stub.createImportedThenLoseResponseForTest(body as never);
        } catch (error) {
          value = {
            error: error instanceof Error ? error.message : "unknown",
          };
        }
        break;
      case "/import-finalize":
        value = await stub.finalizeImportForTest(body as never);
        break;
      case "/import-delete-email":
        value = await stub.deleteImportedEmailForTest(body as never);
        break;
      case "/import-source-evidence":
        value = await stub.readImportSourceEvidenceForTest(body as never);
        break;
      case "/import-fail-head":
        value = await stub.failNextImportHeadForTest(body as never);
        break;
      case "/import-expire-lease":
        value = await stub.expireImportLeaseForTest(body as never);
        break;
      case "/import-expire":
        value = await stub.expireImportForTest(body as never);
        break;
      case "/import-watch-due":
        value = await stub.dueImportWatchForTest(body as never);
        break;
      case "/import-state":
        value = await stub.readImportStateForTest(body as never);
        break;
      case "/import-claim": {
        const input = body as {
          emailId: string;
          legacyId: string;
          claimToken: string;
          identitySource: "message-id" | "raw-sha256";
          rawSha256: string | null;
        };
        value = await stub.claimImportedEmail(
          input.emailId,
          input.legacyId,
          input.claimToken,
          input.identitySource,
          input.rawSha256,
        );
        break;
      }
      case "/create":
        value = await stub.createInboundForTest(body as never);
        break;
      case "/create-direct":
        value = await stub.createDirectInboundForTest(body as never);
        break;
      case "/create-direct-lose-response":
        try {
          await stub.createDirectInboundThenLoseResponseForTest(body as never);
        } catch (error) {
          value = {
            error: error instanceof Error ? error.message : "unknown",
          };
        }
        break;
      case "/direct-inbound-authority-read":
        value = await stub.readDirectInboundAuthorityForTest(body as never);
        break;
      case "/direct-inbound-delete":
        value = await stub.deleteDirectInboundForTest(body as never);
        break;
      case "/inbound-authority-read":
        value = await stub.readInboundAuthorityForTest(body as never);
        break;
      case "/inbound-terminal-failure":
        value = await stub.recordInboundTerminalFailureForTest(body as never);
        break;
      case "/inbound-owner-state":
        value = await stub.readInboundOwnerStateForTest(body as never);
        break;
      case "/inbound-owner-corruption":
        value = await stub.seedInboundOwnerCorruptionForTest(body as never);
        break;
      case "/inbound-delete-capture":
        value = await stub.deleteInboundAndCaptureForTest(body as never);
        break;
      case "/foreign-tombstone":
        value = await stub.seedForeignTombstoneForTest(body as never);
        break;
      case "/inbound-authority-seed":
        value = await stub.seedInboundAuthorityStateForTest(body as never);
        break;
      case "/create-generic":
        value = await stub.createGenericForTest(body as never);
        break;
      case "/create-legacy-owner":
        value = await stub.createLegacyOwnerForTest(body as never);
        break;
      case "/seed-owned-races":
        value = await stub.seedOwnedCleanupRacesForTest(body as never);
        break;
      case "/seed-batch":
        value = await stub.seedCleanupBatchForTest(body as never);
        break;
      case "/repair":
        value = await stub.repairInboundForTest(body as never);
        break;
      case "/alarm":
        value = await stub.runAlarmForTest();
        break;
	  case "/legacy-cleanup-queue":
		value = await stub.queueLegacyCleanupForTest(body as never);
		break;
	  case "/legacy-cleanup-expire":
		value = await stub.expireLegacyCleanupForTest(
		  (body as { recoveryRef?: string }).recoveryRef,
		);
		break;
	  case "/legacy-cleanup-parked":
		value = await stub.listParkedLegacyCleanupForTest();
		break;
	  case "/legacy-cleanup-repair":
		value = await stub.repairLegacyCleanupForTest(body as never);
		break;
	  case "/r2-deletion-parked":
		value = await stub.listParkedR2DeletionForTest();
		break;
	  case "/r2-deletion-repair":
		value = await stub.repairR2DeletionForTest(body as never);
		break;
      case "/clear-alarm":
        value = await stub.clearAlarmForTest();
        break;
      case "/expire":
        value = await stub.expireDeletionLeaseForTest(
          (body as { r2Key: string }).r2Key,
        );
        break;
      case "/state":
        value = await stub.readRaceStateForTest(body as never);
        break;
      case "/outbox-count":
        value = { count: await stub.readOutboxCountForTest() };
        break;
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(value ?? { ok: true });
  },
};

export { bodyKey };
