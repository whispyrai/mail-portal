import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(
  new URL("./ComposeEmail.tsx", import.meta.url),
  "utf8",
);
const formHook = readFileSync(
  new URL("../hooks/useComposeForm.ts", import.meta.url),
  "utf8",
);
const scheduleHelper = readFileSync(
  new URL("../lib/send-later.ts", import.meta.url),
  "utf8",
);

test("composer offers an accessible Send Later menu and local custom picker", () => {
  assert.match(composer, /<DropdownMenu/);
  assert.match(composer, /Send later/);
  assert.match(scheduleHelper, /Later today/);
  assert.match(scheduleHelper, /Tomorrow morning/);
  assert.match(scheduleHelper, /Next Monday morning/);
  assert.match(composer, /type="datetime-local"/);
  assert.match(composer, /aria-label="Send options"/);
  assert.match(composer, /role="status"/);
  assert.match(composer, /Scheduled for/);
});

test("Send now stays the default while scheduling joins the immutable enqueue payload", () => {
  assert.match(composer, /type="submit"/);
  assert.match(composer, /scheduledFor/);
  assert.match(composer, /Send now/);
  assert.match(formHook, /scheduled_for: scheduledFor/);
  assert.match(formHook, /keyFor\([\s\S]*?sendPayload,[\s\S]*?sendPersistenceKey/);
  assert.ok(
    formHook.indexOf("scheduled_for: scheduledFor") <
			formHook.indexOf("sendIdentityRef.current.keyFor("),
  );
});
