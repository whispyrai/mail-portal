export type InboundQueueRetryOptions = {
  delaySeconds?: number;
};

type InboundQueueDispositionTarget = {
  ack(): void;
  retry(options?: InboundQueueRetryOptions): void;
};

export type InboundQueueDispositionScope = {
  ack(): boolean;
  retry(options?: InboundQueueRetryOptions): boolean;
  close(): void;
  isActive(): boolean;
};

export type InboundQueueDisposition = {
  ack(): boolean;
  retry(options?: InboundQueueRetryOptions): boolean;
  createScope(): InboundQueueDispositionScope;
  isSettled(): boolean;
};

export function createQueueDisposition(
  target: InboundQueueDispositionTarget,
): InboundQueueDisposition {
  let settled = false;

  const ack = (): boolean => {
    if (settled) return false;
    settled = true;
    target.ack();
    return true;
  };
  const retry = (options?: InboundQueueRetryOptions): boolean => {
    if (settled) return false;
    settled = true;
    target.retry(options);
    return true;
  };

  return {
    ack,
    retry,
    createScope() {
      let active = true;
      return {
        ack() {
          return active && ack();
        },
        retry(options) {
          return active && retry(options);
        },
        close() {
          active = false;
        },
        isActive() {
          return active && !settled;
        },
      };
    },
    isSettled() {
      return settled;
    },
  };
}

export type InboundDeadlineScheduler = {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

const defaultScheduler: InboundDeadlineScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
};

export type InboundWorkDeadlineContext = {
  expiresAt: number;
  isActive(): boolean;
  signal: AbortSignal;
};

export type InboundWorkDeadlineResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timed_out" };

export async function runInboundWorkWithDeadline<T>(
  work: (context: InboundWorkDeadlineContext) => Promise<T>,
  options: {
    now?: () => number;
    onExpire?: () => void;
    scheduler?: InboundDeadlineScheduler;
    timeoutMs: number;
  },
): Promise<InboundWorkDeadlineResult<T>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Inbound work deadline must be a positive integer");
  }

  const scheduler = options.scheduler ?? defaultScheduler;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let active = true;
  let timedOut = false;
  const expiresAt = now() + options.timeoutMs;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<InboundWorkDeadlineResult<T>>((resolve) => {
    const handle = scheduler.setTimeout(() => {
      timedOut = true;
      active = false;
      controller.abort(new Error("Inbound work deadline expired"));
      options.onExpire?.();
      resolve({ status: "timed_out" });
    }, options.timeoutMs);
    timerHandle = handle;
  });
  const completion = Promise.resolve()
    .then(() =>
      work({
        expiresAt,
        isActive: () => active,
        signal: controller.signal,
      }),
    )
    .then<InboundWorkDeadlineResult<T>, InboundWorkDeadlineResult<T>>(
      (value) => ({ status: "completed", value }),
      (error) => ({ status: "failed", error }),
    );

  const result = await Promise.race([completion, timeout]);
  if (!timedOut) {
    active = false;
    if (timerHandle !== undefined) scheduler.clearTimeout(timerHandle);
  }
  return result;
}
