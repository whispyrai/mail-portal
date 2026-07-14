// Validate the deployment-ready configuration emitted by the Cloudflare Vite
// plugin. Source wrangler.jsonc assertions alone can miss environment-resolution
// mistakes, so this script inspects the exact artifact Wrangler will deploy.

import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";

const brand = process.argv[2];
assert.ok(
  brand === "whispyr" || brand === "wiser",
  "usage: verify-built-environment.mjs <whispyr|wiser>",
);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDirectory = "script-logs";
const logFilePath = `${logDirectory}/verify-built-environment-${brand}-${timestamp}.log`;
await mkdir(logDirectory, { recursive: true });

async function detail(message) {
  await appendFile(logFilePath, `${new Date().toISOString()} ${message}\n`);
}

async function progress(message) {
  console.log(message);
  await detail(message);
}

async function equal(actual, expected, label) {
  await detail(
    `${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
  assert.deepEqual(actual, expected, label);
}

const environments = {
  whispyr: {
    name: "sales-mail-portal",
    brand: "whispyr",
    domains: "whispyrcrm.com",
    features: ["quiz"],
    databaseName: "sales_portal_users",
    databaseId: "f322fd13-dc49-4390-888c-ff862ca05882",
    bucket: "sales-mail-portal",
    rawBucket: "sales-mail-raw-archive",
    rawPreviewBucket: "sales-mail-raw-archive-preview",
    inboundQueue: "sales-mail-inbound",
    inboundDlq: "sales-mail-inbound-dlq",
    inboundParking: "sales-mail-inbound-parking",
    kvId: "cd541026bdf949d9ac63b3b5fdff4969",
    route: "mail.whispyrcrm.com",
    forbidden: [
      "wiser-mail-portal",
      "wiser_mail_portal_users",
      "87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
      "c934d803c2f8430d9088f4a5d9f29d55",
      "wiser-mail-raw-archive",
      "wiser-mail-inbound",
      "wiserchat.ai",
    ],
  },
  wiser: {
    name: "wiser-mail-portal",
    brand: "wiser",
    domains: "wiserchat.ai,test.wiserchat.ai",
    features: [],
    databaseName: "wiser_mail_portal_users",
    databaseId: "87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
    bucket: "wiser-mail-portal",
    rawBucket: "wiser-mail-raw-archive",
    rawPreviewBucket: "wiser-mail-raw-archive-preview",
    inboundQueue: "wiser-mail-inbound",
    inboundDlq: "wiser-mail-inbound-dlq",
    inboundParking: "wiser-mail-inbound-parking",
    kvId: "c934d803c2f8430d9088f4a5d9f29d55",
    route: "mail.wiserchat.ai",
    forbidden: [
      "sales-mail-portal",
      "sales_portal_users",
      "f322fd13-dc49-4390-888c-ff862ca05882",
      "cd541026bdf949d9ac63b3b5fdff4969",
      "sales-mail-raw-archive",
      "sales-mail-inbound",
      "whispyrcrm.com",
    ],
  },
};

const expected = environments[brand];
const expectedRequiredSecrets = [
  "ADMIN_BOOTSTRAP_EMAIL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "EMERGENCY_FORWARD_TO",
  "JWT_SECRET",
  "VAPID_PRIVATE_KEY",
  "VAPID_PUBLIC_KEY",
];

try {
  await progress(`Verifying ${brand} deployment artifact`);
  await progress(`Detailed log: ${logFilePath}`);
  await progress("Phase 1/3: reading resolved Worker configuration");
  const config = JSON.parse(
    await readFile("build/server/wrangler.json", "utf8"),
  );
  await detail(`Resolved configuration: ${JSON.stringify(config)}`);

  await progress("Phase 2/3: checking required isolated resources");
  await equal(config.name, expected.name, "Worker name");
  await equal(config.vars.BRAND, expected.brand, "BRAND");
  await equal(config.vars.DOMAINS, expected.domains, "DOMAINS");
  await equal(config.vars.FEATURES, expected.features, "FEATURES");
  await equal(
    config.vars.INBOUND_DLQ_NAME,
    expected.inboundDlq,
    "INBOUND_DLQ_NAME",
  );
  await equal(
    config.vars.INBOUND_PARKING_NAME,
    expected.inboundParking,
    "INBOUND_PARKING_NAME",
  );
  await equal(
    [...config.secrets.required].sort(),
    expectedRequiredSecrets,
    "required secrets",
  );
  await equal(config.routes[0]?.pattern, expected.route, "custom domain");
  await equal(config.routes[0]?.custom_domain, true, "custom-domain flag");
  await equal(
    config.d1_databases[0]?.database_name,
    expected.databaseName,
    "D1 name",
  );
  await equal(
    config.d1_databases[0]?.database_id,
    expected.databaseId,
    "D1 id",
  );
  await equal(
    config.r2_buckets[0]?.bucket_name,
    expected.bucket,
    "attachment R2 bucket",
  );
  await equal(
    config.r2_buckets[0]?.preview_bucket_name,
    expected.bucket,
    "attachment R2 preview bucket",
  );
  await equal(
    config.r2_buckets[1]?.binding,
    "RAW_MAIL_BUCKET",
    "raw R2 binding",
  );
  await equal(
    config.r2_buckets[1]?.bucket_name,
    expected.rawBucket,
    "raw R2 bucket",
  );
  await equal(
    config.r2_buckets[1]?.preview_bucket_name,
    expected.rawPreviewBucket,
    "raw R2 preview bucket",
  );
  await equal(
    config.queues.producers[0]?.binding,
    "INBOUND_QUEUE",
    "Queue binding",
  );
  await equal(
    config.queues.producers[0]?.queue,
    expected.inboundQueue,
    "inbound Queue",
  );
  await equal(config.queues.producers.length, 1, "Queue producer count");
  await equal(config.queues.consumers.length, 3, "Queue consumer count");
  await equal(
    config.queues.consumers[0]?.queue,
    expected.inboundQueue,
    "Queue consumer",
  );
  await equal(
    config.queues.consumers[0]?.max_batch_size,
    1,
    "Queue batch size",
  );
  await equal(
    config.queues.consumers[0]?.max_concurrency,
    1,
    "Queue concurrency",
  );
  await equal(
    config.queues.consumers[0]?.max_batch_timeout,
    5,
    "Queue batch timeout",
  );
  await equal(config.queues.consumers[0]?.max_retries, 10, "Queue max retries");
  await equal(config.queues.consumers[0]?.retry_delay, 1, "Queue retry delay");
  await equal(
    config.queues.consumers[0]?.dead_letter_queue,
    expected.inboundDlq,
    "Queue DLQ",
  );
  await equal(
    config.queues.consumers[1]?.queue,
    expected.inboundDlq,
    "DLQ consumer",
  );
  await equal(
    config.queues.consumers[1]?.max_retries,
    10,
    "DLQ consumer max retries",
  );
  await equal(config.queues.consumers[1]?.max_batch_size, 1, "DLQ batch size");
  await equal(
    config.queues.consumers[1]?.max_concurrency,
    1,
    "DLQ concurrency",
  );
  await equal(
    config.queues.consumers[1]?.max_batch_timeout,
    5,
    "DLQ batch timeout",
  );
  await equal(config.queues.consumers[1]?.retry_delay, 60, "DLQ retry delay");
  await equal(
    config.queues.consumers[1]?.dead_letter_queue,
    expected.inboundParking,
    "DLQ parking edge",
  );
  await equal(
    config.queues.consumers[2]?.queue,
    expected.inboundParking,
    "parking consumer",
  );
  await equal(
    config.queues.consumers[2]?.max_batch_size,
    1,
    "parking batch size",
  );
  await equal(
    config.queues.consumers[2]?.max_concurrency,
    1,
    "parking concurrency",
  );
  await equal(
    config.queues.consumers[2]?.max_batch_timeout,
    5,
    "parking batch timeout",
  );
  await equal(
    config.queues.consumers[2]?.max_retries,
    100,
    "parking max retries",
  );
  await equal(
    config.queues.consumers[2]?.retry_delay,
    3600,
    "parking retry delay",
  );
  await equal(
    config.queues.consumers[2]?.dead_letter_queue,
    undefined,
    "parking terminal edge",
  );
  await equal(config.triggers.crons, ["*/5 * * * *"], "reconciliation cron");
  await equal(config.kv_namespaces[0]?.id, expected.kvId, "OAuth KV id");

  await progress("Phase 3/3: checking cross-brand leakage");
  const serialized = JSON.stringify(config);
  for (const forbidden of expected.forbidden) {
    await detail(
      `Forbidden identifier ${forbidden}: present=${serialized.includes(forbidden)}`,
    );
    assert.equal(
      serialized.includes(forbidden),
      false,
      `${brand} artifact leaked forbidden identifier ${forbidden}`,
    );
  }

  await progress(`${brand} built environment is isolated and valid`);
} catch (error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  await detail(`FAILED: ${message}`);
  console.error(
    `${brand} built environment verification failed. See ${logFilePath}`,
  );
  process.exitCode = 1;
}
