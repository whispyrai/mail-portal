import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyInboundDerivedContentCleanup,
  classifyInboundProjectionDerivedContent,
  projectionAttemptIdFromDerivedContentKey,
  validateInboundDerivedContentCleanupProof,
  validateInboundDerivedContentProjectionProof,
  validateInboundDerivedContentCleanupRequest,
} from "./inbound-derived-content-cleanup.ts";

test("derived-content keys reveal only their exact UUID attempt namespace", () => {
  const attemptId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      `email-bodies/mail-123/${attemptId}/0.body`,
    ),
    attemptId,
  );
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      `attachments/mail-123/${attemptId}/mail-123-0/file.pdf`,
    ),
    attemptId,
  );
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      `email-bodies/other/${attemptId}/0.body`,
    ),
    null,
  );
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      "attachments/mail-123/legacy.bin",
    ),
    null,
  );
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      `email-bodies/mail-123/${attemptId}/511.body`,
    ),
    attemptId,
  );
  assert.equal(
    projectionAttemptIdFromDerivedContentKey(
      "mail-123",
      `attachments/mail-123/${attemptId}/mail-123-511/${"a".repeat(240)}`,
    ),
    attemptId,
  );
  for (const invalidKey of [
    `email-bodies/mail-123/${attemptId}/512.body`,
    `attachments/mail-123/${attemptId}/other-0/file.pdf`,
    `attachments/mail-123/${attemptId}/mail-123-512/file.pdf`,
    `attachments/mail-123/${attemptId}/mail-123-0/bad:name.pdf`,
    `attachments/mail-123/${attemptId}/mail-123-0/${"a".repeat(241)}`,
  ]) {
    assert.equal(
      projectionAttemptIdFromDerivedContentKey("mail-123", invalidKey),
      null,
      invalidKey,
    );
  }
});

const attempt = "123e4567-e89b-42d3-a456-426614174000";

function request(keys: string[]) {
  return {
    emailId: "mail-123",
    projectionAttemptId: attempt,
    keys,
  };
}

test("cleanup accepts only exact attempt-owned keys emitted by the streaming builders", () => {
  const keys = [
    `attachments/mail-123/${attempt}/mail-123-0/report.pdf`,
    `email-bodies/mail-123/${attempt}/0.body`,
  ];
  assert.deepEqual(
    validateInboundDerivedContentCleanupRequest(request(keys)),
    keys,
  );
});

test("cleanup proof binds each canonical key to an immutable safe byte length", () => {
  const objects = [
    {
      r2Key: `attachments/mail-123/${attempt}/mail-123-0/report.pdf`,
      byteLength: 10,
    },
    {
      r2Key: `email-bodies/mail-123/${attempt}/0.body`,
      byteLength: 0,
    },
  ];
  assert.deepEqual(
    validateInboundDerivedContentCleanupProof({
      emailId: "mail-123",
      projectionAttemptId: attempt,
      objects,
    }),
    objects,
  );
  for (const byteLength of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      validateInboundDerivedContentCleanupProof({
        emailId: "mail-123",
        projectionAttemptId: attempt,
        objects: [{ ...objects[0]!, byteLength }],
      }),
    );
  }
});

test("normal projection proof accepts an empty complete attempt without weakening cleanup RPC validation", () => {
  assert.deepEqual(
    validateInboundDerivedContentProjectionProof({
      emailId: "mail-123",
      projectionAttemptId: attempt,
      objects: [],
    }),
    [],
  );
  assert.throws(() =>
    validateInboundDerivedContentCleanupProof({
      emailId: "mail-123",
      projectionAttemptId: attempt,
      objects: [],
    }),
  );
});

test("guarded cleanup retains owned proof, outboxes existing unowned proof, and accepts absent unowned proof", () => {
  const candidates = [
    { r2Key: "owned", byteLength: 10 },
    { r2Key: "queued", byteLength: 20 },
    { r2Key: "absent", byteLength: 30 },
  ];
  assert.deepEqual(
    classifyInboundDerivedContentCleanup(
      candidates,
      new Map([
        ["owned", 10],
        ["queued", 20],
        ["absent", null],
      ]),
      new Map([["owned", 10]]),
    ),
    { queued: [candidates[1]], retained: 1, absent: 1 },
  );
});

test("normal projection retains exact owned proof and returns every discarded attempt object", () => {
  const owned = {
    r2Key: `attachments/mail-123/${attempt}/mail-123-0/owned.pdf`,
    byteLength: 10,
  };
  const discarded = {
    r2Key: `attachments/mail-123/${attempt}/mail-123-1/discarded.pdf`,
    byteLength: 20,
  };
  assert.deepEqual(
    classifyInboundProjectionDerivedContent(
      [owned, discarded],
      new Map([[owned.r2Key, owned.byteLength]]),
      { emailId: "mail-123", projectionAttemptId: attempt },
    ),
    { ownedKeys: [owned.r2Key], cleanupKeys: [discarded.r2Key] },
  );
});

test("normal projection rejects omitted ownership from the same attempt but permits a duplicate loser's separate namespace", () => {
  const sameAttemptOwned = `attachments/mail-123/${attempt}/mail-123-0/owned.pdf`;
  assert.throws(
    () =>
      classifyInboundProjectionDerivedContent(
        [],
        new Map([[sameAttemptOwned, 10]]),
        { emailId: "mail-123", projectionAttemptId: attempt },
      ),
    /ownership proof is incomplete/,
  );

  const otherAttempt = "223e4567-e89b-42d3-a456-426614174000";
  const loser = {
    r2Key: `attachments/mail-123/${otherAttempt}/mail-123-0/loser.pdf`,
    byteLength: 10,
  };
  assert.deepEqual(
    classifyInboundProjectionDerivedContent(
      [loser],
      new Map([[sameAttemptOwned, 10]]),
      { emailId: "mail-123", projectionAttemptId: otherAttempt },
    ),
    { ownedKeys: [], cleanupKeys: [loser.r2Key] },
  );
});

test("normal projection rejects a contradictory authoritative size", () => {
  const owned = {
    r2Key: `email-bodies/mail-123/${attempt}/0.body`,
    byteLength: 10,
  };
  assert.throws(
    () =>
      classifyInboundProjectionDerivedContent(
        [owned],
        new Map([[owned.r2Key, 11]]),
        { emailId: "mail-123", projectionAttemptId: attempt },
      ),
    /ownership proof is inconsistent/,
  );
});

test("guarded cleanup refuses R2 or current-ownership size mismatch", () => {
  const candidate = { r2Key: "proof", byteLength: 10 };
  assert.throws(
    () =>
      classifyInboundDerivedContentCleanup(
        [candidate],
        new Map([["proof", 11]]),
        new Map(),
      ),
    /object proof is inconsistent/,
  );
  assert.throws(
    () =>
      classifyInboundDerivedContentCleanup(
        [candidate],
        new Map([["proof", 10]]),
        new Map([["proof", 11]]),
      ),
    /ownership proof is inconsistent/,
  );
});

test("cleanup rejects duplicate, oversized, and noncanonical key batches", () => {
  const valid = `email-bodies/mail-123/${attempt}/0.body`;
  assert.throws(() => validateInboundDerivedContentCleanupRequest(request([])));
  assert.throws(() =>
    validateInboundDerivedContentCleanupRequest(request([valid, valid])),
  );
  assert.throws(() =>
    validateInboundDerivedContentCleanupRequest(
      request(
        Array.from(
          { length: 513 },
          (_, index) => `email-bodies/mail-123/${attempt}/${index}.body`,
        ),
      ),
    ),
  );
  assert.throws(() =>
    validateInboundDerivedContentCleanupRequest(
      request([`email-bodies/mail-123/${attempt}/01.body`]),
    ),
  );
});

test("cleanup rejects prefix confusion, namespace separators, and sanitized characters", () => {
  const malicious = [
    `attachments/mail-123/${attempt}/mail-1234-0/report.pdf`,
    `attachments/mail-123/${attempt}/mail-123-0/../report.pdf`,
    `attachments/mail-123/${attempt}/mail-123-0/report\\escape.pdf`,
    `attachments/mail-123/${attempt}/mail-123-0/report\u0000.pdf`,
    `attachments/mail-123/${attempt}/mail-123-0/report:escape.pdf`,
    `attachments/mail-123/${attempt}/mail-123--1/report.pdf`,
    `attachments/mail-123/${attempt}/mail-123-01/report.pdf`,
    `email-bodies/mail-123/${attempt}/../0.body`,
    `email-bodies/mail-123/${attempt}/0.body/extra`,
  ];
  for (const key of malicious) {
    assert.throws(
      () => validateInboundDerivedContentCleanupRequest(request([key])),
      undefined,
      key,
    );
  }
});

test("cleanup matches builder-supported flat filename segments exactly", () => {
  for (const filename of [".", "..", "report\u007f.pdf"]) {
    const key = `attachments/mail-123/${attempt}/mail-123-0/${filename}`;
    assert.deepEqual(
      validateInboundDerivedContentCleanupRequest(request([key])),
      [key],
    );
  }
});

test("cleanup rejects identifiers that can escape or alias the namespace", () => {
  assert.throws(() =>
    validateInboundDerivedContentCleanupRequest({
      ...request([`email-bodies/mail-123/${attempt}/0.body`]),
      emailId: "mail/123",
    }),
  );
  assert.throws(() =>
    validateInboundDerivedContentCleanupRequest({
      ...request([`email-bodies/mail-123/${attempt}/0.body`]),
      projectionAttemptId: `${attempt}/extra`,
    }),
  );
});

test("cleanup rejects coercion, sparse arrays, non-string keys, and out-of-bound indices", () => {
  const valid = `email-bodies/mail-123/${attempt}/0.body`;
  for (const malformed of [
    { ...request([valid]), emailId: 123 },
    { ...request([valid]), projectionAttemptId: { toString: () => attempt } },
    { ...request([valid]), keys: "not-an-array" },
    { ...request([valid]), keys: [valid, 123] },
    { ...request([valid]), keys: Array(1) },
  ]) {
    assert.throws(() =>
      validateInboundDerivedContentCleanupRequest(malformed as never),
    );
  }
  for (const key of [
    `attachments/mail-123/${attempt}/mail-123-512/report.pdf`,
    `email-bodies/mail-123/${attempt}/512.body`,
    `email-bodies/mail-123/${attempt}/${"9".repeat(1025)}.body`,
  ]) {
    assert.throws(() =>
      validateInboundDerivedContentCleanupRequest(request([key])),
    );
  }
});
