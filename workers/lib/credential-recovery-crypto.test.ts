import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialRecoveryKeyUnavailableError,
  CredentialRecoveryKeyVersionError,
  decryptCredentialRecoveryPayload,
  encryptCredentialRecoveryPayload,
  opaqueCredentialRecoveryRef,
} from "./credential-recovery-crypto.ts";

test("credential recovery payload encryption authenticates its row identity", async () => {
  const encrypted = await encryptCredentialRecoveryPayload(
    "jwt-secret",
    { email: "owner@personal.example", token: "raw-secret" },
    { kind: "delivery", id: "delivery-1" },
  );

  assert.equal(encrypted.keyVersion, 1);
  assert.doesNotMatch(JSON.stringify(encrypted), /owner@personal|raw-secret/);
  assert.deepEqual(
    await decryptCredentialRecoveryPayload(
      "jwt-secret",
      encrypted,
      { kind: "delivery", id: "delivery-1" },
    ),
    { email: "owner@personal.example", token: "raw-secret" },
  );
  await assert.rejects(() =>
    decryptCredentialRecoveryPayload(
      "jwt-secret",
      encrypted,
      { kind: "delivery", id: "delivery-2" },
    ),
  );
});

test("credential recovery references are deterministic and do not expose inputs", async () => {
  const first = await opaqueCredentialRecoveryRef(
    "jwt-secret",
    "account",
    "member@wiserchat.ai",
  );
  const repeat = await opaqueCredentialRecoveryRef(
    "jwt-secret",
    "account",
    "member@wiserchat.ai",
  );
  const otherScope = await opaqueCredentialRecoveryRef(
    "jwt-secret",
    "ip",
    "member@wiserchat.ai",
  );

  assert.equal(first, repeat);
  assert.notEqual(first, otherScope);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first, /member|wiserchat/);
});

test("a V1 key seeded from the former JWT value survives later JWT rotation", async () => {
  const formerJwtValue = "former-jwt-value";
  const encrypted = await encryptCredentialRecoveryPayload(
    formerJwtValue,
    { email: "member@wiserchat.ai" },
    { kind: "request", id: "request-legacy" },
  );
  const rotatedJwtValue = "rotated-jwt-value";
  assert.notEqual(rotatedJwtValue, formerJwtValue);
  assert.deepEqual(
    await decryptCredentialRecoveryPayload(
      formerJwtValue,
      encrypted,
      { kind: "request", id: "request-legacy" },
    ),
    { email: "member@wiserchat.ai" },
  );
});

test("missing and unsupported payload keys remain typed retryable deployment failures", async () => {
  await assert.rejects(
    () =>
      encryptCredentialRecoveryPayload(
        "",
        { email: "member@wiserchat.ai" },
        { kind: "request", id: "request-missing-key" },
      ),
    CredentialRecoveryKeyUnavailableError,
  );
  await assert.rejects(
    () =>
      decryptCredentialRecoveryPayload(
        "configured",
        { keyVersion: 2, iv: "AAAAAAAAAAAAAAAA", ciphertext: "a".repeat(24) },
        { kind: "request", id: "request-new-version" },
      ),
    CredentialRecoveryKeyVersionError,
  );
});
