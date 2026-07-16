import { DurableObject } from "cloudflare:workers";
import { MailboxDO } from "../durableObject/index.ts";
import {
  receiveEmail,
  type InboundArchivePointer,
} from "../inbound-email.ts";
import { processInboundBatch } from "../inbound-queue.ts";
import type { Env } from "../types.ts";

type CanaryControlState = {
  phase: string;
  expected: number;
  active: number;
  maxActive: number;
  entered: string[];
  ingressActive: number;
  ingressMaxActive: number;
  ingressEntered: string[];
  ingressCompleted: string[];
  completed: Record<
    string,
    { acknowledgements: number; retries: number; failure: string | null }
  >;
};

type CanaryEnvironment = Env & {
  CANARY_CONCURRENCY: string;
  CANARY_PHASE: string;
  CANARY_QUEUE_NAME: string;
  CONTROL: DurableObjectNamespace<CanaryControlDO>;
  INBOUND_QUEUE: Queue<InboundArchivePointer>;
  RAW_MAIL_BUCKET: R2Bucket;
} & {
  [key: `CANARY_QUEUE_${number}`]: Queue<InboundArchivePointer>;
};

const CONTROL_KEY = "state";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function boundedPositiveInteger(value: unknown, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Canary integer is outside its allowed range");
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export class CanaryMailboxDO extends MailboxDO {}

export class CanaryControlDO extends DurableObject<CanaryEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(
        (await this.ctx.storage.get<CanaryControlState>(CONTROL_KEY)) ?? null,
      );
    }
    if (request.method !== "POST") return json({ error: "not_found" }, 404);

    const body = (await request.json()) as Record<string, unknown>;
    const phase = requiredString(body.phase, "phase");
    const queueName = requiredString(body.queueName, "queueName");
    const expected = boundedPositiveInteger(body.expected, 4);

    if (url.pathname === "/enter") {
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<CanaryControlState>(CONTROL_KEY);
        const state: CanaryControlState = current ?? {
          phase,
          expected,
          active: 0,
          maxActive: 0,
          entered: [],
          ingressActive: 0,
          ingressMaxActive: 0,
          ingressEntered: [],
          ingressCompleted: [],
          completed: {},
        };
        if (state.phase !== phase || state.expected !== expected) {
          throw new Error("Canary barrier identity changed during a phase");
        }
        if (state.entered.includes(queueName)) {
          throw new Error("Canary queue entered the barrier more than once");
        }
        state.entered.push(queueName);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await transaction.put(CONTROL_KEY, state);
      });

      const deadline = Date.now() + 60_000;
      while (true) {
        const state = await this.ctx.storage.get<CanaryControlState>(CONTROL_KEY);
        if (state?.maxActive === expected) return json({ status: "released" });
        if (Date.now() >= deadline) {
          throw new Error("Canary queue concurrency barrier timed out");
        }
        // Per Cloudflare's Durable Objects input-gate model, waiting yields so
        // the other Queue invocations can enter this same control object.
        await scheduler.wait(5);
      }
    }

    if (url.pathname === "/ingress-enter") {
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<CanaryControlState>(CONTROL_KEY);
        const state: CanaryControlState = current ?? {
          phase,
          expected,
          active: 0,
          maxActive: 0,
          entered: [],
          ingressActive: 0,
          ingressMaxActive: 0,
          ingressEntered: [],
          ingressCompleted: [],
          completed: {},
        };
        if (state.phase !== phase || state.expected !== expected) {
          throw new Error("Canary barrier identity changed during a phase");
        }
        if (state.ingressEntered.includes(queueName)) {
          throw new Error("Canary ingress entered the barrier more than once");
        }
        state.ingressEntered.push(queueName);
        state.ingressActive += 1;
        state.ingressMaxActive = Math.max(
          state.ingressMaxActive,
          state.ingressActive,
        );
        await transaction.put(CONTROL_KEY, state);
      });

      const deadline = Date.now() + 60_000;
      while (true) {
        const state = await this.ctx.storage.get<CanaryControlState>(CONTROL_KEY);
        if (state?.ingressMaxActive === expected) {
          return json({ status: "released" });
        }
        if (Date.now() >= deadline) {
          throw new Error("Canary ingress concurrency barrier timed out");
        }
        // Per Cloudflare's Durable Objects input-gate model, waiting yields so
        // every maximum-size ingress request can enter before body processing.
        await scheduler.wait(5);
      }
    }

    if (url.pathname === "/ingress-leave") {
      await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get<CanaryControlState>(CONTROL_KEY);
        if (!state || state.phase !== phase || state.expected !== expected) {
          throw new Error("Canary ingress barrier state is unavailable");
        }
        if (
          !state.ingressEntered.includes(queueName) ||
          state.ingressCompleted.includes(queueName)
        ) {
          throw new Error("Canary ingress completion is not unique");
        }
        state.ingressActive -= 1;
        state.ingressCompleted.push(queueName);
        await transaction.put(CONTROL_KEY, state);
      });
      return json({ status: "recorded" });
    }

    if (url.pathname === "/leave") {
      const acknowledgements = boundedPositiveInteger(
        body.acknowledgements,
        1,
      );
      const retries =
        body.retries === 0 ? 0 : boundedPositiveInteger(body.retries, 1);
      const failure =
        body.failure === null ? null : requiredString(body.failure, "failure");
      await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get<CanaryControlState>(CONTROL_KEY);
        if (!state || state.phase !== phase || state.expected !== expected) {
          throw new Error("Canary barrier state is unavailable at completion");
        }
        if (!state.entered.includes(queueName) || state.completed[queueName]) {
          throw new Error("Canary queue completion is not unique");
        }
        state.active -= 1;
        state.completed[queueName] = { acknowledgements, retries, failure };
        await transaction.put(CONTROL_KEY, state);
      });
      return json({ status: "recorded" });
    }

    return json({ error: "not_found" }, 404);
  }
}

function controlStub(env: CanaryEnvironment): DurableObjectStub<CanaryControlDO> {
  return env.CONTROL.get(env.CONTROL.idFromName(env.CANARY_PHASE));
}

async function controlRequest(
  env: CanaryEnvironment,
  path: "/enter" | "/leave" | "/ingress-enter" | "/ingress-leave",
  body: Record<string, unknown>,
): Promise<void> {
  const response = await controlStub(env).fetch(`http://control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: env.CANARY_PHASE,
      expected: Number(env.CANARY_CONCURRENCY),
      queueName: env.CANARY_QUEUE_NAME,
      ...body,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function receiveCanaryEmail(
  request: Request,
  env: CanaryEnvironment,
): Promise<Response> {
  const mailboxId = new URL(request.url).searchParams.get("mailbox");
  const rawSize = Number(request.headers.get("content-length"));
  if (!mailboxId || !request.body || !Number.isSafeInteger(rawSize)) {
    return json({ error: "invalid_ingress_request" }, 400);
  }

  let pointer: InboundArchivePointer | undefined;
  let rejection: string | undefined;
  await controlRequest(env, "/ingress-enter", { queueName: mailboxId });
  try {
    await receiveEmail(
      {
        to: mailboxId,
        raw: request.body,
        rawSize,
        forward: async () => {
          throw new Error("Canary ingress attempted emergency forwarding");
        },
        setReject(message: string) {
          rejection = message;
        },
      },
      {
        ...env,
        INBOUND_QUEUE: {
          async send(value: InboundArchivePointer) {
            if (pointer) throw new Error("Canary ingress emitted two pointers");
            pointer = value;
          },
        },
      },
      { waitUntil() {} },
    );
  } finally {
    await controlRequest(env, "/ingress-leave", { queueName: mailboxId });
  }
  if (rejection) return json({ error: "smtp_rejected", rejection }, 500);
  if (!pointer) return json({ error: "pointer_not_emitted" }, 500);
  return json(pointer);
}

async function mailboxState(
  request: Request,
  env: CanaryEnvironment,
): Promise<Response> {
  const url = new URL(request.url);
  const mailboxId = url.searchParams.get("mailbox");
  const emailId = url.searchParams.get("email");
  if (!mailboxId || !emailId) return json({ error: "missing_identity" }, 400);
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
  const [email, manifest] = await Promise.all([
    mailbox.getEmail(emailId),
    mailbox.getInboundDerivedContentManifest(emailId),
  ]);
  return json({ email, manifest });
}

async function setupCanary(
  request: Request,
  env: CanaryEnvironment,
): Promise<Response> {
  const body = (await request.json()) as { mailboxes?: unknown };
  if (
    !Array.isArray(body.mailboxes) ||
    body.mailboxes.length < 1 ||
    body.mailboxes.length > 4
  ) {
    return json({ error: "invalid_mailboxes" }, 400);
  }
  const mailboxes = body.mailboxes.map((value) =>
    requiredString(value, "mailbox"),
  );
  await env.DB.prepare(
    "CREATE TABLE mailboxes (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, type TEXT NOT NULL, owner_user_id TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();
  const now = Date.now();
  for (const [index, mailboxId] of mailboxes.entries()) {
    await env.DB.prepare(
      "INSERT INTO mailboxes (id,address,type,owner_user_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(mailboxId, mailboxId, "SHARED", null, 1, now + index, now + index)
      .run();
    await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}", {
      httpMetadata: { contentType: "application/json" },
    });
  }
  return json({ seeded: mailboxes.length });
}

async function enqueueCanaryPointer(
  request: Request,
  env: CanaryEnvironment,
): Promise<Response> {
  const body = (await request.json()) as {
    index?: unknown;
    pointer?: InboundArchivePointer;
  };
  const index = boundedPositiveInteger(body.index, 4);
  if (!body.pointer || typeof body.pointer !== "object") {
    return json({ error: "invalid_pointer" }, 400);
  }
  const queue = env[`CANARY_QUEUE_${index}`];
  if (!queue) return json({ error: "queue_not_bound" }, 400);
  await queue.send(body.pointer);
  return json({ enqueued: true });
}

async function verificationState(
  request: Request,
  env: CanaryEnvironment,
): Promise<Response> {
  const url = new URL(request.url);
  const mailboxId = url.searchParams.get("mailbox");
  const emailId = url.searchParams.get("email");
  const rawKey = url.searchParams.get("rawKey");
  if (!mailboxId || !emailId || !rawKey) {
    return json({ error: "missing_identity" }, 400);
  }
  const [raw, receiptObject, mailboxResponse] = await Promise.all([
    env.RAW_MAIL_BUCKET.get(rawKey),
    env.RAW_MAIL_BUCKET.get(`receipts/${emailId}.json`),
    mailboxState(
      new Request(
        `http://canary/mailbox-state?mailbox=${encodeURIComponent(mailboxId)}&email=${encodeURIComponent(emailId)}`,
      ),
      env,
    ),
  ]);
  if (!raw || !receiptObject || !mailboxResponse.ok) {
    return json({ error: "verification_state_missing" }, 404);
  }
  const [rawBytes, receiptText, projection] = await Promise.all([
    raw.arrayBuffer(),
    receiptObject.text(),
    mailboxResponse.json() as Promise<{
      email: unknown;
      manifest: {
        attachments?: Array<{ r2Key: string }>;
      };
    }>,
  ]);
  const derived: Array<{
    r2Key: string;
    byteLength: number;
    sha256: string;
    customMetadata: Record<string, string>;
    contentType: string | null;
  }> = [];
  for (const attachment of projection.manifest.attachments ?? []) {
    const object = await env.BUCKET.get(attachment.r2Key);
    if (!object) return json({ error: "derived_object_missing" }, 404);
    const bytes = await object.arrayBuffer();
    derived.push({
      r2Key: attachment.r2Key,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      customMetadata: object.customMetadata ?? {},
      contentType: object.httpMetadata?.contentType ?? null,
    });
  }
  return json({
    raw: {
      byteLength: rawBytes.byteLength,
      sha256: await sha256Hex(rawBytes),
      size: raw.size,
      customMetadata: raw.customMetadata ?? {},
      contentType: raw.httpMetadata?.contentType ?? null,
    },
    receipt: {
      value: JSON.parse(receiptText) as unknown,
      customMetadata: receiptObject.customMetadata ?? {},
      contentType: receiptObject.httpMetadata?.contentType ?? null,
    },
    projection,
    derived,
  });
}

export default {
  async fetch(request: Request, env: CanaryEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/setup") {
      return setupCanary(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ingress") {
      return receiveCanaryEmail(request, env);
    }
    if (request.method === "POST" && url.pathname === "/enqueue") {
      return enqueueCanaryPointer(request, env);
    }
    if (request.method === "GET" && url.pathname === "/mailbox-state") {
      return mailboxState(request, env);
    }
    if (request.method === "GET" && url.pathname === "/control/status") {
      return controlStub(env).fetch("http://control/status");
    }
    if (request.method === "GET" && url.pathname === "/verification-state") {
      return verificationState(request, env);
    }
    return json({ error: "not_found" }, 404);
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: CanaryEnvironment,
  ): Promise<void> {
    if (
      batch.queue !== env.CANARY_QUEUE_NAME ||
      batch.messages.length !== 1
    ) {
      throw new Error("Canary Queue delivery topology changed");
    }
    await controlRequest(env, "/enter", {});

    let acknowledgements = 0;
    let retries = 0;
    let failure: string | null = null;
    const source = batch.messages[0];
    const wrapped = {
      id: source.id,
      timestamp: source.timestamp,
      body: source.body,
      attempts: source.attempts,
      ack() {
        if (acknowledgements + retries !== 0) {
          throw new Error("Canary Queue message received two dispositions");
        }
        acknowledgements += 1;
        source.ack();
      },
      retry(options?: QueueRetryOptions) {
        if (acknowledgements + retries !== 0) {
          throw new Error("Canary Queue message received two dispositions");
        }
        retries += 1;
        source.retry(options);
      },
    };

    try {
      await processInboundBatch({ messages: [wrapped] }, env);
      if (acknowledgements !== 1 || retries !== 0) {
        throw new Error("Canary Queue message was not acknowledged exactly once");
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await controlRequest(env, "/leave", {
        acknowledgements,
        retries,
        failure,
      });
    }
  },
};
