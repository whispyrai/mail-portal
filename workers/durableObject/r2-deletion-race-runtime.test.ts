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

const CONTROLLED_R2_WRAPPER = `
export default function(env) {
  return {
    get: (key, options) => env.INNER.get(key, options),
    put: (key, value, options) => env.INNER.put(key, value, options),
    head: (key) => env.INNER.head(key),
    async delete(keys) {
      const count = Number(await env.CONTROL.get("delete-count") || "0") + 1;
      await env.CONTROL.put("delete-count", String(count));
	  await env.CONTROL.put("delete-size-" + count, String(Array.isArray(keys) ? keys.length : 1));
      await env.CONTROL.put("delete-started", String(count));
      const mode = await env.CONTROL.get("mode");
      const pauseSelected = mode === "pause-selected-delete" &&
        String(count) === await env.CONTROL.get("pause-delete-count");
      if (mode === "pause-before-delete" || pauseSelected) {
        while (await env.CONTROL.get("release") !== "1") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (mode === "delete-then-throw") {
        await env.INNER.delete(keys);
        throw new Error("injected ambiguous R2 delete outcome");
      }
	  const failKey = await env.CONTROL.get("fail-key");
	  if (mode === "fail-key" && (Array.isArray(keys) ? keys.includes(failKey) : keys === failKey)) {
		throw new Error("injected key-specific R2 delete failure");
	  }
      return env.INNER.delete(keys);
    },
    list: (options) => env.INNER.list(options),
    createMultipartUpload: (key, options) => env.INNER.createMultipartUpload(key, options),
    resumeMultipartUpload: (key, uploadId) => env.INNER.resumeMultipartUpload(key, uploadId),
  };
}
`;

type JsonRecord = Record<string, unknown>;

function key(emailId: string, attemptId: string): string {
  return `email-bodies/${emailId}/${attemptId}/0.body`;
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for state: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

test(
  "MailboxDO fences R2 deletion ownership across live interleavings and ambiguous retries",
  { timeout: 45_000 },
  async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "mail-r2-race-"));
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
            wrappedBindings: { BUCKET: "controlled-r2" },
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
          {
            name: "controlled-r2",
            modules: true,
            r2Buckets: { INNER: "r2-deletion-race" },
            kvNamespaces: { CONTROL: "r2-deletion-race-control" },
            script: CONTROLLED_R2_WRAPPER,
          },
        ],
      });

      const control = await runtime.getKVNamespace("CONTROL", "controlled-r2");
      async function rpc<T>(
        mailbox: string,
        path: string,
        body: unknown,
      ): Promise<T> {
        const response = await runtime!.dispatchFetch(
          `http://race.test${path}?mailbox=${encodeURIComponent(mailbox)}`,
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
      async function state(
        mailbox: string,
        emailId: string,
        attemptId: string,
        r2Key: string,
      ): Promise<JsonRecord> {
        return rpc(mailbox, "/state", { emailId, attemptId, r2Key });
      }
      async function resetControl(mode: string) {
        await control.put("mode", mode);
        await control.delete("release");
        await control.delete("delete-started");
      }

      const raceMailbox = "race@example.com";
      const emailId = "race-email";
      const attemptA = "00000000-0000-4000-8000-000000000001";
      const attemptB = "00000000-0000-4000-8000-000000000002";
      const keyA = key(emailId, attemptA);
      const keyB = key(emailId, attemptB);
      const intendedSiblingKey = `email-bodies/${emailId}/${attemptA}/1.body`;
      const discardedKey = `email-bodies/${emailId}/${attemptA}/2.body`;
      await resetControl("pause-before-delete");
      await rpc(raceMailbox, "/seed", {
        emailId,
        attemptId: attemptA,
        r2Key: keyA,
        body: "body",
      });
      await Promise.all([
        rpc(raceMailbox, "/put", {
          r2Key: intendedSiblingKey,
          body: "body",
        }),
        rpc(raceMailbox, "/put", {
          r2Key: discardedKey,
          body: "body",
        }),
      ]);
      const pausedAlarm = rpc(raceMailbox, "/alarm", {});
      await waitFor(
        () => control.get("delete-started"),
        (value) => value === "1",
      );

      assert.deepEqual(
        await rpc(raceMailbox, "/create", {
          emailId,
          attemptId: attemptA,
          ownedKeys: [keyA, intendedSiblingKey],
          cleanupKey: discardedKey,
        }),
        { status: "cleanup_conflict" },
      );
      const queuedOnConflict = await state(
        raceMailbox,
        emailId,
        attemptA,
        discardedKey,
      );
      assert.equal((queuedOnConflict.outbox as JsonRecord).state, "pending");
      assert.equal(queuedOnConflict.objectExists, true);
      assert.equal(queuedOnConflict.email, undefined);
      const queuedIntendedSibling = await state(
        raceMailbox,
        emailId,
        attemptA,
        intendedSiblingKey,
      );
      assert.equal(
        (queuedIntendedSibling.outbox as JsonRecord).state,
        "pending",
      );
      assert.equal(queuedIntendedSibling.objectExists, true);
      await rpc(raceMailbox, "/seed", {
        emailId,
        attemptId: attemptB,
        r2Key: keyB,
        body: "body",
      });
      assert.deepEqual(
        await rpc(raceMailbox, "/create", {
          emailId,
          attemptId: attemptB,
          ownedKey: keyB,
        }),
        { status: "stored", cleanupKeys: [] },
      );
      const repairConflict = await rpc<JsonRecord>(raceMailbox, "/repair", {
        emailId,
        attemptId: attemptA,
        ownedKey: keyA,
      });
      assert.equal(repairConflict.status, "cleanup_conflict");
      assert.equal(
        (await state(raceMailbox, emailId, attemptA, keyA)).email !== undefined,
        true,
      );

      await control.put("release", "1");
      await pausedAlarm;
      await rpc(raceMailbox, "/alarm", {});
      const completed = await state(raceMailbox, emailId, attemptA, keyA);
      assert.equal(completed.objectExists, false);
      assert.equal(completed.outbox, undefined);
      assert.notEqual(completed.retiredAttempt, undefined);
      assert.equal((completed.repairAttempt as JsonRecord).outcome, "rejected");
      const cleanedConflictLoser = await state(
        raceMailbox,
        emailId,
        attemptA,
        discardedKey,
      );
      assert.equal(cleanedConflictLoser.outbox, undefined);
      assert.equal(cleanedConflictLoser.objectExists, false);
      const cleanedIntendedSibling = await state(
        raceMailbox,
        emailId,
        attemptA,
        intendedSiblingKey,
      );
      assert.equal(cleanedIntendedSibling.outbox, undefined);
      assert.equal(cleanedIntendedSibling.objectExists, false);

      assert.deepEqual(
        await rpc(raceMailbox, "/create", {
          emailId,
          attemptId: attemptA,
          cleanupKey: keyA,
        }),
        { status: "duplicate", cleanupKeys: [keyA] },
      );
      await rpc(raceMailbox, "/clear-alarm", {});

      const ambiguousMailbox = "ambiguous@example.com";
      const ambiguousEmail = "ambiguous-email";
      const attemptC = "00000000-0000-4000-8000-000000000003";
      const keyC = key(ambiguousEmail, attemptC);
      await resetControl("delete-then-throw");
      await rpc(ambiguousMailbox, "/seed", {
        emailId: ambiguousEmail,
        attemptId: attemptC,
        r2Key: keyC,
        body: "body",
      });
      const ambiguousAlarm = await rpc<JsonRecord>(
        ambiguousMailbox,
        "/alarm",
        {},
      );
      const ambiguous = await state(
        ambiguousMailbox,
        ambiguousEmail,
        attemptC,
        keyC,
      );
      assert.equal(ambiguous.objectExists, false);
      assert.equal((ambiguous.outbox as JsonRecord).state, "deleting");
      assert.equal((ambiguous.outbox as JsonRecord).claim_generation, 1);
      assert.notEqual(ambiguous.retiredAttempt, undefined);
      assert.equal(typeof ambiguousAlarm.scheduledAlarm, "number");
      assert.deepEqual(
        await rpc(ambiguousMailbox, "/create", {
          emailId: ambiguousEmail,
          attemptId: attemptC,
          ownedKey: keyC,
        }),
        { status: "cleanup_conflict" },
      );
      await rpc(ambiguousMailbox, "/expire", { r2Key: keyC });
      await resetControl("normal");
      await rpc(ambiguousMailbox, "/alarm", {});
      const retried = await state(
        ambiguousMailbox,
        ambiguousEmail,
        attemptC,
        keyC,
      );
      assert.equal(retried.outbox, undefined);
      assert.equal(retried.objectExists, false);
      assert.notEqual(retried.retiredAttempt, undefined);

      const pendingMailbox = "pending@example.com";
      const pendingEmail = "pending-email";
      const attemptD = "00000000-0000-4000-8000-000000000004";
      const keyD = key(pendingEmail, attemptD);
      await rpc(pendingMailbox, "/seed", {
        emailId: pendingEmail,
        attemptId: attemptD,
        r2Key: keyD,
        body: "body",
      });
      assert.deepEqual(
        await rpc(pendingMailbox, "/create", {
          emailId: pendingEmail,
          attemptId: attemptD,
          ownedKey: keyD,
        }),
        { status: "stored", cleanupKeys: [] },
      );
      await rpc(pendingMailbox, "/alarm", {});
      const pendingWon = await state(
        pendingMailbox,
        pendingEmail,
        attemptD,
        keyD,
      );
      assert.equal(pendingWon.objectExists, true);
      assert.equal(pendingWon.outbox, undefined);
      assert.equal(pendingWon.retiredAttempt, undefined);

      const repairMailbox = "repair-siblings@example.com";
      const repairEmail = "repair-siblings-email";
      const repairAttempt = "00000000-0000-4000-8000-000000000008";
      const repairCurrentKey = key(repairEmail, repairAttempt);
      const repairDeletingKey = `email-bodies/${repairEmail}/${repairAttempt}/1.body`;
      const repairUnownedKey = `email-bodies/${repairEmail}/${repairAttempt}/2.body`;
      await rpc(repairMailbox, "/put", {
        r2Key: repairCurrentKey,
        body: "body",
      });
      assert.deepEqual(
        await rpc(repairMailbox, "/create", {
          emailId: repairEmail,
          attemptId: repairAttempt,
          ownedKey: repairCurrentKey,
        }),
        { status: "stored", cleanupKeys: [] },
      );
      await Promise.all([
        rpc(repairMailbox, "/seed", {
          emailId: repairEmail,
          attemptId: repairAttempt,
          r2Key: repairDeletingKey,
          body: "body",
        }),
        rpc(repairMailbox, "/put", {
          r2Key: repairUnownedKey,
          body: "body",
        }),
      ]);
      await resetControl("pause-before-delete");
      const repairDeleteCount = Number(await control.get("delete-count"));
      const repairAlarm = rpc(repairMailbox, "/alarm", {});
      await waitFor(
        () => control.get("delete-started"),
        (value) => Number(value) > repairDeleteCount,
      );
      const repairSiblingConflict = await rpc<JsonRecord>(
        repairMailbox,
        "/repair",
        {
          emailId: repairEmail,
          attemptId: repairAttempt,
          ownedKeys: [repairCurrentKey, repairDeletingKey, repairUnownedKey],
        },
      );
      assert.equal(repairSiblingConflict.status, "cleanup_conflict");
      const retainedRepairOwner = await state(
        repairMailbox,
        repairEmail,
        repairAttempt,
        repairCurrentKey,
      );
      assert.equal(retainedRepairOwner.outbox, undefined);
      assert.equal(retainedRepairOwner.objectExists, true);
      assert.equal((retainedRepairOwner.email as JsonRecord).body, "body");
      const queuedRepairSibling = await state(
        repairMailbox,
        repairEmail,
        repairAttempt,
        repairUnownedKey,
      );
      assert.equal((queuedRepairSibling.outbox as JsonRecord).state, "pending");
      assert.equal(queuedRepairSibling.objectExists, true);
      await control.put("release", "1");
      await repairAlarm;
      await rpc(repairMailbox, "/alarm", {});
      assert.equal(
        (
          await state(
            repairMailbox,
            repairEmail,
            repairAttempt,
            repairUnownedKey,
          )
        ).objectExists,
        false,
      );
      assert.equal(
        (
          await state(
            repairMailbox,
            repairEmail,
            repairAttempt,
            repairCurrentKey,
          )
        ).objectExists,
        true,
      );

      const genericPendingMailbox = "generic-pending@example.com";
      const genericPendingEmail = "generic-pending-email";
      const genericPendingKey = "imports/generic-pending/attachment.bin";
      await rpc(genericPendingMailbox, "/seed", {
        emailId: genericPendingEmail,
        attemptId: null,
        r2Key: genericPendingKey,
        body: "body",
      });
      assert.deepEqual(
        await rpc(genericPendingMailbox, "/create-generic", {
          emailId: genericPendingEmail,
          r2Key: genericPendingKey,
        }),
        { status: "stored" },
      );
      await rpc(genericPendingMailbox, "/alarm", {});
      const genericPending = await state(
        genericPendingMailbox,
        genericPendingEmail,
        attemptD,
        genericPendingKey,
      );
      assert.notEqual(genericPending.email, undefined);
      assert.equal(genericPending.outbox, undefined);
      assert.equal(genericPending.objectExists, true);

      const genericDeletingMailbox = "generic-deleting@example.com";
      const genericDeletingEmail = "generic-deleting-email";
      const genericDeletingKey = "imports/generic-deleting/attachment.bin";
      const genericUnownedSiblingKey =
        "imports/generic-deleting/unowned-sibling.bin";
      const genericLegacyOwnerEmail = "generic-owned-legacy";
      const genericLegacyOwnerAttachment = "generic-owned-legacy-att";
      const genericLegacyOwnerFilename = "legacy.bin";
      const genericLegacyOwnerKey = `attachments/${genericLegacyOwnerEmail}/${genericLegacyOwnerAttachment}/${genericLegacyOwnerFilename}`;
      await Promise.all([
        rpc(genericDeletingMailbox, "/put", {
          r2Key: genericUnownedSiblingKey,
          body: "body",
        }),
        rpc(genericDeletingMailbox, "/put", {
          r2Key: genericLegacyOwnerKey,
          body: "body",
        }),
      ]);
      assert.deepEqual(
        await rpc(genericDeletingMailbox, "/create-legacy-owner", {
          emailId: genericLegacyOwnerEmail,
          attachmentId: genericLegacyOwnerAttachment,
          filename: genericLegacyOwnerFilename,
        }),
        { status: "stored" },
      );
      await resetControl("pause-before-delete");
      const genericDeleteCount = Number(await control.get("delete-count"));
      await rpc(genericDeletingMailbox, "/seed", {
        emailId: genericDeletingEmail,
        attemptId: null,
        r2Key: genericDeletingKey,
        body: "body",
      });
      const genericDeletingAlarm = rpc(genericDeletingMailbox, "/alarm", {});
      await waitFor(
        () => control.get("delete-started"),
        (value) => Number(value) > genericDeleteCount,
      );
      assert.deepEqual(
        await rpc(genericDeletingMailbox, "/create-generic", {
          emailId: genericDeletingEmail,
          r2Keys: [
            genericDeletingKey,
            genericUnownedSiblingKey,
            genericLegacyOwnerKey,
          ],
        }),
        { status: "cleanup_conflict" },
      );
      const genericRejected = await state(
        genericDeletingMailbox,
        genericDeletingEmail,
        attemptD,
        genericDeletingKey,
      );
      assert.equal(genericRejected.email, undefined);
      assert.equal(genericRejected.attachmentCount, 0);
      assert.equal(typeof genericRejected.alarm, "number");
      const queuedGenericSibling = await state(
        genericDeletingMailbox,
        genericDeletingEmail,
        attemptD,
        genericUnownedSiblingKey,
      );
      assert.equal(
        (queuedGenericSibling.outbox as JsonRecord).state,
        "pending",
      );
      assert.equal(queuedGenericSibling.objectExists, true);
      const retainedLegacyOwner = await state(
        genericDeletingMailbox,
        genericLegacyOwnerEmail,
        attemptD,
        genericLegacyOwnerKey,
      );
      assert.equal(retainedLegacyOwner.outbox, undefined);
      assert.equal(retainedLegacyOwner.objectExists, true);
      await control.put("release", "1");
      await genericDeletingAlarm;
      await rpc(genericDeletingMailbox, "/alarm", {});
      assert.equal(
        (
          await state(
            genericDeletingMailbox,
            genericDeletingEmail,
            attemptD,
            genericUnownedSiblingKey,
          )
        ).objectExists,
        false,
      );
      assert.equal(
        (
          await state(
            genericDeletingMailbox,
            genericLegacyOwnerEmail,
            attemptD,
            genericLegacyOwnerKey,
          )
        ).objectExists,
        true,
      );

      const ownedMailbox = "owned-reread@example.com";
      const ownedBodyAttempt = "00000000-0000-4000-8000-000000000007";
      const ownedKeys = await rpc<JsonRecord>(
        ownedMailbox,
        "/seed-owned-races",
        {
          bodyAttemptId: ownedBodyAttempt,
        },
      );
      await resetControl("normal");
      const deleteCountBeforeOwned = await control.get("delete-count");
      await rpc(ownedMailbox, "/alarm", {});
      assert.equal(await control.get("delete-count"), deleteCountBeforeOwned);
      for (const [email, r2Key] of [
        ["owned-explicit", ownedKeys.explicitKey],
        ["owned-legacy", ownedKeys.legacyKey],
        ["owned-body", ownedKeys.bodyKey],
      ] as Array<[string, string]>) {
        const owned = await state(ownedMailbox, email, ownedBodyAttempt, r2Key);
        assert.equal(owned.objectExists, true, r2Key);
        assert.equal(owned.outbox, undefined, r2Key);
      }

      const legacyMailbox = "legacy@example.com";
      const legacyKey = "attachments/legacy-email/legacy.bin";
      await rpc(legacyMailbox, "/seed", {
        emailId: "legacy-email",
        attemptId: null,
        r2Key: legacyKey,
        body: "body",
      });
      await rpc(legacyMailbox, "/alarm", {});
      const legacy = await state(
        legacyMailbox,
        "legacy-email",
        attemptD,
        legacyKey,
      );
      assert.notEqual(legacy.exactFence, undefined);
      assert.equal(legacy.objectExists, false);

      const staleMailbox = "stale-finalizer@example.com";
      const staleEmail = "stale-finalizer-email";
      const staleAttempt = "00000000-0000-4000-8000-000000000006";
      const staleKey = key(staleEmail, staleAttempt);
      const staleDeleteCount = Number(await control.get("delete-count"));
      await resetControl("pause-before-delete");
      await rpc(staleMailbox, "/seed", {
        emailId: staleEmail,
        attemptId: staleAttempt,
        r2Key: staleKey,
        body: "body",
      });
      const staleAlarm = rpc(staleMailbox, "/alarm", {});
      await waitFor(
        () => control.get("delete-started"),
        (value) => Number(value) > staleDeleteCount,
      );
      await rpc(staleMailbox, "/expire", { r2Key: staleKey });
      await control.put("mode", "normal");
      await rpc(staleMailbox, "/alarm", {});
      await control.put("release", "1");
      await staleAlarm;
      const staleFinalized = await state(
        staleMailbox,
        staleEmail,
        staleAttempt,
        staleKey,
      );
      assert.equal(staleFinalized.outbox, undefined);
      assert.equal(staleFinalized.objectExists, false);
	      assert.notEqual(staleFinalized.retiredAttempt, undefined);

	      const poisonMailbox = "poison-isolation@example.com";
	      const poisonAttempt = "00000000-0000-4000-8000-000000000007";
	      const poisonKey = key("poison-email", poisonAttempt);
	      const validSiblingKey = "attachments/poison-email/valid.bin";
	      await resetControl("fail-key");
	      await control.put("fail-key", poisonKey);
	      await rpc(poisonMailbox, "/seed", {
			emailId: "poison-email",
			attemptId: poisonAttempt,
			r2Key: poisonKey,
			body: "body",
	      });
	      await rpc(poisonMailbox, "/seed", {
			emailId: "poison-email",
			attemptId: null,
			r2Key: validSiblingKey,
			body: "body",
	      });
	      await rpc(poisonMailbox, "/alarm", {});
	      assert.equal(
		(await state(poisonMailbox, "poison-email", poisonAttempt, validSiblingKey)).objectExists,
		false,
	      );
	      for (let attempt = 1; attempt < 6; attempt += 1) {
		await rpc(poisonMailbox, "/expire", { r2Key: poisonKey });
		await rpc(poisonMailbox, "/alarm", {});
	      }
	      const parkedR2 = await rpc<{
		items: Array<{ recoveryRef: string; generation: number; attempts: number }>;
	      }>(poisonMailbox, "/r2-deletion-parked", {});
	      assert.equal(parkedR2.items.length, 1);
	      assert.equal(parkedR2.items[0]!.attempts, 6);
	      const deleteCountAtR2Park = await control.get("delete-count");
	      await rpc(poisonMailbox, "/alarm", {});
	      assert.equal(await control.get("delete-count"), deleteCountAtR2Park);
	      await resetControl("normal");
	      assert.deepEqual(
		await rpc(poisonMailbox, "/r2-deletion-repair", {
		  recoveryRef: parkedR2.items[0]!.recoveryRef,
		  expectedGeneration: parkedR2.items[0]!.generation,
		}),
		{ status: "repaired", generation: parkedR2.items[0]!.generation + 1 },
	      );
	      await rpc(poisonMailbox, "/alarm", {});
	      assert.equal(
		(await state(poisonMailbox, "poison-email", poisonAttempt, poisonKey)).objectExists,
		false,
	      );

	      const legacyPoisonMailbox = "legacy-poison@example.com";
	      const legacyPoisonKey = "attachments/legacy-poison/poison.bin";
	      const legacyValidKey = "attachments/legacy-poison/valid.bin";
	      await resetControl("fail-key");
	      await control.put("fail-key", legacyPoisonKey);
	      await rpc(legacyPoisonMailbox, "/legacy-cleanup-queue", {
			emailId: "legacy-poison",
			r2Key: legacyPoisonKey,
	      });
	      await rpc(legacyPoisonMailbox, "/legacy-cleanup-queue", {
			emailId: "legacy-poison",
			r2Key: legacyValidKey,
	      });
	      await rpc(legacyPoisonMailbox, "/alarm", {});
	      await rpc(legacyPoisonMailbox, "/alarm", {});
	      assert.equal(
		(await state(legacyPoisonMailbox, "legacy-poison", poisonAttempt, legacyValidKey)).objectExists,
		false,
	      );
	      for (let attempt = 1; attempt < 7; attempt += 1) {
		await rpc(legacyPoisonMailbox, "/legacy-cleanup-expire", {});
		await rpc(legacyPoisonMailbox, "/alarm", {});
	      }
	      const parkedLegacy = await rpc<{
		items: Array<{ recoveryRef: string; generation: number; attempts: number }>;
	      }>(legacyPoisonMailbox, "/legacy-cleanup-parked", {});
	      assert.equal(parkedLegacy.items.length, 1);
	      assert.equal(parkedLegacy.items[0]!.attempts, 6);
	      const deleteCountAtLegacyPark = await control.get("delete-count");
	      await rpc(legacyPoisonMailbox, "/alarm", {});
	      assert.equal(await control.get("delete-count"), deleteCountAtLegacyPark);
	      await resetControl("normal");
	      await rpc(legacyPoisonMailbox, "/legacy-cleanup-repair", {
			recoveryRef: parkedLegacy.items[0]!.recoveryRef,
			expectedGeneration: parkedLegacy.items[0]!.generation,
	      });
	      await rpc(legacyPoisonMailbox, "/alarm", {});
	      assert.equal(
		(await state(legacyPoisonMailbox, "legacy-poison", poisonAttempt, legacyPoisonKey)).objectExists,
		false,
	      );

	      const boundedMailbox = "bounded@example.com";
      const boundedAttempt = "00000000-0000-4000-8000-000000000005";
	      await rpc(boundedMailbox, "/seed-batch", {
        emailId: "bounded-email",
        attemptId: boundedAttempt,
        count: 512,
      });
      for (let pass = 0; pass < 6; pass += 1) {
        await rpc(boundedMailbox, "/alarm", {});
      }
      assert.deepEqual(await rpc(boundedMailbox, "/outbox-count", {}), {
        count: 0,
      });
	      assert.ok(Number(await control.get("delete-count")) >= 512);
    } finally {
      await runtime?.dispose();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
