import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCollapsedCreateName,
  CreateOperationIdentity,
} from "./create-operation-identity.ts";

test("an exact create retry keeps one operation ID", () => {
  let sequence = 0;
  const identity = new CreateOperationIdentity(() => `operation-${++sequence}`);
  assert.equal(
    identity.operationIdFor(["team@example.com", "folder", "VIP"]),
    "operation-1",
  );
  assert.equal(
    identity.operationIdFor(["team@example.com", "folder", "VIP"]),
    "operation-1",
  );
});

test("editing or clearing a create rotates its operation ID", () => {
  let sequence = 0;
  const identity = new CreateOperationIdentity(() => `operation-${++sequence}`);
  assert.equal(
    identity.operationIdFor(["team@example.com", "label", "VIP", "red"]),
    "operation-1",
  );
  assert.equal(
    identity.operationIdFor(["team@example.com", "label", "VIP", "blue"]),
    "operation-2",
  );
  identity.invalidate();
  assert.equal(
    identity.operationIdFor(["team@example.com", "label", "VIP", "red"]),
    "operation-3",
  );
});

test("canonical whitespace keeps one operation while semantic edits rotate it", () => {
  let sequence = 0;
  const identity = new CreateOperationIdentity(() => `operation-${++sequence}`);
  const intent = (name: string, color = "red") => [
    "team@example.com",
    "label",
    canonicalCollapsedCreateName(name),
    color,
  ];
  assert.equal(identity.hasActiveOperation(), false);
  assert.equal(identity.operationIdFor(intent("VIP clients")), "operation-1");
  assert.equal(identity.hasActiveOperation(), true);
  assert.equal(
    identity.invalidateIfIntentChanged(intent(" VIP   clients ")),
    false,
  );
  assert.equal(
    identity.operationIdFor(intent(" VIP   clients ")),
    "operation-1",
  );
  assert.equal(identity.invalidateIfIntentChanged(intent("VIP Clients")), true);
  assert.equal(identity.hasActiveOperation(), false);
  assert.equal(identity.operationIdFor(intent("VIP Clients")), "operation-2");
  assert.equal(
    identity.invalidateIfIntentChanged(intent("VIP Clients", "blue")),
    true,
  );
  assert.equal(
    identity.operationIdFor(intent("VIP Clients", "blue")),
    "operation-3",
  );
});

test("returning to an old intent after a real edit never revives its operation ID", () => {
  let sequence = 0;
  const identity = new CreateOperationIdentity(() => `operation-${++sequence}`);
  const original = ["team@example.com", "folder", "VIP"];
  assert.equal(identity.operationIdFor(original), "operation-1");
  assert.equal(
    identity.invalidateIfIntentChanged([
      "team@example.com",
      "folder",
      "Clients",
    ]),
    true,
  );
  assert.equal(identity.invalidateIfIntentChanged(original), false);
  assert.equal(identity.operationIdFor(original), "operation-2");
  identity.invalidate();
  assert.equal(identity.hasActiveOperation(), false);
  assert.equal(identity.operationIdFor(original), "operation-3");
});
