import assert from "node:assert/strict";
import ts from "typescript";

export function parseTypescriptSource(text: string, filename = "source.ts") {
  return ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

export function classMethodText(source: ts.SourceFile, name: string): string {
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source).replace(/^#/, "") === name
    ) {
      method = node;
      return;
    }
    if (!method) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(method, `${name} method exists`);
  return method.getText(source);
}

export function callIsInsideTransaction(
  source: ts.SourceFile,
  methodName: string,
  callName: string,
): boolean {
  let result = false;
  function visit(node: ts.Node, insideMethod: boolean): void {
    const methodMatches =
      ts.isMethodDeclaration(node) &&
      node.name.getText(source).replace(/^#/, "") === methodName;
    const nextInsideMethod = insideMethod || methodMatches;
    if (
      nextInsideMethod &&
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === callName) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === callName))
    ) {
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor) {
        if (
          (ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) &&
          ts.isCallExpression(ancestor.parent) &&
          ancestor.parent.arguments.includes(ancestor) &&
          ts.isPropertyAccessExpression(ancestor.parent.expression) &&
          ancestor.parent.expression.name.text === "transactionSync"
        ) {
          result = true;
          return;
        }
        ancestor = ancestor.parent;
      }
    }
    if (!result)
      ts.forEachChild(node, (child) => visit(child, nextInsideMethod));
  }
  visit(source, false);
  return result;
}
