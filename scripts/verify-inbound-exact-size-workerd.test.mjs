import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FIXTURE_LAYOUT,
  buildExactSizeFixture,
  normalizedQueueCompletions,
  safeChildEnvironment,
  validateLocalViteBindingConfig,
  wranglerBundleArguments,
} from "./verify-inbound-exact-size-workerd.mjs";

test("exact-size fixture owns every byte of the 24,960,359-byte message", () => {
  const fixture = buildExactSizeFixture();
  assert.equal(fixture.raw.byteLength, 24_960_359);
  assert.equal(fixture.largeAttachment.byteLength, 18_238_584);
  assert.equal(fixture.smallAttachment.byteLength, 1_024);
  assert.equal(
    FIXTURE_LAYOUT.prefixBytes +
      FIXTURE_LAYOUT.largeWrappedBytes +
      FIXTURE_LAYOUT.tailBytes +
      FIXTURE_LAYOUT.epilogueBytes,
    FIXTURE_LAYOUT.rawBytes,
  );
  assert.equal(
    (FIXTURE_LAYOUT.largeAttachmentBytes / 3) * 4,
    FIXTURE_LAYOUT.largeBase64Bytes,
  );
  assert.equal(
    FIXTURE_LAYOUT.largeBase64Bytes +
      Math.ceil(FIXTURE_LAYOUT.largeBase64Bytes / 76) * 2,
    FIXTURE_LAYOUT.largeWrappedBytes,
  );
});

test("Vite Cloudflare development is permanently local by default", async () => {
  const source = await readFile("vite.config.ts", "utf8");
  validateLocalViteBindingConfig(source);
  assert.throws(
    () =>
      validateLocalViteBindingConfig(
        source.replace("remoteBindings: false", "remoteBindings: true"),
      ),
    /disable remote bindings|conditional or enabled/u,
  );
});

test("Queue completion normalization rejects retries and duplicate deliveries", () => {
  assert.deepEqual(
    normalizedQueueCompletions([
      "\u001b[32m⎔ QUEUE canary-4-1 1/1 (812ms)\u001b[0m",
      "QUEUE canary-4-2 1/1",
    ]),
    ["QUEUE canary-4-1 1/1", "QUEUE canary-4-2 1/1"],
  );
});

test("Wrangler bundling receives only a closed local environment and empty dotenv", () => {
  const environment = safeChildEnvironment("/tmp/wrangler.log", {
    HOME: "/tmp/home",
    NODE_OPTIONS: "--require=/tmp/poison.cjs",
    CLOUDFLARE_API_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
  });
  assert.deepEqual(environment, {
    HOME: "/tmp/home",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: "/tmp/wrangler.log",
  });
  const arguments_ = wranglerBundleArguments("/tmp/output", "/tmp/empty.env");
  assert.equal(arguments_.includes("--dry-run"), true);
  assert.deepEqual(
    arguments_.slice(arguments_.indexOf("--env-file"), arguments_.indexOf("--env-file") + 2),
    ["--env-file", "/tmp/empty.env"],
  );
});
