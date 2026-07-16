#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import {
  buildLoginRequest,
  buildRecoveryRequest,
  fetchWithTimeout,
  incompleteRecoveryAuditMessage,
  isIncompleteRecoveryAudit,
  isUnverifiedRecoveryCommit,
  recoveryCompletionMessage,
  shouldRetryRecoveryResponse,
  unverifiedRecoveryCommitMessage,
  validateRecoveryTarget,
} from "./recover-inbound-helpers.mjs";

const LOGIN_TIMEOUT_MS = 15_000;
const RECOVERY_TIMEOUT_MS = 60_000;

const allowedArgs = new Set(["base", "email", "mailbox", "ingress-id"]);
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  const key = flag?.startsWith("--") ? flag.slice(2) : "";
  if (!allowedArgs.has(key) || value === undefined) {
    console.error(`Unexpected or incomplete argument: ${flag ?? "(missing)"}`);
    process.exit(1);
  }
  args[key] = value;
}

const missing = [...allowedArgs].filter((key) => !args[key]);
if (missing.length > 0) {
  console.error(
    `Missing required args: ${missing.map((key) => `--${key}`).join(", ")}`,
  );
  process.exit(1);
}
if (!process.env.IMPORT_PASSWORD) {
  console.error(
    "IMPORT_PASSWORD is required. Set it with a hidden shell prompt.",
  );
  process.exit(1);
}

const target = validateRecoveryTarget(args.base, args.mailbox);
if (!target.ok) {
  console.error(target.error);
  process.exit(1);
}
const baseUrl = target.baseUrl;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDirectory = "script-logs";
const logFilePath = `${logDirectory}/recover-inbound-${timestamp}.log`;
await mkdir(logDirectory, { recursive: true });

async function detail(message, fields = {}) {
  await appendFile(
    logFilePath,
    `${new Date().toISOString()} ${message} ${JSON.stringify(fields)}\n`,
  );
}

async function progress(message, fields = {}) {
  console.log(message);
  await detail(message, fields);
}

let fatalHandled = false;
async function fatal(error) {
  if (fatalHandled) return;
  fatalHandled = true;
  const message = error instanceof Error ? error.message : String(error);
  await detail("Recovery failed", { error: message });
  console.error(`Recovery failed: ${message}. See ${logFilePath}`);
  process.exitCode = 1;
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

const base = baseUrl.origin;
await progress("Starting one-message inbound recovery");
await progress(`Detailed log: ${logFilePath}`);
await detail("Recovery inputs", {
  base,
  mailbox: args.mailbox,
  ingressId: args["ingress-id"],
});

await progress("Phase 1/2: authenticating as administrator");
const loginRequest = buildLoginRequest(
  baseUrl,
  args.email,
  process.env.IMPORT_PASSWORD,
);
const loginResponse = await fetchWithTimeout(
  fetch,
  loginRequest.url,
  loginRequest.options,
  LOGIN_TIMEOUT_MS,
);
const setCookie = loginResponse.headers.get("set-cookie");
await detail("Login response", {
  status: loginResponse.status,
  hasCookie: Boolean(setCookie),
});
if (!setCookie || loginResponse.status >= 400) {
  throw new Error(`Login failed with HTTP ${loginResponse.status}`);
}
const cookie = setCookie.split(";")[0];

await progress("Phase 2/2: restoring the verified R2 inbound projection");
const recoveryRequest = buildRecoveryRequest(
  baseUrl,
  cookie,
  args.mailbox,
  args["ingress-id"],
);
let finalResponse;
let responseBody = {};
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    finalResponse = await fetchWithTimeout(
      fetch,
      recoveryRequest.url,
      recoveryRequest.options,
      RECOVERY_TIMEOUT_MS,
    );
    responseBody = await finalResponse
      .clone()
      .json()
      .catch(() => ({}));
    await detail("Recovery response", {
      attempt,
      status: finalResponse.status,
      body: responseBody,
    });
    if (!shouldRetryRecoveryResponse(finalResponse.status, responseBody)) break;
  } catch (error) {
    await detail("Recovery request failed", {
      attempt,
      error: error instanceof Error ? error.message : String(error),
    });
    if (attempt === 3) throw error;
  }
  if (attempt < 3) {
    const delayMs = 500 * 2 ** (attempt - 1);
    await progress(
      `Recovery attempt ${attempt}/3 failed; retrying in ${delayMs} ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

if (isIncompleteRecoveryAudit(responseBody)) {
  await progress(incompleteRecoveryAuditMessage(responseBody), {
    auditId: responseBody.auditId,
    auditStatus: responseBody.auditStatus,
    ingressId: args["ingress-id"],
    status: responseBody.status,
  });
  process.exitCode = 2;
} else if (isUnverifiedRecoveryCommit(responseBody)) {
  await progress(unverifiedRecoveryCommitMessage(responseBody), {
    auditId: responseBody.auditId,
    commitStatus: responseBody.commitStatus,
    ingressId: args["ingress-id"],
  });
  process.exitCode = 2;
} else if (!finalResponse?.ok) {
  throw new Error(
    `Recovery failed with HTTP ${finalResponse?.status ?? "unavailable"}: ${JSON.stringify(responseBody)}`,
  );
} else {
  await progress(recoveryCompletionMessage(responseBody), {
    status: responseBody.status,
    ingressId: args["ingress-id"],
  });
}
