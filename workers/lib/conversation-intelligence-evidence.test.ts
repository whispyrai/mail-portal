import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readConversationIntelligenceEvidenceProjection } from "./conversation-intelligence-evidence.ts";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      subject TEXT,
      sender TEXT,
      recipient TEXT,
      cc TEXT,
      bcc TEXT,
      date TEXT,
      body TEXT,
      thread_id TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      email_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      r2_key TEXT
    );
  `);
  const insertEmail = database.prepare(
    "INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const hugeBody = "b".repeat(100_000);
  for (let index = 0; index < 50; index++) {
    const id = `message-${String(index).padStart(2, "0")}`;
    insertEmail.run(
      id,
      "inbox",
      `Subject ${index}`,
      "sender@example.com",
      "team@example.com",
      null,
      null,
      `2026-07-11T${String(index).padStart(2, "0")}:00:00.000Z`,
      hugeBody,
      "huge-thread",
    );
  }
  for (const [id, folder] of [
    ["draft-in-thread", "draft"],
    ["outbox-in-thread", "outbox"],
    ["internal-in-thread", "_cancelled_outbound"],
  ] as const) {
    insertEmail.run(
      id,
      folder,
      "Excluded",
      "sender@example.com",
      "team@example.com",
      null,
      null,
      "2026-07-12T00:00:00.000Z",
      hugeBody,
      "huge-thread",
    );
  }
  const insertAttachment = database.prepare(
    "INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let index = 0; index < 8; index++) {
    insertAttachment.run(
      `attachment-${index}`,
      "message-49",
      `${String(index)}-${"f".repeat(500)}`,
      `text/${"p".repeat(200)}`,
      100 + index,
      null,
    );
  }
  return {
    database,
    sql: {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<string | number | null>
      ) {
        return database.prepare(query).all(...bindings) as T[];
      },
    },
  };
}

test("the evidence projection bounds a huge thread before return and filters unsafe folders", () => {
  const { database, sql } = fixture();
  const result = readConversationIntelligenceEvidenceProjection(
    sql,
    "message-49",
  );
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;

  assert.equal(result.messages.length, 30);
  assert.equal(result.messages[0]?.id, "message-20");
  assert.equal(result.messages.at(-1)?.id, "message-49");
  assert.equal(result.messages.every((message) => message.body.length === 6_000), true);
  assert.equal(
    result.messages.some((message) =>
      ["draft-in-thread", "outbox-in-thread", "internal-in-thread"].includes(
        message.id,
      ),
    ),
    false,
  );
  const attachments = result.messages.at(-1)?.attachments ?? [];
  assert.equal(attachments.length, 5);
  assert.equal(attachments[0]?.filename.length, 255);
  assert.equal(attachments[0]?.mimetype.length, 100);
  database.close();
});

test("the evidence projection verifies selected state before returning conversation data", () => {
  const { database, sql } = fixture();
  assert.deepEqual(
    readConversationIntelligenceEvidenceProjection(sql, "missing"),
    { state: "not_found" },
  );
  assert.deepEqual(
    readConversationIntelligenceEvidenceProjection(sql, "draft-in-thread"),
    { state: "unsupported", folderId: "draft" },
  );
  assert.deepEqual(
    readConversationIntelligenceEvidenceProjection(sql, "outbox-in-thread"),
    { state: "unsupported", folderId: "outbox" },
  );
  assert.deepEqual(
    readConversationIntelligenceEvidenceProjection(sql, "internal-in-thread"),
    { state: "not_found" },
  );
  database.close();
});
