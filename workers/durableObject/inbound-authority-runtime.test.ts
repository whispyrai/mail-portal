import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

test(
  "MailboxDO accepts only exact live inbound authority as delivery truth",
  { timeout: 60_000 },
  async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "mail-inbound-authority-"),
    );
    let runtime: Miniflare | undefined;
    try {
      await execFileAsync(
        join(ROOT, "node_modules/.bin/wrangler"),
        [
          "deploy",
          "workers/testing/r2-deletion-race-integration-entry.ts",
          "--dry-run",
          "--outdir",
          outputDirectory,
          "--compatibility-date",
          "2026-07-15",
          "--compatibility-flag",
          "nodejs_compat",
          "--config",
          "wrangler.jsonc",
          "--env=",
          "--upload-source-maps=false",
        ],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log"),
          },
        },
      );
      const bundle = await readFile(
        join(outputDirectory, "r2-deletion-race-integration-entry.js"),
        "utf8",
      );
      runtime = new Miniflare({
        log: new Log(LogLevel.ERROR),
        workers: [
          {
            name: "main",
            modules: true,
            script: bundle,
            compatibilityDate: "2026-07-15",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: {
              MAILBOX: {
                className: "R2DeletionRaceTestMailboxDO",
                useSQLite: true,
              },
            },
            r2Buckets: ["BUCKET"],
            d1Databases: ["DB"],
            kvNamespaces: ["OAUTH_KV"],
            bindings: {
              BRAND: "wiser",
              FEATURES: [],
              DOMAINS: "wiserchat.ai",
              EMAIL_ADDRESSES: [],
              AWS_REGION: "eu-west-2",
              SES_CONFIGURATION_SET: "mail-portal-events",
              AI_MODEL: "test",
              AI_CHEAP_MODEL: "test",
              AI_STRONG_MODEL: "test",
              AI_COST_ALERT_USD: "25",
              AI_COST_REVIEW_USD: "50",
              VAPID_SUBJECT: "mailto:test@example.com",
            },
          },
        ],
      });

      async function rpc<T>(path: string, body: unknown): Promise<T> {
        const response = await runtime!.dispatchFetch(
          `http://authority.test${path}?mailbox=authority@example.com`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const responseBody = await response.text();
        assert.equal(response.status, 200, responseBody);
        return JSON.parse(responseBody);
      }
      const attempt = (suffix: string) =>
        `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

      await rpc("/create-generic", { emailId: "legacy-collision" });
      assert.deepEqual(
        await rpc("/create", {
          emailId: "legacy-collision",
          attemptId: attempt("1"),
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/create", {
          emailId: "exact-duplicate",
          attemptId: attempt("2"),
        }),
        { status: "stored", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/create", {
          emailId: "exact-duplicate",
          attemptId: attempt("3"),
        }),
        { status: "duplicate", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/create", {
          emailId: "exact-duplicate",
          attemptId: attempt("4"),
          authorityVariant: "different",
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "exact-duplicate",
        }),
        "stored",
      );

      await rpc("/create-generic", { emailId: "direct-legacy-collision" });
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-legacy-collision",
          attemptId: attempt("5"),
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );

      const directOwnedKey =
        "email-bodies/direct-exact/00000000-0000-4000-8000-000000000006/0.body";
      const directCleanupKey =
        "email-bodies/direct-exact/00000000-0000-4000-8000-000000000006/1.body";
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-exact",
          attemptId: attempt("6"),
          ownedKey: directOwnedKey,
          cleanupKey: directCleanupKey,
        }),
        { status: "stored", cleanupKeys: [directCleanupKey] },
      );
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-exact",
          attemptId: attempt("7"),
        }),
        { status: "duplicate", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-exact",
          attemptId: attempt("8"),
          authorityVariant: "different",
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/create", {
          emailId: "direct-exact",
          attemptId: attempt("9"),
        }),
        { status: "duplicate", cleanupKeys: [] },
      );
      assert.deepEqual(
        await rpc("/inbound-owner-state", {
          emailId: "direct-exact",
        }),
        {
          archiveState: null,
          directState: "projected",
          emailExists: true,
          tombstoneDeletedAt: null,
        },
      );
      assert.deepEqual(
        await rpc("/direct-inbound-authority-read", {
          emailId: "direct-exact",
        }),
        {
          projection: { generation: 1 },
          deletion: null,
          archivedProjection: { generation: 1 },
          archivedDeletion: null,
        },
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "direct-exact",
        }),
        "stored",
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "direct-exact",
          authorityVariant: "different",
        }),
        "ledgered",
      );

      assert.deepEqual(
        await rpc("/create-direct-lose-response", {
          emailId: "direct-ambiguous",
          attemptId: attempt("10"),
        }),
        { error: "controlled lost direct inbound create response" },
      );
      assert.deepEqual(
        await rpc("/direct-inbound-authority-read", {
          emailId: "direct-ambiguous",
        }),
        {
          projection: { generation: 1 },
          deletion: null,
          archivedProjection: { generation: 1 },
          archivedDeletion: null,
        },
      );

      await rpc("/create-direct", {
        emailId: "direct-deleted",
        attemptId: attempt("11"),
      });
      await rpc("/direct-inbound-delete", { emailId: "direct-deleted" });
      const directDeleted = await rpc<{
        projection: unknown;
        deletion: { generation: number; deletedAt: string } | null;
        archivedProjection: unknown;
        archivedDeletion: unknown;
      }>("/direct-inbound-authority-read", { emailId: "direct-deleted" });
      assert.equal(directDeleted.projection, null);
      assert.equal(directDeleted.deletion?.generation, 2);
      assert.match(
        directDeleted.deletion?.deletedAt ?? "",
        /^\d{4}-\d{2}-\d{2}T/,
      );
      assert.equal(directDeleted.archivedProjection, null);
      assert.equal(
        (
          directDeleted.archivedDeletion as {
            generation: number;
            deletedAt: string;
          } | null
        )?.generation,
        2,
      );
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-deleted",
          attemptId: attempt("12"),
        }),
        { status: "deleted", cleanupKeys: [] },
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "direct-deleted",
        }),
        "deleted",
      );

      await rpc("/create", {
        emailId: "archive-deleted-mismatch",
        attemptId: attempt("14"),
      });
      await rpc("/direct-inbound-delete", {
        emailId: "archive-deleted-mismatch",
      });
      assert.deepEqual(
        await rpc("/create", {
          emailId: "archive-deleted-mismatch",
          attemptId: attempt("15"),
          authorityVariant: "different",
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );

      await rpc("/create-direct", {
        emailId: "both-owner-corruption",
        attemptId: attempt("16"),
      });
      await rpc("/inbound-owner-corruption", {
        emailId: "both-owner-corruption",
        mode: "both_projected",
      });
      assert.deepEqual(
        await rpc("/inbound-delete-capture", {
          emailId: "both-owner-corruption",
        }),
        { error: "Inbound email has conflicting authority owners" },
      );
      assert.deepEqual(
        await rpc("/inbound-owner-state", {
          emailId: "both-owner-corruption",
        }),
        {
          archiveState: "projected",
          directState: "projected",
          emailExists: true,
          tombstoneDeletedAt: null,
        },
      );

      await rpc("/create-direct", {
        emailId: "deleted-owner-live-email",
        attemptId: attempt("17"),
      });
      await rpc("/inbound-owner-corruption", {
        emailId: "deleted-owner-live-email",
        mode: "direct_deleted_with_live_email",
      });
      const corruptedDeletedOwnerBefore = await rpc<{
        archiveState: string | null;
        directState: string | null;
        emailExists: boolean;
        tombstoneDeletedAt: string | null;
      }>("/inbound-owner-state", {
        emailId: "deleted-owner-live-email",
      });
      assert.deepEqual(
        await rpc("/inbound-delete-capture", {
          emailId: "deleted-owner-live-email",
        }),
        { error: "Direct inbound authority is not projected" },
      );
      assert.deepEqual(
        await rpc("/inbound-owner-state", {
          emailId: "deleted-owner-live-email",
        }),
        corruptedDeletedOwnerBefore,
      );

      await rpc("/foreign-tombstone", {
        emailId: "direct-foreign-tombstone",
      });
      assert.deepEqual(
        await rpc("/create-direct", {
          emailId: "direct-foreign-tombstone",
          attemptId: attempt("13"),
        }),
        { status: "identity_conflict", cleanupKeys: [] },
      );

      await rpc("/create-direct", {
        emailId: "direct-projected-with-tombstone",
        attemptId: attempt("18"),
      });
      await rpc("/inbound-owner-corruption", {
        emailId: "direct-projected-with-tombstone",
        mode: "direct_projected_with_tombstone",
      });
      assert.deepEqual(
        await rpc("/direct-inbound-authority-read", {
          emailId: "direct-projected-with-tombstone",
        }),
        {
          projection: null,
          deletion: null,
          archivedProjection: null,
          archivedDeletion: null,
        },
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "direct-projected-with-tombstone",
        }),
        "ledgered",
      );

      for (const mode of [
        "projected_without_email",
        "projected_with_imported_email",
        "projected_with_live_email_and_tombstone",
        "deleted_without_tombstone",
        "deleted_with_live_email",
      ]) {
        const emailId = `corrupt-${mode}`;
        await rpc("/inbound-authority-seed", { emailId, mode });
        assert.deepEqual(
          await rpc("/inbound-authority-read", { emailId }),
          { projection: null, deletion: null },
          mode,
        );
        assert.equal(
          await rpc("/inbound-terminal-failure", { emailId }),
          "ledgered",
          mode,
        );
      }

      await rpc("/inbound-authority-seed", {
        emailId: "exact-deletion",
        mode: "deleted_exact",
      });
      const exactDeletion = await rpc<{
        projection: unknown;
        deletion: { generation: number; deletedAt: string } | null;
      }>("/inbound-authority-read", { emailId: "exact-deletion" });
      assert.equal(exactDeletion.projection, null);
      assert.equal(exactDeletion.deletion?.generation, 2);
      assert.match(
        exactDeletion.deletion?.deletedAt ?? "",
        /^\d{4}-\d{2}-\d{2}T/,
      );
      assert.equal(
        await rpc("/inbound-terminal-failure", {
          emailId: "exact-deletion",
        }),
        "deleted",
      );
    } finally {
      await runtime?.dispose();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
