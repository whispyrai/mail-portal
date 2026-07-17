import assert from "node:assert/strict";
import test from "node:test";
import { privacySafeErrorName } from "./privacy-safe-error.ts";

test("privacy-safe recovery error names use one closed allowlist", () => {
  assert.equal(privacySafeErrorName(new TypeError("private text")), "TypeError");
  const privateName = new Error("safe message");
  privateName.name = "PrivateSecretValue";
  assert.equal(privacySafeErrorName(privateName), "UnknownError");
  assert.equal(privacySafeErrorName("PrivateSecretValue"), "UnknownError");

  const hostile = new Error("safe message");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("PrivateSecretValue");
    },
  });
  assert.equal(privacySafeErrorName(hostile), "UnknownError");

  let reads = 0;
  const stateful = new Error("safe message");
  Object.defineProperty(stateful, "name", {
    get() {
      reads += 1;
      return reads === 1 ? "Error" : "PrivateSecretValue";
    },
  });
  assert.equal(privacySafeErrorName(stateful), "Error");
  assert.equal(reads, 1);
});
