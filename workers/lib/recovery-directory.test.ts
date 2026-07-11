import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryAddressFor,
  RecoveryDirectoryError,
} from "./recovery-directory.ts";

test("directory resolves a normalized portal account to an external owner address", () => {
  assert.equal(
    recoveryAddressFor(
      JSON.stringify({ "Member@WiserChat.ai": "Owner@Personal.Example" }),
      "member@wiserchat.ai",
      "wiserchat.ai,test.wiserchat.ai",
    ),
    "owner@personal.example",
  );
});

test("directory fails closed for missing, malformed, internal, or ambiguous entries", () => {
  for (const [directory, portal] of [
    [undefined, "member@wiserchat.ai"],
    ["not json", "member@wiserchat.ai"],
    [
      JSON.stringify({ "other@wiserchat.ai": "owner@personal.example" }),
      "member@wiserchat.ai",
    ],
    [
      JSON.stringify({ "member@wiserchat.ai": "owner@test.wiserchat.ai" }),
      "member@wiserchat.ai",
    ],
    [
      JSON.stringify({
        "MEMBER@wiserchat.ai": "one@example.com",
        "member@wiserchat.ai": "two@example.com",
      }),
      "member@wiserchat.ai",
    ],
  ] as const) {
    assert.throws(
      () =>
        recoveryAddressFor(directory, portal, "wiserchat.ai,test.wiserchat.ai"),
      RecoveryDirectoryError,
    );
  }
});
