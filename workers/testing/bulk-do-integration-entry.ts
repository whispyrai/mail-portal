import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class BulkTestMailboxDO extends MailboxDO {
	scheduleAlarmForTest(delayMs = 0): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + Math.max(0, delayMs));
	}

	readStorageForTest(key: string): Promise<unknown> {
		return this.ctx.storage.get(key);
	}

	writeStorageForTest(key: string, value: unknown): Promise<void> {
		return this.ctx.storage.put(key, value);
	}

	listStorageForTest(prefix: string): Promise<Array<[string, unknown]>> {
		return this.ctx.storage.list({ prefix }).then((entries) => [...entries]);
	}
}

type BulkTestStub = DurableObjectStub<BulkTestMailboxDO> & {
	scheduleAlarmForTest(delayMs?: number): Promise<void>;
	readStorageForTest(key: string): Promise<unknown>;
	writeStorageForTest(key: string, value: unknown): Promise<void>;
	listStorageForTest(prefix: string): Promise<Array<[string, unknown]>>;
};

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as BulkTestStub;
		const body = request.method === "GET" ? null : await request.json();

		switch (url.pathname) {
			case "/reserve":
				return json(await stub.reserveBulkOperation(body as never));
			case "/enqueue":
				return json(await stub.enqueueBulkJob(body as never));
			case "/cancel": {
				const input = body as { operationId: string; actorUserId: string };
				return json(
					await stub.cancelBulkReservation(
						input.operationId,
						input.actorUserId,
					),
				);
			}
			case "/recover": {
				const input = body as { operationId: string; actorUserId: string };
				return json(
					await stub.getBulkJobByOperation(
						input.operationId,
						input.actorUserId,
					),
				);
			}
			case "/job": {
				const input = body as { jobId: string };
				return json(await stub.getBulkJob(input.jobId));
			}
			case "/alarm":
				await stub.scheduleAlarmForTest(
					(body as { delayMs?: number }).delayMs ?? 0,
				);
				return json({ ok: true });
			case "/storage/read":
				return json(await stub.readStorageForTest((body as { key: string }).key));
			case "/storage/write": {
				const input = body as { key: string; value: unknown };
				await stub.writeStorageForTest(input.key, input.value);
				return json({ ok: true });
			}
			case "/storage/list":
				return json(
					await stub.listStorageForTest((body as { prefix: string }).prefix),
				);
			default:
				return json({ error: "Not found" }, 404);
		}
	},
};
