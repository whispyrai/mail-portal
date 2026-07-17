import assert from "node:assert/strict";
import test from "node:test";
import {
  createQueueDisposition,
  runInboundWorkWithDeadline,
  type InboundDeadlineScheduler,
} from "./inbound-work-deadline.ts";

function createManualScheduler(): InboundDeadlineScheduler & {
  fire(): void;
} {
  let pending: (() => void) | null = null;
  return {
    setTimeout(callback) {
      assert.equal(pending, null);
      pending = callback;
      return 1;
    },
    clearTimeout(handle) {
      assert.equal(handle, 1);
      pending = null;
    },
    fire() {
      const callback = pending;
      assert.notEqual(callback, null);
      pending = null;
      callback();
    },
  };
}

test("a hung operation expires its scope and aborts cooperative work", async () => {
  const scheduler = createManualScheduler();
  let context:
    | {
        expiresAt: number;
        isActive(): boolean;
        signal: AbortSignal;
      }
    | undefined;
  const work = runInboundWorkWithDeadline(
    async (value) => {
      context = value;
      await new Promise<never>(() => undefined);
    },
    {
      now: () => 1_000,
      scheduler,
      timeoutMs: 60_000,
    },
  );

  await Promise.resolve();
  assert.equal(context?.expiresAt, 61_000);
  assert.equal(context?.isActive(), true);
  assert.equal(context?.signal.aborted, false);

  scheduler.fire();

  assert.deepEqual(await work, { status: "timed_out" });
  assert.equal(context?.isActive(), false);
  assert.equal(context?.signal.aborted, true);
});

test("a late completion cannot steal the Queue disposition from timeout recovery", async () => {
  const scheduler = createManualScheduler();
  const calls: string[] = [];
  const disposition = createQueueDisposition({
    ack() {
      calls.push("ack");
    },
    retry(options) {
      calls.push(`retry:${options?.delaySeconds ?? "default"}`);
    },
  });
  const attempt = disposition.createScope();
  let release!: () => void;
  const work = runInboundWorkWithDeadline(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      attempt.ack();
    },
    {
      now: () => 2_000,
      onExpire: () => attempt.close(),
      scheduler,
      timeoutMs: 75_000,
    },
  );

  scheduler.fire();
  assert.deepEqual(await work, { status: "timed_out" });
  assert.equal(disposition.retry({ delaySeconds: 30 }), true);

  release();
  await Promise.resolve();

  assert.deepEqual(calls, ["retry:30"]);
  assert.equal(attempt.ack(), false);
  assert.equal(disposition.ack(), false);
});

test("the first Queue disposition wins across all active scopes", () => {
  const calls: string[] = [];
  const disposition = createQueueDisposition({
    ack() {
      calls.push("ack");
    },
    retry(options) {
      calls.push(`retry:${options?.delaySeconds ?? "default"}`);
    },
  });
  const first = disposition.createScope();
  const second = disposition.createScope();

  assert.equal(first.ack(), true);
  assert.equal(second.retry({ delaySeconds: 30 }), false);
  assert.equal(disposition.retry({ delaySeconds: 300 }), false);
  assert.deepEqual(calls, ["ack"]);
});
