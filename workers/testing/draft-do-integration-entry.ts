import type { ActivityActor } from "../lib/activity.ts";
import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class DraftTestMailboxDO extends MailboxDO {
	draftStateForTest() {
		const emails = [...this.ctx.storage.sql.exec(
			`SELECT id, draft_version AS draftVersion, draft_create_key AS createKey
			 FROM emails
			 WHERE draft_create_key IS NOT NULL
			 ORDER BY id`,
		)];
		const activities = [...this.ctx.storage.sql.exec(
			`SELECT action, entity_id AS entityId
			 FROM activity_events
			 WHERE action IN ('draft_created', 'draft_updated')
			 ORDER BY occurred_at, id`,
		)];
		const operations = [...this.ctx.storage.sql.exec(
			`SELECT create_key AS createKey, draft_id AS draftId,
			        draft_version AS draftVersion, state
			 FROM draft_create_operations
			 ORDER BY create_key`,
		)];
		const saveOperations = [...this.ctx.storage.sql.exec(
			`SELECT save_key AS saveKey, fingerprint, draft_id AS draftId,
			        expected_version AS expectedVersion, state, claim_token AS claimToken,
			        committed_version AS committedVersion
			 FROM draft_save_operations
			 ORDER BY save_key`,
		)];
		const cleanupIntents = [...this.ctx.storage.sql.exec(
			`SELECT claim_token AS claimToken, draft_id AS draftId,
			        destination_keys AS destinationKeys,
			        next_attempt_at AS nextAttemptAt, verify_until AS verifyUntil,
			        attempts
			 FROM draft_save_cleanup_intents
			 ORDER BY claim_token`,
		)];
		return { emails, activities, operations, saveOperations, cleanupIntents };
	}

	seedDraftSaveOperationsForTest(input: {
		count: number;
		state: "claimed" | "committed" | "aborted";
		updatedAt: string;
		prefix: string;
	}) {
		for (let index = 0; index < input.count; index += 1) {
			this.ctx.storage.sql.exec(
				`INSERT INTO draft_save_operations(
					save_key, fingerprint, draft_id, expected_version, state,
					destination_keys, committed_version, claim_expires_at,
					updated_at, claim_token
				) VALUES (?, ?, ?, 1, ?, '[]', ?, ?, ?, ?)`,
				`${input.prefix}-${index}`,
				`fingerprint-${input.prefix}-${index}`,
				`draft-${input.prefix}-${index}`,
				input.state,
				input.state === "committed" ? 2 : null,
				Date.now() + 300_000,
				input.updatedAt,
				`token-${input.prefix}-${index}`,
			);
		}
	}

	makeDraftSaveCleanupDueForTest(claimToken: string) {
		this.ctx.storage.sql.exec(
			`UPDATE draft_save_cleanup_intents
			 SET next_attempt_at = ?
			 WHERE claim_token = ?`,
			Date.now() - 1,
			claimToken,
		);
	}

	runAlarmForTest() {
		return this.alarm();
	}
}

type DraftTestStub = DurableObjectStub<DraftTestMailboxDO> & {
	draftStateForTest(): Promise<{
		emails: Array<Record<string, unknown>>;
		activities: Array<Record<string, unknown>>;
			operations: Array<Record<string, unknown>>;
			saveOperations?: Array<Record<string, unknown>>;
			cleanupIntents?: Array<Record<string, unknown>>;
	}>;
	seedDraftSaveOperationsForTest(input: Parameters<
		DraftTestMailboxDO["seedDraftSaveOperationsForTest"]
	>[0]): Promise<void>;
	makeDraftSaveCleanupDueForTest(claimToken: string): Promise<void>;
	runAlarmForTest(): Promise<void>;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as DraftTestStub;
		if (url.pathname === "/state") {
			return Response.json(await stub.draftStateForTest());
		}
		if (url.pathname === "/seed-save-operations") {
			const body = await request.json() as Parameters<
				DraftTestMailboxDO["seedDraftSaveOperationsForTest"]
			>[0];
			await stub.seedDraftSaveOperationsForTest(body);
			return Response.json({ seeded: body.count });
		}
		if (url.pathname === "/make-cleanup-due") {
			const body = await request.json() as { claimToken: string };
			await stub.makeDraftSaveCleanupDueForTest(body.claimToken);
			return Response.json({ scheduled: true });
		}
		if (url.pathname === "/run-alarm") {
			await stub.runAlarmForTest();
			return Response.json({ completed: true });
		}
		if (url.pathname === "/put-owned-object") {
			const body = await request.json() as {
				key: string;
				promotionOwner: string;
			};
			await env.BUCKET.put(body.key, new Uint8Array([1, 2, 3]), {
				customMetadata: { promotionOwner: body.promotionOwner },
			});
			return Response.json({ stored: true });
		}
		if (url.pathname === "/object-exists") {
			const body = await request.json() as { key: string };
			return Response.json({ exists: (await env.BUCKET.head(body.key)) !== null });
		}
		if (url.pathname === "/upsert") {
			const body = await request.json() as {
				input: Parameters<MailboxDO["upsertDraft"]>[0];
				actor: ActivityActor;
			};
			return Response.json(await stub.upsertDraft(body.input, [], body.actor));
		}
		if (url.pathname === "/claim-save") {
			const body = await request.json() as Parameters<MailboxDO["claimDraftSave"]>[0];
			return Response.json(await stub.claimDraftSave(body));
		}
		if (url.pathname === "/record-save-promotion") {
			const body = await request.json() as {
				saveKey: string;
				fingerprint: string;
				claimToken: string;
				destinationKeys: string[];
			};
			return Response.json({
				recorded: await stub.recordDraftSavePromotion(
					body.saveKey,
					body.fingerprint,
					body.claimToken,
					body.destinationKeys,
				),
			});
		}
		if (url.pathname === "/save-outcome") {
			const body = await request.json() as { saveKey: string; fingerprint: string };
			return Response.json(
				await stub.getDraftSaveOutcome(body.saveKey, body.fingerprint),
			);
		}
		if (url.pathname === "/discard") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.discardDraft(body.draftId, body.draftVersion, body.actor),
			);
		}
		if (url.pathname === "/consume") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.consumeDraftVersion(body.draftId, body.draftVersion, body.actor),
			);
		}
		if (url.pathname === "/delete") {
			const body = await request.json() as { draftId: string };
			const deleted = await stub.deleteEmail(body.draftId);
			return Response.json({ status: deleted ? "deleted" : "missing" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
