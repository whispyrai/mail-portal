import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const COMPATIBILITY_DATE = "2026-07-15";
const MINIFLARE_COMPATIBILITY_DATE = "2026-03-12";
const GLOBAL_TIMEOUT_MS = 15 * 60_000;
const PHASE_TIMEOUT_MS = 180_000;
const PHASE_HEARTBEAT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 10_000;
const BOUNDARY = "canary-boundary";

export const FIXTURE_LAYOUT = Object.freeze({
  rawBytes: 24_960_359,
  prefixBytes: 652,
  largeAttachmentBytes: 18_238_584,
  largeBase64Bytes: 24_318_112,
  largeWrappedBytes: 24_958_064,
  smallAttachmentBytes: 1_024,
  tailBytes: 1_640,
  epilogueBytes: 3,
});

const CHILD_ENV_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TZ",
  "USER",
];

class DetailedMiniflareLog extends Log {
  constructor(logFilePath) {
    super(LogLevel.VERBOSE);
    this.logFilePath = logFilePath;
    this.messages = [];
  }

  log(message) {
    this.messages.push(message);
    appendFileSync(this.logFilePath, `[miniflare] ${message}\n`, "utf8");
  }
}

class DetailedRuntimeOutput {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.messages = [];
  }

  handleStructuredLog = ({ timestamp, level, message }) => {
    const line = `[workerd:${level}] ${new Date(timestamp).toISOString()} ${message}`;
    this.messages.push(line);
    appendFileSync(this.logFilePath, `${line}\n`, "utf8");
  };

  handleStdio = (stdout, stderr) => {
    for (const [channel, stream] of [["stdout", stdout], ["stderr", stderr]]) {
      stream.on("data", (chunk) => {
        const message = Buffer.from(chunk).toString("utf8");
        const line = `[workerd-${channel}] ${message}`;
        this.messages.push(line);
        appendFileSync(this.logFilePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
      });
    }
  };
}

function defaultLogFilePath(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return resolve(
    "script-logs",
    `verify-inbound-exact-size-workerd-${timestamp}.log`,
  );
}

function createLogger(logFilePath = defaultLogFilePath()) {
  const resolved = resolve(logFilePath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(
    resolved,
    `verify-inbound-exact-size-workerd\nstarted_at=${new Date().toISOString()}\n`,
    "utf8",
  );
  const detail = (message) => appendFileSync(resolved, `${message}\n`, "utf8");
  const progress = (message) => {
    console.log(message);
    detail(message);
  };
  const failure = (message) => {
    console.error(message);
    detail(message);
  };
  return { detail, failure, logFilePath: resolved, progress };
}

function deterministicBytes(byteLength, seed) {
  const bytes = Buffer.allocUnsafe(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function wrapBase64(bytes) {
  const encoded = bytes.toString("base64");
  const lines = encoded.match(/.{1,76}/gu) ?? [];
  return { encoded, wrapped: `${lines.join("\r\n")}\r\n` };
}

function paddedHeader(name, targetBytes, surrounding) {
  const fixedBytes = Buffer.byteLength(`${name}: \r\n`, "ascii");
  const paddingBytes = targetBytes - Buffer.byteLength(surrounding, "ascii") - fixedBytes;
  assert.ok(paddingBytes >= 0, `${name} padding target is too small`);
  return `${name}: ${"p".repeat(paddingBytes)}\r\n`;
}

export function buildExactSizeFixture() {
  const largeAttachment = deterministicBytes(
    FIXTURE_LAYOUT.largeAttachmentBytes,
    0x6d_61_69_6c,
  );
  const smallAttachment = deterministicBytes(
    FIXTURE_LAYOUT.smallAttachmentBytes,
    0x63_61_6e_61,
  );
  const large = wrapBase64(largeAttachment);
  const small = wrapBase64(smallAttachment);
  assert.equal(large.encoded.length, FIXTURE_LAYOUT.largeBase64Bytes);
  assert.equal(Buffer.byteLength(large.wrapped, "ascii"), FIXTURE_LAYOUT.largeWrappedBytes);

  const prefixBeforePadding = [
    "From: Canary Sender <sender@example.net>\r\n",
    "To: Exact Size Recipient <recipient@wiserchat.ai>\r\n",
    "Subject: Exact size local workerd canary\r\n",
    "Date: Wed, 15 Jul 2026 12:00:00 +0000\r\n",
    "Message-ID: <exact-size-canary@example.net>\r\n",
    "MIME-Version: 1.0\r\n",
  ].join("");
  const prefixAfterPadding = [
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n`,
    "\r\n",
    `--${BOUNDARY}\r\n`,
    "Content-Type: text/plain; charset=utf-8\r\n",
    "Content-Transfer-Encoding: 7bit\r\n",
    "\r\n",
    "Local workerd exact-size canary.\r\n",
    `--${BOUNDARY}\r\n`,
    "Content-Type: application/octet-stream; name=large-canary.bin\r\n",
    "Content-Disposition: attachment; filename=large-canary.bin\r\n",
    "Content-Transfer-Encoding: base64\r\n",
    "\r\n",
  ].join("");
  const prefixSurrounding = prefixBeforePadding + prefixAfterPadding;
  const prefix =
    prefixBeforePadding +
    paddedHeader(
      "X-Canary-Prefix-Padding",
      FIXTURE_LAYOUT.prefixBytes,
      prefixSurrounding,
    ) +
    prefixAfterPadding;

  const tailBeforePadding = [
    `--${BOUNDARY}\r\n`,
    "Content-Type: application/octet-stream; name=small-canary.bin\r\n",
    "Content-Disposition: attachment; filename=small-canary.bin\r\n",
    "Content-Transfer-Encoding: base64\r\n",
  ].join("");
  const tailAfterPadding = [
    "\r\n",
    small.wrapped,
    `--${BOUNDARY}--`,
  ].join("");
  const tailSurrounding = tailBeforePadding + tailAfterPadding;
  const tail =
    tailBeforePadding +
    paddedHeader(
      "X-Canary-Tail-Padding",
      FIXTURE_LAYOUT.tailBytes,
      tailSurrounding,
    ) +
    tailAfterPadding;
  const epilogue = "\r\n\n";

  assert.equal(Buffer.byteLength(prefix, "ascii"), FIXTURE_LAYOUT.prefixBytes);
  assert.equal(Buffer.byteLength(tail, "ascii"), FIXTURE_LAYOUT.tailBytes);
  assert.equal(Buffer.byteLength(epilogue, "ascii"), FIXTURE_LAYOUT.epilogueBytes);
  const raw = Buffer.from(prefix + large.wrapped + tail + epilogue, "ascii");
  assert.equal(raw.byteLength, FIXTURE_LAYOUT.rawBytes);

  return { largeAttachment, raw, smallAttachment };
}

export function validateLocalViteBindingConfig(source) {
  const file = ts.createSourceFile(
    "vite.config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "cloudflare"
    ) {
      assert.equal(node.arguments.length, 1, "cloudflare must receive one options object");
      const options = node.arguments[0];
      assert.ok(ts.isObjectLiteralExpression(options), "cloudflare options must be static");
      for (const property of options.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "remoteBindings"
        ) {
          values.push(property.initializer.kind === ts.SyntaxKind.FalseKeyword);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(values, [true], "Vite must disable remote bindings unconditionally");
  assert.equal(
    source.match(/remoteBindings\s*:/gu)?.length,
    1,
    "Only the unconditional remote binding guard may configure remoteBindings",
  );
}

function sha256Hex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    Buffer.from(digest).toString("hex"),
  );
}

export function safeChildEnvironment(
  wranglerLogPath,
  sourceEnvironment = process.env,
) {
  const environment = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.flatMap((key) =>
      sourceEnvironment[key] === undefined ? [] : [[key, sourceEnvironment[key]]],
    ),
  );
  return {
    ...environment,
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: wranglerLogPath,
  };
}

export function wranglerBundleArguments(outputDirectory, emptyEnvironmentPath) {
  return [
    "deploy",
    "workers/testing/inbound-exact-size-canary-entry.ts",
    "--dry-run",
    "--outdir",
    outputDirectory,
    "--compatibility-date",
    COMPATIBILITY_DATE,
    "--compatibility-flag",
    "nodejs_compat",
    "--config",
    "wrangler.jsonc",
    "--env=",
    "--env-file",
    emptyEnvironmentPath,
    "--upload-source-maps=false",
  ];
}

function baseBindings(phase, concurrency, queueName) {
  return {
    BRAND: "wiser",
    FEATURES: [],
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    EMERGENCY_FORWARD_DESTINATION: "forbidden@example.invalid",
    AWS_REGION: "eu-west-2",
    AWS_ACCESS_KEY_ID: "local-only",
    AWS_SECRET_ACCESS_KEY: "local-only",
    SES_CONFIGURATION_SET: "local-only",
    SES_EVENT_WEBHOOK_SECRET: "local-only",
    AI_MODEL: "local-only",
    AI_CHEAP_MODEL: "local-only",
    AI_STRONG_MODEL: "local-only",
    AI_COST_ALERT_USD: "25",
    AI_COST_REVIEW_USD: "50",
    JWT_SECRET: "local-only",
    VAPID_SUBJECT: "mailto:test@example.invalid",
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
    ADMIN_BOOTSTRAP_EMAIL: "admin@example.invalid",
    ACCOUNT_RECOVERY_DIRECTORY: "{}",
    CANARY_PHASE: phase,
    CANARY_CONCURRENCY: String(concurrency),
    CANARY_QUEUE_NAME: queueName,
  };
}

function localResources(workerName, bundle, phase, concurrency, queueName) {
  return {
    name: workerName,
    modules: true,
    script: bundle,
    compatibilityDate: MINIFLARE_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    // Cloudflare Miniflare's outboundService hook receives every global fetch.
    // A Node-side response denies it without blocking Miniflare's own proxy.
    outboundService: () =>
      new Response("Outbound network denied by exact-size canary", {
        status: 599,
      }),
    d1Databases: { DB: "canary-d1" },
    r2Buckets: {
      BUCKET: "canary-derived-r2",
      RAW_MAIL_BUCKET: "canary-raw-r2",
    },
    kvNamespaces: { OAUTH_KV: "canary-oauth-kv" },
    bindings: baseBindings(phase, concurrency, queueName),
  };
}

function createRuntimeOptions(bundle, concurrency, miniflareLog, runtimeOutput) {
  const phase = `phase-${concurrency}`;
  const main = {
    ...localResources("canary-main", bundle, phase, concurrency, "main-unused"),
    durableObjects: {
      MAILBOX: { className: "CanaryMailboxDO", useSQLite: true },
      CONTROL: { className: "CanaryControlDO", useSQLite: true },
    },
    queueProducers: Object.fromEntries(
      Array.from({ length: concurrency }, (_, index) => [
        `CANARY_QUEUE_${index + 1}`,
        `canary-${concurrency}-${index + 1}`,
      ]),
    ),
  };
  const consumers = Array.from({ length: concurrency }, (_, index) => {
    const queueName = `canary-${concurrency}-${index + 1}`;
    const workerName = `canary-consumer-${concurrency}-${index + 1}`;
    return {
      ...localResources(workerName, bundle, phase, concurrency, queueName),
      durableObjects: {
        MAILBOX: {
          className: "CanaryMailboxDO",
          scriptName: "canary-main",
          useSQLite: true,
        },
        CONTROL: {
          className: "CanaryControlDO",
          scriptName: "canary-main",
          useSQLite: true,
        },
      },
      queueProducers: { CANARY_QUEUE: queueName },
      queueConsumers: {
        [queueName]: {
          maxBatchSize: 1,
          maxBatchTimeout: 0.05,
          maxRetries: 0,
        },
      },
    };
  });
  return {
    cf: false,
    log: miniflareLog,
    handleRuntimeStdio: runtimeOutput.handleStdio,
    handleStructuredLogs: runtimeOutput.handleStructuredLog,
    workers: [main, ...consumers],
  };
}

async function bundleIntegrationWorker(outputDirectory, logger, signal) {
  logger.progress("Phase 1/6: bundling the repository-owned integration Worker");
  const wranglerLogPath = join(outputDirectory, "wrangler.log");
  const emptyEnvironmentPath = join(outputDirectory, "empty.env");
  writeFileSync(emptyEnvironmentPath, "", "utf8");
  await execFileAsync(
    join(ROOT, "node_modules/.bin/wrangler"),
    wranglerBundleArguments(outputDirectory, emptyEnvironmentPath),
    {
      cwd: ROOT,
      env: safeChildEnvironment(wranglerLogPath),
      maxBuffer: 16 * 1024 * 1024,
      signal,
    },
  );
  const wranglerLog = readFileSync(wranglerLogPath, "utf8");
  assert.doesNotMatch(
    wranglerLog,
    /Metrics dispatcher: Posting data|Loading environment variables from/iu,
    "Wrangler attempted telemetry or repository dotenv loading",
  );
  logger.detail(`wrangler_log=${wranglerLog}`);
  return readFile(
    join(outputDirectory, "inbound-exact-size-canary-entry.js"),
    "utf8",
  );
}

async function readJsonResponse(response, label) {
  const body = await response.text();
  assert.equal(response.status, 200, `${label}: ${body}`);
  return JSON.parse(body);
}

async function waitForControl(mainWorker, concurrency, fatalState) {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  let status = null;
  while (Date.now() < deadline) {
    if (fatalState.error) throw fatalState.error;
    status = await readJsonResponse(
      await mainWorker.fetch("http://canary/control/status"),
      "control status",
    );
    if (status && Object.keys(status.completed).length === concurrency) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for phase ${concurrency}: ${JSON.stringify(status)}`);
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

async function verifyProjection({
  pointer,
  mailboxId,
  fixture,
  mainWorker,
  logger,
}) {
  const expectedRawSha256 = await sha256Hex(fixture.raw);
  assert.equal(pointer.rawSize, FIXTURE_LAYOUT.rawBytes);
  assert.equal(pointer.rawSha256, expectedRawSha256);
  assert.equal(pointer.mailboxId, mailboxId);

  const verification = await readJsonResponse(
    await mainWorker.fetch(
      `http://canary/verification-state?mailbox=${encodeURIComponent(mailboxId)}&email=${encodeURIComponent(pointer.ingressId)}&rawKey=${encodeURIComponent(pointer.rawKey)}`,
    ),
    "independent verification state",
  );
  assert.equal(verification.raw.byteLength, FIXTURE_LAYOUT.rawBytes);
  assert.equal(verification.raw.sha256, expectedRawSha256);
  assert.equal(verification.raw.size, FIXTURE_LAYOUT.rawBytes);
  assert.equal(verification.raw.contentType, "message/rfc822");
  assert.deepEqual(verification.raw.customMetadata, {
    archivedAt: pointer.archivedAt,
    declaredRawSize: String(FIXTURE_LAYOUT.rawBytes),
    ingressId: pointer.ingressId,
    mailboxId,
    rawSha256: expectedRawSha256,
    rawSize: String(FIXTURE_LAYOUT.rawBytes),
    schemaVersion: "1",
  });

  assert.deepEqual(verification.receipt.customMetadata, { state: "stored" });
  assert.equal(verification.receipt.contentType, "application/json");
  const receipt = verification.receipt.value;
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "ingressId",
      "rawKey",
      "mailboxId",
      "rawSize",
      "rawSha256",
      "archivedAt",
      "etag",
      "version",
      "state",
      "updatedAt",
    ],
    "receipt",
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(pointer).map((key) => [key, receipt[key]])),
    pointer,
  );
  assert.equal(receipt.state, "stored");
  assert.ok(Number.isFinite(Date.parse(receipt.updatedAt)));

  const projection = verification.projection;
  assert.ok(projection.email, "projected email is present");
  assert.equal(projection.email.id, pointer.ingressId);
  assert.equal(projection.email.folder_id, "inbox");
  assert.equal(projection.email.read, false);
  assert.equal(projection.email.recipient_memory_origin, "live_inbound");
  assert.equal(projection.email.body_external, false);
  assert.deepEqual(projection.email.external_body_parts, []);
  assert.deepEqual(
    projection.email.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimetype: attachment.mimetype,
      size: attachment.size,
      disposition: attachment.disposition,
    })),
    [
      {
        filename: "large-canary.bin",
        mimetype: "application/octet-stream",
        size: FIXTURE_LAYOUT.largeAttachmentBytes,
        disposition: "attachment",
      },
      {
        filename: "small-canary.bin",
        mimetype: "application/octet-stream",
        size: FIXTURE_LAYOUT.smallAttachmentBytes,
        disposition: "attachment",
      },
    ],
  );

  const manifest = projection.manifest;
  exactKeys(
    manifest,
    ["status", "generation", "lastRepairMarkerId", "attachments", "bodyObjects"],
    "derived-content manifest",
  );
  assert.equal(manifest.status, "live_inbound");
  assert.equal(manifest.generation, 1);
  assert.equal(manifest.lastRepairMarkerId, null);
  assert.deepEqual(manifest.bodyObjects, []);
  assert.equal(manifest.attachments.length, 2);

  const expectedAttachments = [fixture.largeAttachment, fixture.smallAttachment];
  for (let index = 0; index < manifest.attachments.length; index += 1) {
    const metadata = manifest.attachments[index];
    exactKeys(metadata, ["id", "r2Key", "byteLength"], `manifest attachment ${index}`);
    assert.equal(metadata.byteLength, expectedAttachments[index].byteLength);
    assert.match(
      metadata.r2Key,
      new RegExp(`^attachments/${pointer.ingressId}/[A-Za-z0-9_-]+/`),
    );
    const object = verification.derived.find(
      (candidate) => candidate.r2Key === metadata.r2Key,
    );
    assert.ok(object, `derived object ${metadata.r2Key} is present`);
    assert.equal(object.byteLength, metadata.byteLength);
    assert.equal(object.sha256, await sha256Hex(expectedAttachments[index]));
    assert.deepEqual(object.customMetadata, {});
    assert.equal(object.contentType, null);
  }
  logger.detail(
    `verified_projection=${JSON.stringify({ mailboxId, pointer, manifest })}`,
  );
}

export function normalizedQueueCompletions(messages) {
  return messages
    .flatMap((message) => message.replace(/\u001b\[[0-9;]*m/gu, "").split("\n"))
    .map((line) => line.match(/QUEUE\s+([^\s]+)\s+(\d+)\/(\d+)/u))
    .filter(Boolean)
    .map((match) => `QUEUE ${match[1]} ${match[2]}/${match[3]}`);
}

function assertNoRuntimeTermination(messages) {
  const output = messages.join("\n");
  assert.doesNotMatch(
    output,
    /exceeded(?: the)? memory|exceededMemory|memory limit|out of memory|workerd[^\n]*(?:crash|fatal)|segmentation fault/iu,
    "workerd reported a memory-limit termination or crash",
  );
}

async function disposeRuntime(runtimeState, runtime = runtimeState.active) {
  if (runtimeState.disposing) {
    await runtimeState.disposing;
    return;
  }
  if (!runtime) return;
  if (runtimeState.active === runtime) runtimeState.active = null;
  // Cloudflare's Miniflare API docs require every instance to be disposed so
  // its local listeners and workerd process are stopped after the test run.
  const disposalWork = runtime.dispose().catch((error) => {
    if (!(error instanceof Error && error.code === "ERR_SERVER_NOT_RUNNING")) {
      throw error;
    }
  });
  let disposalTimer;
  const disposal = Promise.race([
    disposalWork,
    new Promise((_, reject) => {
      disposalTimer = setTimeout(
        () => reject(new Error("Miniflare disposal timed out")),
        DISPOSE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(disposalTimer));
  runtimeState.disposing = disposal;
  try {
    await disposal;
  } finally {
    if (runtimeState.disposing === disposal) runtimeState.disposing = null;
  }
}

function phaseProgress(runtimeState, concurrency, value, logger) {
  runtimeState.phaseProgress = { concurrency, value, updatedAt: Date.now() };
  logger.detail(`phase_${concurrency}_progress=${value}`);
}

export async function runWithPhaseDeadline({
  concurrency,
  logger,
  runtimeState,
  timeoutMs = PHASE_TIMEOUT_MS,
  work,
}) {
  const startedAt = Date.now();
  let timeout;
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
    const lastProgress = runtimeState.phaseProgress?.value ?? "starting";
    logger.progress(
      `Phase ${concurrency}: heartbeat elapsed=${elapsedSeconds}s concurrency=${concurrency} last=${lastProgress}`,
    );
  }, Math.min(PHASE_HEARTBEAT_MS, Math.max(1, Math.floor(timeoutMs / 2))));
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const lastProgress = runtimeState.phaseProgress?.value ?? "starting";
          logger.failure(
            `Phase ${concurrency}: TIMEOUT after ${timeoutMs}ms; last progress: ${lastProgress}`,
          );
          void disposeRuntime(runtimeState).catch((error) => {
            logger.detail(`phase_${concurrency}_timeout_dispose=${error.stack ?? error}`);
          });
          reject(
            new Error(
              `Exact-size phase ${concurrency} timed out after ${timeoutMs}ms; last progress: ${lastProgress}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

async function runPhase(
  bundle,
  concurrency,
  fixture,
  logger,
  fatalState,
  runtimeState,
) {
  const miniflareLog = new DetailedMiniflareLog(logger.logFilePath);
  const runtimeOutput = new DetailedRuntimeOutput(logger.logFilePath);
  const runtime = new Miniflare(
    createRuntimeOptions(bundle, concurrency, miniflareLog, runtimeOutput),
  );
  runtimeState.active = runtime;
  try {
    phaseProgress(runtimeState, concurrency, "runtime_constructed", logger);
    logger.detail(`phase_${concurrency}_runtime_constructed`);
    const mainWorker = {
      fetch: (input, init) => runtime.dispatchFetch(input, init),
    };
    logger.detail(`phase_${concurrency}_main_worker_ready`);
    const runtimeUrl = await runtime.ready;
    phaseProgress(runtimeState, concurrency, "runtime_listening", logger);
    logger.detail(`phase_${concurrency}_runtime_listening=${runtimeUrl.origin}`);
    const mailboxIds = Array.from(
      { length: concurrency },
      (_, index) => `exact-${concurrency}-${index + 1}@wiserchat.ai`,
    );
    await readJsonResponse(
      await mainWorker.fetch("http://canary/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mailboxes: mailboxIds }),
      }),
      "canary setup",
    );
    logger.detail(`phase_${concurrency}_local_resources_seeded`);
    phaseProgress(runtimeState, concurrency, "local_resources_seeded", logger);
    let archivedCount = 0;
    const pointers = await Promise.all(
      mailboxIds.map(async (mailboxId, index) => {
        const response = await mainWorker.fetch(
          `http://canary/ingress?mailbox=${encodeURIComponent(mailboxId)}`,
          {
            method: "POST",
            headers: {
              "content-length": String(FIXTURE_LAYOUT.rawBytes),
              "content-type": "message/rfc822",
            },
            body: fixture.raw,
          },
        );
        logger.detail(
          `phase_${concurrency}_mailbox_${index + 1}_ingress_returned`,
        );
        const archived = {
          mailboxId,
          pointer: await readJsonResponse(response, `ingress ${mailboxId}`),
        };
        archivedCount += 1;
        phaseProgress(
          runtimeState,
          concurrency,
          `ingress_archived_${archivedCount}_of_${concurrency}`,
          logger,
        );
        logger.progress(
          `Phase ${concurrency}: ingress archived ${archivedCount}/${concurrency}`,
        );
        return archived;
      }),
    );
    const ingressControl = await readJsonResponse(
      await mainWorker.fetch("http://canary/control/status"),
      "ingress control status",
    );
    assert.equal(
      ingressControl.ingressMaxActive,
      concurrency,
      "all maximum-size ingress requests reached the workerd barrier",
    );
    assert.equal(ingressControl.ingressActive, 0);
    assert.deepEqual(
      [...ingressControl.ingressEntered].sort(),
      [...mailboxIds].sort(),
    );
    assert.deepEqual(
      [...ingressControl.ingressCompleted].sort(),
      [...mailboxIds].sort(),
    );
    logger.detail(
      `phase_${concurrency}_ingress_control=${JSON.stringify(ingressControl)}`,
    );

    const queueNames = pointers.map(
      (_, index) => `canary-${concurrency}-${index + 1}`,
    );
    await Promise.all(
      pointers.map(async ({ pointer }, index) => {
        await readJsonResponse(
          await mainWorker.fetch("http://canary/enqueue", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ index: index + 1, pointer }),
          }),
          `queue enqueue ${index + 1}`,
        );
      }),
    );
    const control = await waitForControl(mainWorker, concurrency, fatalState);
    phaseProgress(runtimeState, concurrency, "queue_barrier_completed", logger);
    assert.equal(control.maxActive, concurrency, "all Queue invocations reached the barrier");
    assert.equal(control.active, 0);
    assert.deepEqual([...control.entered].sort(), [...queueNames].sort());
    assert.deepEqual(Object.keys(control.completed).sort(), [...queueNames].sort());
    for (const queueName of queueNames) {
      assert.deepEqual(control.completed[queueName], {
        acknowledgements: 1,
        retries: 0,
        failure: null,
      });
    }

    for (let index = 0; index < pointers.length; index += 1) {
      await verifyProjection({
        ...pointers[index],
        fixture,
        mainWorker,
        logger,
      });
      logger.progress(
        `Phase ${concurrency}: independently verified ${index + 1}/${concurrency}`,
      );
      phaseProgress(
        runtimeState,
        concurrency,
        `verified_${index + 1}_of_${concurrency}`,
        logger,
      );
    }

    const queueLines = normalizedQueueCompletions(miniflareLog.messages);
    for (const queueName of queueNames) {
      assert.equal(
        queueLines.filter((line) => line === `QUEUE ${queueName} 1/1`).length,
        1,
        `expected one normalized completion for ${queueName}`,
      );
      assert.equal(
        queueLines.filter((line) => line.startsWith(`QUEUE ${queueName} `)).length,
        1,
        `unexpected retry delivery for ${queueName}`,
      );
      logger.progress(`QUEUE ${queueName} 1/1`);
    }
    logger.detail(`phase_${concurrency}_control=${JSON.stringify(control)}`);
  } finally {
    await disposeRuntime(runtimeState, runtime);
  }
  assertNoRuntimeTermination([
    ...miniflareLog.messages,
    ...runtimeOutput.messages,
  ]);
}

export async function verifyInboundExactSizeWorkerd({
  logFilePath,
  phases = [1, 2, 3, 4],
} = {}) {
  const logger = createLogger(logFilePath);
  const outputDirectory = mkdtempSync(join(tmpdir(), "mail-exact-size-canary-"));
  const fatalState = { error: null };
  const runtimeState = { active: null, disposing: null };
  const abortController = new AbortController();
  let globalTimer;
  let rejectFatal;
  const fail = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    fatalState.error = normalized;
    abortController.abort();
    void disposeRuntime(runtimeState).catch(() => {});
    rejectFatal(normalized);
  };
  const handleUnhandledRejection = (error) => fail(error);
  const handleUncaughtException = (error) => fail(error);
  const handleSigint = () => fail(new Error("Canary interrupted by SIGINT"));
  const handleSigterm = () => fail(new Error("Canary interrupted by SIGTERM"));
  const fatalPromise = new Promise((_, reject) => {
    rejectFatal = reject;
    process.once("unhandledRejection", handleUnhandledRejection);
    process.once("uncaughtException", handleUncaughtException);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
  });
  const timeoutPromise = new Promise((_, reject) => {
    globalTimer = setTimeout(
      () => {
        abortController.abort();
        void disposeRuntime(runtimeState).catch(() => {});
        reject(new Error("Exact-size workerd canary exceeded its global timeout"));
      },
      GLOBAL_TIMEOUT_MS,
    );
  });

  logger.progress("Exact-size inbound workerd canary starting");
  logger.progress(`Detailed log: ${logger.logFilePath}`);
  logger.progress("Mode: local-only Miniflare/workerd, outbound fetch denied");
  logger.detail(`ignored_environment_keys=${JSON.stringify(Object.keys(process.env).filter((key) => !CHILD_ENV_ALLOWLIST.includes(key)).sort())}`);

  let failure = null;
  let result;
  try {
    validateLocalViteBindingConfig(readFileSync(resolve("vite.config.ts"), "utf8"));
    logger.progress("Phase 1/6: Vite remote bindings are disabled by default");
    const bundle = await Promise.race([
      bundleIntegrationWorker(outputDirectory, logger, abortController.signal),
      fatalPromise,
      timeoutPromise,
    ]);
    logger.progress("Phase 2/6: constructing the exact deterministic RFC822 fixture");
    const fixture = buildExactSizeFixture();
    logger.detail(`fixture_layout=${JSON.stringify(FIXTURE_LAYOUT)}`);
    logger.detail(`raw_sha256=${await sha256Hex(fixture.raw)}`);
    logger.detail(`large_attachment_sha256=${await sha256Hex(fixture.largeAttachment)}`);
    logger.detail(`small_attachment_sha256=${await sha256Hex(fixture.smallAttachment)}`);

    logger.progress(`Phase 3/6: fixture is exactly ${fixture.raw.byteLength} bytes`);
    for (let index = 0; index < phases.length; index += 1) {
      const concurrency = phases[index];
      assert.ok([1, 2, 3, 4].includes(concurrency), "unsupported canary phase");
      logger.progress(
        `Phase 4/6: local Queue pressure ${index + 1}/${phases.length}, concurrency ${concurrency}`,
      );
      await Promise.race([
        runWithPhaseDeadline({
          concurrency,
          logger,
          runtimeState,
          work: () => runPhase(
            bundle,
            concurrency,
            fixture,
            logger,
            fatalState,
            runtimeState,
          ),
        }),
        fatalPromise,
        timeoutPromise,
      ]);
    }
    logger.progress("Phase 5/6: all raw, receipt, manifest, and derived bytes verified");
    result = { logFilePath: logger.logFilePath, phases: [...phases] };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await Promise.race([disposeRuntime(runtimeState), timeoutPromise]);
    if (globalTimer) clearTimeout(globalTimer);
    process.off("unhandledRejection", handleUnhandledRejection);
    process.off("uncaughtException", handleUncaughtException);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    rmSync(outputDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    const normalized = cleanupError instanceof Error
      ? cleanupError
      : new Error(String(cleanupError));
    failure = failure
      ? new AggregateError([failure, normalized], "Canary execution and cleanup failed")
      : normalized;
  }
  failure ??= fatalState.error;
  if (failure) {
    logger.failure(`FAIL: ${failure.message}`);
    logger.detail(`failure_detail=${failure.stack ?? failure.message}`);
    throw failure;
  }
  assert.ok(result, "canary result is available after successful cleanup");
  logger.progress("Phase 6/6: PASS, no local workerd memory-limit termination observed");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyInboundExactSizeWorkerd();
}
