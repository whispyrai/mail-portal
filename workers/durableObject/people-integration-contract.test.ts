import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const durableObject = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
);
const inboundStore = readFileSync(
  new URL("../lib/store-email.ts", import.meta.url),
  "utf8",
);
const importStore = readFileSync(
  new URL("../lib/import/import-email.ts", import.meta.url),
  "utf8",
);

const source = ts.createSourceFile(
  "index.ts",
  durableObject,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function methodNamed(name: string): ts.MethodDeclaration {
  let result: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source).replace(/^#/, "") === name
    )
      result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, `${name} method exists`);
  return result;
}

function hasProjectMessageInsideTransaction(
  method: ts.MethodDeclaration,
  argument: string,
): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "projectMessage" &&
      node.arguments[0]?.getText(source) === argument
    ) {
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor && ancestor !== method) {
        if (
          (ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) &&
          ts.isCallExpression(ancestor.parent) &&
          ancestor.parent.arguments.includes(ancestor) &&
          ts.isPropertyAccessExpression(ancestor.parent.expression) &&
          ancestor.parent.expression.name.text === "transactionSync"
        ) {
          found = true;
          return;
        }
        ancestor = ancestor.parent;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(method);
  return found;
}

test("People projection runs inside authoritative inbound and accepted-outbound transactions", () => {
  assert.equal(
    hasProjectMessageInsideTransaction(methodNamed("createEmail"), "email.id"),
    true,
  );
  assert.equal(
    hasProjectMessageInsideTransaction(
      methodNamed("moveAcceptedOutboundToSent"),
      "emailId",
    ),
    true,
  );
});

test("authoritative parsing stores a sanitized sender name and imports identify their mailbox", () => {
  assert.match(
    inboundStore,
    /sender_name: normalizeObservedSenderName\(parsed\.from\?\.name\)/,
  );
  assert.match(
    importStore,
    /recipientMemoryOrigin: RecipientMemoryOrigins\.ADMIN_IMPORT[\s\S]*?mailboxAddress: mailboxId/,
  );
});

test("People Durable Object RPC seams revalidate canonical mailbox, identity, and query contracts", () => {
  assert.match(
    durableObject,
    /async listMailPeople[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateNormalizedMailPeopleListQuery\(query\)/,
  );
  assert.match(
    durableObject,
    /async getMailPerson[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateMailPersonId\(personId\)/,
  );
  assert.match(
    durableObject,
    /async listMailPersonTimeline[\s\S]*?normalizedMailbox !== mailboxAddress[\s\S]*?validateMailPersonId\(personId\)[\s\S]*?validateNormalizedMailPersonTimelineQuery\(query, id\)/,
  );
});
