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
type JsonRecord = Record<string, unknown>;

function objectKey(emailId: string, claimToken: string, ordinal: number): string {
  return `attachments/${emailId}/${emailId}-${claimToken.replaceAll("-", "")}-${ordinal}/file-${ordinal}.bin`;
}

test(
  "MailboxDO enforces bounded two-phase import promotion and replay recovery",
  { timeout: 120_000 },
  async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mail-import-intent-"));
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
        r2Buckets: { BUCKET: "import-promotion-runtime" },
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
      });

      async function rpc<T>(path: string, body: unknown): Promise<T> {
        const response = await runtime!.dispatchFetch(
          `http://import.test${path}?mailbox=import-runtime@example.com`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const responseBody = await response.text();
        assert.equal(response.status, 200, responseBody);
        return JSON.parse(responseBody) as T;
      }

      async function seed(identity: { emailId: string; claimToken: string }, count: number) {
        return rpc<{ proofFingerprint: string }>("/import-seed", {
          ...identity,
          count,
        });
      }

      async function state(
        identity: { emailId: string; claimToken: string },
        ordinal = 0,
      ) {
        return rpc<JsonRecord>("/import-state", {
          ...identity,
          r2Key: objectKey(identity.emailId, identity.claimToken, ordinal),
        });
      }

      async function finalizeUntilTerminal(
        identity: { emailId: string; claimToken: string },
        proofFingerprint: string,
        maximumPasses: number,
      ): Promise<JsonRecord> {
        let result: JsonRecord = { status: "pending" };
        for (let pass = 0; pass < maximumPasses; pass += 1) {
          result = await rpc<JsonRecord>("/import-finalize", {
            ...identity,
            proofFingerprint,
          });
          if (result.status !== "pending") return result;
        }
        return result;
      }

      const owned = {
        emailId: "11111111111111111111111111111111",
        claimToken: "11111111-1111-4111-8111-111111111111",
      };
      const ownedSeed = await seed(owned, 1);
      await rpc("/import-put-range", { ...owned, start: 0, count: 1 });
      assert.deepEqual(
        await rpc("/import-create", { ...owned, ...ownedSeed, count: 1 }),
        { status: "stored" },
      );
      assert.deepEqual(
        await rpc("/import-create", { ...owned, ...ownedSeed, count: 1 }),
        { status: "duplicate" },
      );
      const ownedFinalized = await finalizeUntilTerminal(
        owned,
        ownedSeed.proofFingerprint,
        4,
      );
      assert.equal(ownedFinalized.status, "finalized");
      assert.deepEqual(
        await rpc("/import-finalize", {
          ...owned,
          proofFingerprint: ownedSeed.proofFingerprint,
        }),
        ownedFinalized,
      );
      const ownedState = await state(owned);
      assert.equal(ownedState.objectExists, true);
      assert.notEqual(ownedState.email, undefined);
      assert.equal(ownedState.claim, undefined);

      const lostCreateResponse = {
        emailId: "abababababababababababababababab",
        claimToken: "abababab-abab-4bab-8bab-abababababab",
      };
      const lostCreateSeed = await seed(lostCreateResponse, 1);
      await rpc("/import-put-range", {
        ...lostCreateResponse,
        start: 0,
        count: 1,
      });
      assert.deepEqual(
        await rpc("/import-create-lose-response", {
          ...lostCreateResponse,
          ...lostCreateSeed,
          count: 1,
        }),
        { error: "controlled lost import create response" },
      );
      const committedWithoutResponse = await state(lostCreateResponse);
      assert.notEqual(committedWithoutResponse.email, undefined);
      assert.equal(committedWithoutResponse.attachmentCount, 1);
      assert.equal(committedWithoutResponse.objectExists, true);
      assert.equal(
        (
          await finalizeUntilTerminal(
            lostCreateResponse,
            lostCreateSeed.proofFingerprint,
            4,
          )
        ).status,
        "finalized",
      );
      const finalizedAfterResponseLoss = await state(lostCreateResponse);
      assert.equal(finalizedAfterResponseLoss.claim, undefined);
      assert.equal(finalizedAfterResponseLoss.objectExists, true);
      assert.deepEqual(
        await rpc("/import-claim", {
          emailId: lostCreateResponse.emailId,
          legacyId: `${lostCreateResponse.emailId.slice(0, 31)}0`,
          claimToken: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        }),
        { status: "existing", id: lostCreateResponse.emailId },
      );
      assert.equal((await state(lostCreateResponse)).objectExists, true);

      const blockedCommitted = {
        emailId: "22222222222222222222222222222222",
        claimToken: "22222222-2222-4222-8222-222222222222",
      };
      const blockedCommittedSeed = await seed(blockedCommitted, 1);
      await rpc("/import-create", {
        ...blockedCommitted,
        ...blockedCommittedSeed,
        count: 1,
      });
      assert.equal(
        (
          await finalizeUntilTerminal(
            blockedCommitted,
            blockedCommittedSeed.proofFingerprint,
            2,
          )
        ).status,
        "integrity_blocked",
      );
      await rpc("/import-expire", blockedCommitted);
      await rpc("/alarm", {});
      assert.equal(
        (await state(blockedCommitted)).objectExists,
        false,
      );
      const blockedCommittedState = await state(blockedCommitted);
      assert.equal(
        (blockedCommittedState.intent as JsonRecord).state,
        "integrity_blocked",
      );
      assert.equal(
        (blockedCommittedState.claim as JsonRecord).claim_token,
        blockedCommitted.claimToken,
      );
      assert.deepEqual(
        await rpc("/import-claim", {
          emailId: blockedCommitted.emailId,
          legacyId: `${blockedCommitted.emailId.slice(0, 31)}0`,
          claimToken: "99999999-9999-4999-8999-999999999999",
        }),
        { status: "busy" },
      );

      const lateWrite = {
        emailId: "99999999999999999999999999999999",
        claimToken: "99999999-9999-4999-8999-999999999999",
      };
      await seed(lateWrite, 1);
      await rpc("/import-expire", lateWrite);
      await rpc("/alarm", {});
      await rpc("/import-watch-due", lateWrite);
      await rpc("/alarm", {});
      const firstWatchState = await state(lateWrite);
      assert.equal(
        (firstWatchState.intent as JsonRecord).state,
        "abandoned_watching",
      );
      assert.equal(
        (firstWatchState.intent as JsonRecord).writer_closed,
        0,
      );
      const successorToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      assert.deepEqual(
        await rpc("/import-claim", {
          emailId: lateWrite.emailId,
          legacyId: `${lateWrite.emailId.slice(0, 31)}0`,
          claimToken: successorToken,
        }),
        { status: "claimed" },
      );
      await rpc("/import-put-range", { ...lateWrite, start: 0, count: 1 });
      await rpc("/import-watch-due", lateWrite);
      await rpc("/alarm", {});
      await rpc("/import-watch-due", lateWrite);
      await rpc("/alarm", {});
      const lateWriteState = await state(lateWrite);
      assert.equal(lateWriteState.objectExists, false);
      assert.equal(
        (lateWriteState.intent as JsonRecord).state,
        "abandoned_watching",
      );
      assert.equal(
        (lateWriteState.intent as JsonRecord).writer_closed,
        0,
      );
      assert.equal(
        (lateWriteState.claim as JsonRecord).claim_token,
        successorToken,
      );

      const authoritativeWrong = {
        emailId: "33333333333333333333333333333333",
        claimToken: "33333333-3333-4333-8333-333333333333",
      };
      const authoritativeWrongSeed = await seed(authoritativeWrong, 1);
      await rpc("/put", {
        r2Key: objectKey(authoritativeWrong.emailId, authoritativeWrong.claimToken, 0),
        body: "wrong",
      });
      await rpc("/import-create", {
        ...authoritativeWrong,
        ...authoritativeWrongSeed,
        count: 1,
      });
      assert.equal(
        (
          await finalizeUntilTerminal(
            authoritativeWrong,
            authoritativeWrongSeed.proofFingerprint,
            2,
          )
        ).status,
        "integrity_blocked",
      );

      for (const [emailId, claimToken, count, mismatchOrdinal] of [
        ["44444444444444444444444444444444", "44444444-4444-4444-8444-444444444444", 2, 1],
        ["55555555555555555555555555555555", "55555555-5555-4555-8555-555555555555", 21, 20],
      ] as const) {
        const identity = { emailId, claimToken };
        const promotion = await seed(identity, count);
        await rpc("/import-put-range", { ...identity, start: 0, count });
        await rpc("/put", {
          r2Key: objectKey(emailId, claimToken, mismatchOrdinal),
          body: "wrong",
        });
        assert.equal(
          (
            await finalizeUntilTerminal(
              identity,
              promotion.proofFingerprint,
              Math.ceil(count / 20) + 1,
            )
          ).status,
          "integrity_blocked",
        );
        const mismatchState = await state(identity);
        assert.equal(mismatchState.objectExists, true);
        assert.equal(mismatchState.outboxTotal, 0);
        assert.deepEqual(
          await rpc("/import-count-present", { ...identity, count }),
          { presentCount: count },
        );
      }

      const laterFence = {
        emailId: "88888888888888888888888888888888",
        claimToken: "88888888-8888-4888-8888-888888888888",
      };
      const laterFenceSeed = await seed(laterFence, 21);
      await rpc("/import-put-range", { ...laterFence, start: 0, count: 21 });
      const laterAuthoritativeKey = objectKey(
        laterFence.emailId,
        laterFence.claimToken,
        20,
      );
      await rpc("/create-generic", {
        emailId: laterFence.emailId,
        r2Key: laterAuthoritativeKey,
      });
      await rpc("/import-seed-active-deletion", {
        emailId: laterFence.emailId,
        r2Key: laterAuthoritativeKey,
      });
      assert.equal(
        (
          await finalizeUntilTerminal(
            laterFence,
            laterFenceSeed.proofFingerprint,
            3,
          )
        ).status,
        "integrity_blocked",
      );
      const laterFenceState = await state(laterFence);
      assert.equal(laterFenceState.outbox, undefined);
      assert.deepEqual(
        await rpc("/import-count-present", { ...laterFence, count: 21 }),
        { presentCount: 21 },
      );

      const leaseRecovery = {
        emailId: "66666666666666666666666666666666",
        claimToken: "66666666-6666-4666-8666-666666666666",
      };
      const leaseRecoverySeed = await seed(leaseRecovery, 1);
      await rpc("/import-put-range", { ...leaseRecovery, start: 0, count: 1 });
      await rpc("/import-create", {
        ...leaseRecovery,
        ...leaseRecoverySeed,
        count: 1,
      });
      assert.match(
        (
          await rpc<{ error: string }>("/import-fail-head", {
            ...leaseRecovery,
            proofFingerprint: leaseRecoverySeed.proofFingerprint,
          })
        ).error,
        /controlled import HEAD failure/,
      );
      assert.equal((await state(leaseRecovery)).intent && ((await state(leaseRecovery)).intent as JsonRecord).state, "reconciling");
      await rpc("/import-expire-lease", leaseRecovery);
      await rpc("/alarm", {});
      assert.equal(
        ((await state(leaseRecovery)).intent as JsonRecord).state,
        "recorded",
      );
      assert.equal(
        (
          await finalizeUntilTerminal(
            leaseRecovery,
            leaseRecoverySeed.proofFingerprint,
            2,
          )
        ).status,
        "finalized",
      );

      const large = {
        emailId: "77777777777777777777777777777777",
        claimToken: "77777777-7777-4777-8777-777777777777",
      };
      const largeSeed = await seed(large, 513);
      const replay = await rpc<JsonRecord>("/import-replay-last", {
        ...large,
        count: 513,
      });
      assert.deepEqual(replay.append, { status: "replayed" });
      assert.equal(
        (replay.seal as JsonRecord).proofFingerprint,
        largeSeed.proofFingerprint,
      );
      await rpc("/import-put-range", { ...large, start: 0, count: 513 });
      assert.deepEqual(
        await rpc("/import-create", { ...large, ...largeSeed, count: 513 }),
        { status: "stored" },
      );
      assert.deepEqual(
        await rpc("/import-create", { ...large, ...largeSeed, count: 513 }),
        { status: "duplicate" },
      );
      assert.equal(
        (
          await finalizeUntilTerminal(
            large,
            largeSeed.proofFingerprint,
            2 * Math.ceil(513 / 20) + 3,
          )
        ).status,
        "finalized",
      );
      assert.equal((await state(large, 512)).objectExists, true);
    } finally {
      await runtime?.dispose();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
