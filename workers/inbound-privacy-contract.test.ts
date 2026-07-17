import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  classMethodText,
} from "./testing/typescript-source.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cloudflareConfigPath = join(repoRoot, "tsconfig.cloudflare.json");
const cloudflareConfigFile = ts.readConfigFile(cloudflareConfigPath, ts.sys.readFile);
assert.equal(cloudflareConfigFile.error, undefined);
const cloudflareConfig = ts.parseJsonConfigFileContent(
  cloudflareConfigFile.config,
  ts.sys,
  repoRoot,
);
const projectProgram = ts.createProgram({
  rootNames: cloudflareConfig.fileNames,
  options: cloudflareConfig.options,
});
const checkerBySource = new WeakMap<ts.SourceFile, ts.TypeChecker>();
const projectChecker = projectProgram.getTypeChecker();
for (const source of projectProgram.getSourceFiles()) {
  checkerBySource.set(source, projectChecker);
}

function projectSource(path: string): ts.SourceFile {
  const source = projectProgram.getSourceFile(path);
  assert.ok(source, `${path} is included in the Cloudflare TypeScript program`);
  return source;
}

function parseCheckedFixture(text: string, filename: string): ts.SourceFile {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const defaultHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => path === filename,
    getSourceFile: (path) => (path === filename ? source : undefined),
    readFile: (path) => (path === filename ? text : undefined),
  };
  const program = ts.createProgram({ rootNames: [filename], options, host });
  const checkedSource = program.getSourceFile(filename);
  assert.ok(checkedSource);
  checkerBySource.set(checkedSource, program.getTypeChecker());
  return checkedSource;
}

const forbiddenTelemetryFields = new Set([
  "attemptId",
  "auditId",
  "body",
  "error",
  "errorMessage",
  "errorName",
  "filename",
  "ingressId",
  "mailboxAddress",
  "mailboxId",
  "mailboxRef",
  "messageId",
  "operator",
  "queueMessageId",
  "rawKey",
  "r2Key",
  "receiptState",
  "result",
  "stack",
  "subject",
]);

const allowedTelemetryFields = new Set([
  "actualRawSize",
  "anomalyCount",
  "archivedSize",
  "attempt",
  "attemptRef",
  "auditRef",
  "byteLength",
  "cleanupAccepted",
  "cleanupFailures",
  "cleanupQueued",
  "cleanupScanned",
  "cleanupSweepStatus",
  "count",
  "declaredRawSize",
  "delayMs",
  "delaySeconds",
  "durationMs",
  "errorCode",
  "failed",
  "failureLedgered",
  "found",
  "generation",
  "ingressRef",
  "invalid",
  "maxAttempts",
  "messageRef",
  "nextAttempt",
  "objectRef",
  "objectType",
  "operation",
  "pendingReview",
  "projectionMissing",
  "queueRef",
  "rawSize",
  "recentDiscovered",
  "recentScanned",
  "recentSweepStatus",
  "recoveryAction",
  "reenqueued",
  "repairResolved",
  "repairScanned",
  "repairSweepStatus",
  "resolution",
  "scanned",
  "skipped",
  "stage",
  "state",
  "status",
  "target",
  "terminalized",
  "truncated",
]);

const telemetryRefFields = new Set([
  "attemptRef",
  "auditRef",
  "ingressRef",
  "messageRef",
  "objectRef",
  "queueRef",
]);

const approvedMailTelemetryPrefixes = new Set([
  "[mail-cleanup]",
  "[mail-emergency-forward]",
  "[mail-import]",
  "[mail-ingress]",
  "[mail-projection]",
  "[mail-reconciliation]",
  "[mail-recovery]",
  "[mail-store]",
]);

const forbiddenScalarIdentifiers = new Set([
  "error",
  "ledgerError",
  "privatePayload",
  "poison",
  "rawId",
  "result",
  "value",
]);
const allowedScalarPropertyPaths = new Set([
  "admission.errorCode",
  "archived.size",
  "claimed.length",
  "event.rawSize",
  "error.stage",
  "failedKeys.length",
  "failures.length",
  "input.errorCode",
  "input.objectType",
  "input.operation",
  "input.expectedSize",
  "manifest.generation",
  "message.attempts",
  "page.objects.length",
  "page.truncated",
  "rawBytes.byteLength",
  "result.failed",
  "result.failureLedgered",
  "result.invalid",
  "result.pendingReview",
  "result.projectionMissing",
  "result.reenqueued",
  "result.scanned",
  "result.skipped",
  "result.status",
  "result.terminalized",
]);
const numericScalarPropertyPaths = new Set([
  "archived.size",
  "claimed.length",
  "event.rawSize",
  "failedKeys.length",
  "failures.length",
  "input.expectedSize",
  "manifest.generation",
  "message.attempts",
  "page.objects.length",
  "rawBytes.byteLength",
  "result.failed",
  "result.failureLedgered",
  "result.invalid",
  "result.pendingReview",
  "result.projectionMissing",
  "result.reenqueued",
  "result.scanned",
  "result.skipped",
  "result.terminalized",
]);
const safeScalarCallNames = new Set([
  "Boolean",
  "durationMs",
  "enqueueUnownedDerivedContentCleanup",
  "permanentMimeProjectionErrorCode",
  "safeErrorCode",
]);
const safeNumericBinaryOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);

const trustedImportedHelpers = new Map<string, ReadonlySet<string>>([
  [
    "mailTelemetryLogRef",
    new Set([
      "./lib/mail-telemetry.ts",
      "./mail-telemetry.ts",
      "../lib/mail-telemetry.ts",
      "../mail-telemetry.ts",
    ]),
  ],
  [
    "permanentMimeProjectionErrorCode",
    new Set(["./lib/streaming-email.ts"]),
  ],
  [
    "safeErrorCode",
    new Set(["./lib/safe-error-code.ts", "../safe-error-code.ts"]),
  ],
]);

const trustedImportedHelperTargets = new Map([
  ["mailTelemetryLogRef", "/workers/lib/mail-telemetry.ts"],
  ["permanentMimeProjectionErrorCode", "/workers/lib/streaming-email.ts"],
  ["safeErrorCode", "/workers/lib/safe-error-code.ts"],
]);

const assignmentOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const numericAssignmentOperators = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

function propertyPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = propertyPath(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : null;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const parent = propertyPath(expression.expression);
    return parent ? `${parent}.${expression.argumentExpression.text}` : null;
  }
  return null;
}

function hasDynamicElementAccess(expression: ts.Expression): boolean {
  if (ts.isElementAccessExpression(expression)) {
    if (
      !expression.argumentExpression ||
      !ts.isStringLiteralLike(expression.argumentExpression)
    ) {
      return true;
    }
    return hasDynamicElementAccess(expression.expression);
  }
  return ts.isPropertyAccessExpression(expression)
    ? hasDynamicElementAccess(expression.expression)
    : false;
}

function callAncestors(call: ts.CallExpression): Set<ts.Node> {
  const ancestors = new Set<ts.Node>();
  for (let current: ts.Node | undefined = call; current; current = current.parent) {
    ancestors.add(current);
  }
  return ancestors;
}

function nearestValueDeclaration(
  source: ts.SourceFile,
  call: ts.CallExpression,
  name: string,
): ts.VariableDeclaration | ts.ParameterDeclaration | null {
  const checker = checkerBySource.get(source);
  if (checker) {
    let reference: ts.Identifier | undefined;
    function findReference(node: ts.Node): void {
      if (reference) return;
      if (ts.isIdentifier(node) && node.text === name) {
        const symbol = checker.getSymbolAtLocation(node);
        if (
          symbol?.declarations?.some(
            (declaration) =>
              declaration.getSourceFile() === source &&
              (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)),
          )
        ) {
          reference = node;
          return;
        }
      }
      ts.forEachChild(node, findReference);
    }
    findReference(call);
    if (reference) {
      const symbol = checker.getSymbolAtLocation(reference);
      const declaration = symbol?.declarations?.find(
        (candidate): candidate is ts.VariableDeclaration | ts.ParameterDeclaration =>
          candidate.getSourceFile() === source &&
          (ts.isVariableDeclaration(candidate) || ts.isParameter(candidate)),
      );
      if (declaration) return declaration;
    }
  }
  const ancestors = callAncestors(call);
  const scopes: ts.Node[] = [];
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) scopes.push(current);
  }
  scopes.push(source);
  for (const scope of scopes) {
    let nearest: ts.VariableDeclaration | ts.ParameterDeclaration | undefined;
    function visit(node: ts.Node): void {
      if (
        ts.isFunctionLike(node) &&
        node !== scope &&
        !ancestors.has(node)
      ) {
        return;
      }
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.getStart(source) < call.getStart(source) &&
        (!nearest || node.getStart(source) > nearest.getStart(source))
      ) {
        nearest = node;
      }
      ts.forEachChild(node, visit);
    }
    visit(scope);
    if (nearest) return nearest;
  }
  return null;
}

function declarationBindingIdentifier(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  name: string,
): ts.Identifier | null {
  let result: ts.Identifier | null = null;
  function visit(binding: ts.BindingName): void {
    if (result) return;
    if (ts.isIdentifier(binding)) {
      if (binding.text === name) result = binding;
      return;
    }
    for (const element of binding.elements) {
      if (ts.isBindingElement(element)) visit(element.name);
    }
  }
  visit(declaration.name);
  return result;
}

function declarationIsWrittenBy(
  source: ts.SourceFile,
  node: ts.Node,
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  name: string,
): boolean {
  const checker = checkerBySource.get(source);
  const targetIdentifier = declarationBindingIdentifier(declaration, name);
  const targetSymbol =
    checker && targetIdentifier
      ? checker.getSymbolAtLocation(targetIdentifier)
      : undefined;
  let written = false;
  function visit(candidate: ts.Node): void {
    if (written) return;
    if (ts.isIdentifier(candidate) && candidate.text === name) {
      const candidateSymbol = checker?.getSymbolAtLocation(candidate);
      if (targetSymbol ? candidateSymbol === targetSymbol : true) {
        written = true;
      }
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return written;
}

function isReassignedBeforeCall(
  source: ts.SourceFile,
  call: ts.CallExpression,
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  name: string,
): boolean {
  return assignedValuesBeforeCall(source, call, declaration, name).length > 0;
}

function assignedValuesBeforeCall(
  source: ts.SourceFile,
  call: ts.CallExpression,
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  name: string,
): Array<ts.Expression | null> {
  const end = call.getStart(source);
  const ancestors = callAncestors(call);
  const assigned: Array<ts.Expression | null> = [];
  function visit(node: ts.Node): void {
    if (node.getStart(source) >= end) return;
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      declarationIsWrittenBy(source, node.initializer, declaration, name)
    ) {
      assigned.push(node.expression);
    }
    if (ts.isForStatement(node) && ancestors.has(node.statement)) {
      if (node.initializer) visit(node.initializer);
      if (node.condition) visit(node.condition);
      visit(node.statement);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      declarationIsWrittenBy(source, node.left, declaration, name)
    ) {
      assigned.push(node.right);
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      declarationIsWrittenBy(source, node.operand, declaration, name)
    ) {
      assigned.push(null);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return assigned;
}

function hasNameWriteBeforeCall(
  source: ts.SourceFile,
  call: ts.CallExpression,
  name: string,
): boolean {
  const end = call.getStart(source);
  const declaration = nearestValueDeclaration(source, call, name);
  if (!declaration) return false;
  let written = false;
  function visit(node: ts.Node): void {
    if (written || node.getStart(source) >= end) return;
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      declarationIsWrittenBy(source, node.initializer, declaration, name)
    ) {
      written = true;
      return;
    }
    if (ts.isForStatement(node) && ancestors.has(node.statement)) {
      if (node.initializer) visit(node.initializer);
      if (node.condition) visit(node.condition);
      visit(node.statement);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      declarationIsWrittenBy(source, node.left, declaration, name)
    ) {
      written = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      declarationIsWrittenBy(source, node.operand, declaration, name)
    ) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return written;
}

function importedHelperSource(source: ts.SourceFile, name: string): string | null {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (element.name.text === name && importedName === name) {
        return statement.moduleSpecifier.text;
      }
    }
  }
  return null;
}

function resolvedImportedHelperTarget(
  source: ts.SourceFile,
  name: string,
): string | null {
  const checker = checkerBySource.get(source);
  if (!checker) return null;
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const element = statement.importClause.namedBindings.elements.find(
      (candidate) =>
        candidate.name.text === name &&
        (candidate.propertyName?.text ?? candidate.name.text) === name,
    );
    if (!element) continue;
    const alias = checker.getSymbolAtLocation(element.name);
    if (!alias || !(alias.flags & ts.SymbolFlags.Alias)) return null;
    const target = checker.getAliasedSymbol(alias);
    return target.declarations?.[0]?.getSourceFile().fileName ?? null;
  }
  return null;
}

function localFunctionHasScalarReturn(
  source: ts.SourceFile,
  name: string,
): boolean {
  const declarations = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  return (
    declarations.length === 1 &&
    isSafeDeclaredScalarType(source, declarations[0].type)
  );
}

function isTrustedNamedHelper(
  source: ts.SourceFile,
  call: ts.CallExpression,
  name: string,
): boolean {
  if (nearestValueDeclaration(source, call, name) !== null) return false;
  if (name === "Boolean") {
    return (
      nearestValueDeclaration(source, call, name) === null &&
      !source.statements.some(
        (statement) =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      )
    );
  }
  const expectedImport = trustedImportedHelpers.get(name);
  if (expectedImport) {
    const module = importedHelperSource(source, name);
    const target = resolvedImportedHelperTarget(source, name);
    const expectedTarget = trustedImportedHelperTargets.get(name);
    let conflictingFunction = false;
    function visit(node: ts.Node): void {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === name
      ) {
        conflictingFunction = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return (
      module !== null &&
      expectedImport.has(module) &&
      target !== null &&
      expectedTarget !== undefined &&
      target.endsWith(expectedTarget) &&
      !conflictingFunction &&
      !hasNameWriteBeforeCall(source, call, name)
    );
  }
  return localFunctionHasScalarReturn(source, name);
}

function isDeclaredScalarPropertyPath(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
): boolean {
  const checker = checkerBySource.get(source);
  if (!checker) return false;
  const type = checker.getTypeAtLocation(expression);
  if (!isSafeTelemetryScalarType(type)) return false;
  const propertySymbol = checker.getSymbolAtLocation(expression.name);
  if (
    Boolean(type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) &&
    propertySymbol?.declarations?.length &&
    propertySymbol.declarations.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    )
  ) {
    return true;
  }
  return propertyAssignedValuesBeforeCall(
    source,
    checker,
    call,
    expression,
  ).every((value) => {
    if (value === undefined) return false;
    if (value === null) {
      return Boolean(type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral));
    }
    return isSafeTelemetryScalarType(checker.getTypeAtLocation(value));
  });
}

function propertyRootIdentifier(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) return expression;
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return propertyRootIdentifier(expression.expression);
  }
  return null;
}

function resolvedIdentifierOriginSymbol(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  seen = new Set<ts.Symbol>(),
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol || seen.has(symbol)) return symbol;
  const next = new Set(seen);
  next.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    const initializer = directIdentityIdentifier(declaration.initializer);
    if (initializer) {
      return resolvedIdentifierOriginSymbol(checker, initializer, next);
    }
  }
  return symbol;
}

function identifierMayResolveToSymbol(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  expected: ts.Symbol,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (resolvedIdentifierOriginSymbol(checker, identifier) === expected) {
    return true;
  }
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol || seen.has(symbol)) return false;
  const next = new Set(seen);
  next.add(symbol);
  const binding = symbol?.valueDeclaration;
  if (
    binding &&
    ts.isVariableDeclaration(binding) &&
    binding.initializer &&
    expressionMayResolveToSymbol(checker, binding.initializer, expected, next)
  ) {
    return true;
  }
  if (!binding || !ts.isBindingElement(binding) || binding.dotDotDotToken) {
    let assignedFromExpected = false;
    const source = identifier.getSourceFile();
    function containsSymbol(node: ts.Node, target: ts.Symbol): boolean {
      let found = false;
      function visit(candidate: ts.Node): void {
        if (found) return;
        if (
          ts.isIdentifier(candidate) &&
          checker.getSymbolAtLocation(candidate) === target
        ) {
          found = true;
          return;
        }
        ts.forEachChild(candidate, visit);
      }
      visit(node);
      return found;
    }
    function containsExpectedOrigin(node: ts.Node): boolean {
      let found = false;
      function visit(candidate: ts.Node): void {
        if (found) return;
        if (
          ts.isIdentifier(candidate) &&
          identifierMayResolveToSymbol(checker, candidate, expected, next)
        ) {
          found = true;
          return;
        }
        ts.forEachChild(candidate, visit);
      }
      visit(node);
      return found;
    }
    function visitAssignments(node: ts.Node): void {
      if (assignedFromExpected || node.getStart(source) >= identifier.getStart(source)) {
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        containsSymbol(node.left, symbol) &&
        containsExpectedOrigin(node.right)
      ) {
        assignedFromExpected = true;
        return;
      }
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        containsSymbol(node.initializer, symbol) &&
        containsExpectedOrigin(node.expression)
      ) {
        assignedFromExpected = true;
        return;
      }
      ts.forEachChild(node, visitAssignments);
    }
    visitAssignments(source);
    return assignedFromExpected;
  }
  let container: ts.Node = binding;
  while (container.parent && !ts.isVariableDeclaration(container.parent)) {
    container = container.parent;
  }
  const declaration = container.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return false;
  }
  let matched = false;
  function visit(node: ts.Node): void {
    if (matched) return;
    if (
      ts.isIdentifier(node) &&
      resolvedIdentifierOriginSymbol(checker, node) === expected
    ) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration.initializer);
  return matched;
}

function resolvedObjectLiteral(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return null;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return null;
  const declaration = symbol.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return null;
  }
  const next = new Set(seen);
  next.add(symbol);
  return resolvedObjectLiteral(checker, declaration.initializer, next);
}

function staticPropertyKey(expression: ts.Expression | undefined): string | null {
  return expression && ts.isStringLiteralLike(expression) ? expression.text : null;
}

function resolvedStaticPropertyKey(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  seen = new Set<ts.Symbol>(),
): string | null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
    return expression.text;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return resolvedStaticPropertyKey(checker, expression.expression, seen);
  }
  if (!ts.isIdentifier(expression)) return null;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return null;
  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return null;
  }
  const next = new Set(seen);
  next.add(symbol);
  return resolvedStaticPropertyKey(checker, declaration.initializer, next);
}

function directIdentityIdentifier(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) return expression;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return directIdentityIdentifier(expression.expression);
  }
  return null;
}

function resolvedStoredExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.Expression | null {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return resolvedStoredExpression(checker, expression.expression, seen);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return null;
    const declaration = symbol.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    ) {
      return null;
    }
    const next = new Set(seen);
    next.add(symbol);
    return (
      resolvedStoredExpression(checker, declaration.initializer, next) ??
      declaration.initializer
    );
  }
	if (
		ts.isCallExpression(expression) &&
		ts.isPropertyAccessExpression(expression.expression) &&
		["filter", "reverse", "slice", "sort", "toReversed", "toSorted"].includes(
			expression.expression.name.text,
		)
  ) {
    return (
      resolvedStoredExpression(checker, expression.expression.expression, seen) ??
      expression.expression.expression
    );
  }
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isElementAccessExpression(expression)
  ) {
    return null;
  }

  const key = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : resolvedStaticPropertyKey(checker, expression.argumentExpression, seen);
  if (key === null) return null;
  const container =
    resolvedStoredExpression(checker, expression.expression, seen) ??
    expression.expression;
  return storedPropertyValue(checker, container, key, seen);
}

function storedPropertyValue(
  checker: ts.TypeChecker,
  container: ts.Expression,
  key: string,
  seen = new Set<ts.Symbol>(),
): ts.Expression | null {
	if (/^\d+$/.test(key)) {
		const elements = arrayElementsFromExpression(checker, container, seen);
		if (elements) return elements[Number(key)] ?? null;
	}
  const resolved = resolvedStoredExpression(checker, container, seen) ?? container;
  if (ts.isObjectLiteralExpression(resolved)) {
    const properties = [...resolved.properties].reverse();
    for (const candidate of properties) {
      if (
        (ts.isPropertyAssignment(candidate) ||
          ts.isShorthandPropertyAssignment(candidate)) &&
        (ts.isIdentifier(candidate.name) ||
          ts.isStringLiteralLike(candidate.name) ||
          ts.isNumericLiteral(candidate.name)) &&
        candidate.name.text === key
      ) {
        return ts.isPropertyAssignment(candidate)
          ? candidate.initializer
          : candidate.name;
      }
      if (ts.isSpreadAssignment(candidate)) {
        const nested = storedPropertyValue(
          checker,
          candidate.expression,
          key,
          seen,
        );
        if (nested) return nested;
      }
    }
    return null;
  }
  return null;
}

function arrayElementsFromExpression(
	checker: ts.TypeChecker,
	expression: ts.Expression,
	seen = new Set<ts.Symbol>(),
): ts.Expression[] | null {
	if (
		ts.isCallExpression(expression) &&
		ts.isPropertyAccessExpression(expression.expression) &&
		["filter", "reverse", "slice", "sort", "toReversed", "toSorted"].includes(
			expression.expression.name.text,
		)
	) {
		return arrayElementsFromExpression(
			checker,
			expression.expression.expression,
			seen,
		);
	}
	let resolved = resolvedStoredExpression(checker, expression, seen) ?? expression;
	while (
		ts.isParenthesizedExpression(resolved) ||
		ts.isAsExpression(resolved) ||
		ts.isTypeAssertionExpression(resolved) ||
		ts.isNonNullExpression(resolved) ||
		ts.isSatisfiesExpression(resolved)
	) {
		resolved = resolved.expression;
	}
	if (ts.isIdentifier(resolved)) {
		const symbol = checker.getSymbolAtLocation(resolved);
		const binding = symbol?.valueDeclaration;
		if (
			binding &&
			ts.isBindingElement(binding) &&
			binding.dotDotDotToken &&
			ts.isArrayBindingPattern(binding.parent)
		) {
			const declaration = binding.parent.parent;
			if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
				const source = arrayElementsFromExpression(
					checker,
					declaration.initializer,
					seen,
				);
				if (!source) return null;
				const index = binding.parent.elements.indexOf(binding);
				return source.slice(index);
			}
		}
	}
	if (!ts.isArrayLiteralExpression(resolved)) return null;
	const elements: ts.Expression[] = [];
	for (const element of resolved.elements) {
		if (ts.isOmittedExpression(element)) continue;
		if (ts.isSpreadElement(element)) {
			const spread = arrayElementsFromExpression(checker, element.expression, seen);
			if (!spread) return null;
			elements.push(...spread);
		} else {
			elements.push(element);
		}
	}
	return elements;
}

function returnedExpressions(
	checker: ts.TypeChecker,
	expression: ts.Node,
	seen = new Set<ts.Symbol>(),
): ts.Expression[] {
  let candidate: ts.Node = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (ts.isIdentifier(candidate)) {
	const symbol = checker.getSymbolAtLocation(candidate);
	if (!symbol || seen.has(symbol)) return [];
	const next = new Set(seen);
	next.add(symbol);
	const declaration = symbol.valueDeclaration;
	if (
		declaration &&
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer
	) {
		return returnedExpressions(checker, declaration.initializer, next);
	}
	if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) {
		candidate = declaration;
	}
  }
  if (
	!ts.isArrowFunction(candidate) &&
	!ts.isFunctionExpression(candidate) &&
	!ts.isFunctionDeclaration(candidate)
  ) {
    return [];
  }
  if (!ts.isBlock(candidate.body)) return [candidate.body];
  const returned: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node) && node !== candidate) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(candidate.body);
  return returned;
}

function expressionMayResolveToSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  expected: ts.Symbol,
  seen = new Set<ts.Symbol>(),
): boolean {
  const direct = directIdentityIdentifier(expression);
  if (direct) {
    return identifierMayResolveToSymbol(checker, direct, expected, seen);
  }
  const stored = resolvedStoredExpression(checker, expression, seen);
  if (
    stored &&
    stored !== expression &&
    expressionMayResolveToSymbol(checker, stored, expected, seen)
  ) {
    return true;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return expressionMayResolveToSymbol(
      checker,
      expression.expression,
      expected,
      seen,
    );
  }
  if (ts.isCallExpression(expression)) {
    if (
      expression.arguments.length === 0 &&
      returnedExpressions(checker, expression.expression, seen).some((returned) =>
        expressionMayResolveToSymbol(checker, returned, expected, seen),
      )
    ) {
      return true;
    }
    if (
      expression.arguments.some((argument) =>
        expressionMayResolveToSymbol(checker, argument, expected, seen),
      )
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      ["at", "find", "pop", "shift"].includes(expression.expression.name.text)
    ) {
      const key =
        expression.expression.name.text === "at"
          ? resolvedStaticPropertyKey(checker, expression.arguments[0], seen)
          : expression.expression.name.text === "shift"
            ? "0"
            : null;
      if (key !== null) {
        const value = storedPropertyValue(
          checker,
          expression.expression.expression,
          key,
          seen,
        );
        if (value && expressionMayResolveToSymbol(checker, value, expected, seen)) {
          return true;
        }
      }
      const receiver = resolvedStoredExpression(
        checker,
        expression.expression.expression,
        seen,
      );
      if (
        receiver &&
        ts.isArrayLiteralExpression(receiver) &&
        receiver.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) &&
            expressionMayResolveToSymbol(checker, element, expected, seen),
        )
      ) {
        return true;
      }
    }
    return false;
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionMayResolveToSymbol(checker, expression.whenTrue, expected, seen) ||
      expressionMayResolveToSymbol(checker, expression.whenFalse, expected, seen)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.CommaToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return (
      expressionMayResolveToSymbol(checker, expression.left, expected, seen) ||
      expressionMayResolveToSymbol(checker, expression.right, expected, seen)
    );
  }

  let container: ts.Expression;
  let key: string | null;
  if (ts.isPropertyAccessExpression(expression)) {
    container = expression.expression;
    key = expression.name.text;
  } else if (ts.isElementAccessExpression(expression)) {
    container = expression.expression;
    key = resolvedStaticPropertyKey(
      checker,
      expression.argumentExpression,
      seen,
    );
  } else {
    return false;
  }
  if (key === null) return false;
	const collectionElements = arrayElementsFromExpression(checker, container, seen);
	if (
		collectionElements?.some((element) =>
			expressionMayResolveToSymbol(checker, element, expected, seen),
		)
	) {
		return true;
	}

  if (storedWriteMayResolveToSymbol(checker, expression, expected, seen)) {
    return true;
  }

  const object = resolvedObjectLiteral(checker, container, seen);
  if (object) {
    const property = object.properties.find((candidate) => {
      if (
        !ts.isPropertyAssignment(candidate) &&
        !ts.isShorthandPropertyAssignment(candidate)
      ) {
        return false;
      }
      return (
        (ts.isIdentifier(candidate.name) ||
          ts.isStringLiteralLike(candidate.name) ||
          ts.isNumericLiteral(candidate.name)) &&
        candidate.name.text === key
      );
    });
    if (property) {
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name;
      return expressionMayResolveToSymbol(checker, value, expected, seen);
    }
  }

  if (ts.isIdentifier(container)) {
    const symbol = checker.getSymbolAtLocation(container);
    if (symbol && !seen.has(symbol)) {
      const declaration = symbol.valueDeclaration;
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      ) {
        const initializer = declaration.initializer;
        if (ts.isArrayLiteralExpression(initializer) && /^\d+$/.test(key)) {
          const element = initializer.elements[Number(key)];
          if (element && !ts.isOmittedExpression(element)) {
            const next = new Set(seen);
            next.add(symbol);
            return expressionMayResolveToSymbol(
              checker,
              element,
              expected,
              next,
            );
          }
        }
      }
    }
  }
  return false;
}

function storedWriteMayResolveToSymbol(
  checker: ts.TypeChecker,
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  expected: ts.Symbol,
  seen: Set<ts.Symbol>,
): boolean {
  const source = expression.getSourceFile();
  const root = propertyRootIdentifier(expression);
  const rootSymbol = root
    ? resolvedIdentifierOriginSymbol(checker, root) ?? checker.getSymbolAtLocation(root)
    : undefined;
  const key = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : resolvedStaticPropertyKey(checker, expression.argumentExpression, seen);
  if (!rootSymbol || key === null) return false;
  let matched = false;
  function visit(node: ts.Node): void {
    if (matched || node.getStart(source) >= expression.getStart(source)) return;
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) ||
        ts.isElementAccessExpression(node.left))
    ) {
      const candidateRoot = propertyRootIdentifier(node.left);
      const candidateRootSymbol = candidateRoot
        ? resolvedIdentifierOriginSymbol(checker, candidateRoot) ??
          checker.getSymbolAtLocation(candidateRoot)
        : undefined;
      const candidateKey = ts.isPropertyAccessExpression(node.left)
        ? node.left.name.text
        : resolvedStaticPropertyKey(
            checker,
            node.left.argumentExpression,
            seen,
          );
      if (
        candidateRootSymbol === rootSymbol &&
        candidateKey === key &&
        expressionMayResolveToSymbol(checker, node.right, expected, seen)
      ) {
        matched = true;
        return;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      (resolvedIdentifierOriginSymbol(checker, node.left) ??
        checker.getSymbolAtLocation(node.left)) === rootSymbol
    ) {
      const value = storedPropertyValue(checker, node.right, key, seen);
      if (value && expressionMayResolveToSymbol(checker, value, expected, seen)) {
        matched = true;
        return;
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const mutator = propertyPath(node.expression);
      const target = propertyRootIdentifier(node.arguments[0]);
      const targetSymbol = target
        ? resolvedIdentifierOriginSymbol(checker, target) ??
          checker.getSymbolAtLocation(target)
        : undefined;
      if (targetSymbol === rootSymbol && mutator === "Object.assign") {
        for (const patch of node.arguments.slice(1)) {
          const value = storedPropertyValue(checker, patch, key, seen);
          if (
            value &&
            expressionMayResolveToSymbol(checker, value, expected, seen)
          ) {
            matched = true;
            return;
          }
        }
      }
      if (
        targetSymbol === rootSymbol &&
        ["Object.defineProperty", "Reflect.defineProperty"].includes(
          mutator ?? "",
        ) &&
        resolvedStaticPropertyKey(checker, node.arguments[1], seen) === key
      ) {
        const value = storedPropertyValue(
          checker,
          node.arguments[2],
          "value",
          seen,
        );
        if (
          value &&
          expressionMayResolveToSymbol(checker, value, expected, seen)
        ) {
          matched = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matched;
}

function isInsideTerminatingNestedBlock(
  source: ts.SourceFile,
  candidate: ts.Node,
  call: ts.CallExpression,
): boolean {
  for (let current: ts.Node | undefined = candidate.parent; current; current = current.parent) {
    if (current === call || current === source) break;
    if (
      ts.isBlock(current) &&
      !current.statements.some((statement) =>
        statement.pos <= call.pos && call.end <= statement.end
      )
    ) {
      const last = current.statements.at(-1);
      if (last && (ts.isReturnStatement(last) || ts.isThrowStatement(last))) {
        return true;
      }
    }
  }
  return false;
}

function propertyAssignedValuesBeforeCall(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
): Array<ts.Expression | null | undefined> {
  const expectedPath = propertyPath(expression);
  const expectedSuffix = expectedPath?.split(".").slice(1).join(".");
  const expectedRoot = propertyRootIdentifier(expression);
  const expectedSymbol = expectedRoot
    ? resolvedIdentifierOriginSymbol(checker, expectedRoot)
    : undefined;
  if (!expectedPath || !expectedSuffix || !expectedRoot || !expectedSymbol) {
    return [undefined];
  }
  const assigned: Array<ts.Expression | null | undefined> = [];
  function match(candidate: ts.Expression): "exact" | "uncertain" | "none" {
    const root = propertyRootIdentifier(candidate);
    if (
      root === null ||
      !identifierMayResolveToSymbol(checker, root, expectedSymbol)
    ) {
      return "none";
    }
    if (hasDynamicElementAccess(candidate)) return "uncertain";
    return propertyPath(candidate)?.split(".").slice(1).join(".") === expectedSuffix
      ? "exact"
      : "none";
  }
  function visit(node: ts.Node): void {
    if (node.getStart(source) >= call.getStart(source)) return;
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      match(node.left) !== "none"
    ) {
      const candidateMatch = match(node.left);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        assigned.push(candidateMatch === "exact" ? node.right : undefined);
      } else {
        const rightType = checker.getTypeAtLocation(node.right);
        const numericRight = Boolean(
          rightType.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral),
        );
        assigned.push(
          numericAssignmentOperators.has(node.operatorToken.kind) && numericRight
            ? node.right
            : undefined,
        );
      }
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      match(node.operand) !== "none"
    ) {
      assigned.push(null);
      return;
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      ts.isExpression(node.initializer) &&
      match(node.initializer) !== "none"
    ) {
      assigned.push(
        match(node.initializer) === "exact" ? node.expression : undefined,
      );
      return;
    }
    if (
      ts.isCallExpression(node) &&
      propertyPath(node.expression) === "Object.assign" &&
      node.arguments.length >= 2
    ) {
      const target = propertyRootIdentifier(node.arguments[0]);
      const patch = resolvedObjectLiteral(checker, node.arguments[1]);
      if (
        target &&
        identifierMayResolveToSymbol(checker, target, expectedSymbol)
      ) {
        const property = patch?.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) &&
            (ts.isIdentifier(candidate.name) ||
              ts.isStringLiteralLike(candidate.name)) &&
            candidate.name.text === expression.name.text,
        );
        assigned.push(property?.initializer ?? node);
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const mutator = propertyPath(node.expression);
      const target = propertyRootIdentifier(node.arguments[0]);
      if (
        target &&
        identifierMayResolveToSymbol(checker, target, expectedSymbol)
      ) {
        const key = staticPropertyKey(node.arguments[1]);
        const expectedKey = expression.name.text;
        if (mutator === "Reflect.set") {
          if (key === expectedKey) assigned.push(node.arguments[2]);
          else if (key === null) assigned.push(undefined);
        }
        if (
          mutator === "Object.defineProperty" ||
          mutator === "Reflect.defineProperty"
        ) {
          if (key === expectedKey) {
            const descriptor = resolvedObjectLiteral(checker, node.arguments[2]);
            const value = descriptor?.properties.find(
              (candidate): candidate is ts.PropertyAssignment =>
                ts.isPropertyAssignment(candidate) &&
                (ts.isIdentifier(candidate.name) ||
                  ts.isStringLiteralLike(candidate.name)) &&
                candidate.name.text === "value",
            );
            assigned.push(value?.initializer ?? node);
          } else if (key === null) {
            assigned.push(undefined);
          }
        }
        if (
          mutator === "Object.setPrototypeOf" ||
          mutator === "Reflect.setPrototypeOf"
        ) {
          assigned.push(undefined);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (isInsideTerminatingNestedBlock(source, node, call)) return;
      const mutator = propertyPath(node.expression);
      const handledTargetMutators = new Set([
        "Object.assign",
        "Object.defineProperty",
        "Object.setPrototypeOf",
        "Reflect.defineProperty",
        "Reflect.set",
        "Reflect.setPrototypeOf",
      ]);
      const unresolvedIdentityArgument = node.arguments.some((argument, index) => {
        if (!expressionMayResolveToSymbol(checker, argument, expectedSymbol)) {
          return false;
        }
        if (mutator === "Object.assign" && index > 0) return false;
        return !(index === 0 && handledTargetMutators.has(mutator ?? ""));
      });
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : null;
      const unresolvedReceiver =
        receiver !== null &&
        expressionMayResolveToSymbol(checker, receiver, expectedSymbol) &&
        !(
          ts.isPropertyAccessExpression(node.expression) &&
          new Set([
            "concat",
            "entries",
            "every",
            "filter",
            "find",
            "findIndex",
            "flat",
            "flatMap",
            "forEach",
            "includes",
            "indexOf",
            "join",
            "keys",
            "lastIndexOf",
            "map",
            "reduce",
            "reduceRight",
            "slice",
            "some",
            "values",
          ]).has(node.expression.name.text)
        );
      if (unresolvedIdentityArgument || unresolvedReceiver) {
        assigned.push(undefined);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return assigned;
}

function isSafeTelemetryScalarType(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every(isSafeTelemetryScalarType);
  }
  if (
    type.flags &
    (ts.TypeFlags.Number |
      ts.TypeFlags.NumberLiteral |
      ts.TypeFlags.Boolean |
      ts.TypeFlags.BooleanLiteral |
      ts.TypeFlags.StringLiteral |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined)
  ) {
    return true;
  }
  return false;
}

function isSafeDeclaredScalarType(
  source: ts.SourceFile,
  type: ts.TypeNode | undefined,
  seenAliases = new Set<string>(),
): boolean {
  if (!type) return false;
  if (
    type.kind === ts.SyntaxKind.NumberKeyword ||
    type.kind === ts.SyntaxKind.BooleanKeyword
  ) {
    return true;
  }
  if (ts.isLiteralTypeNode(type)) {
    return (
      ts.isStringLiteral(type.literal) ||
      ts.isNumericLiteral(type.literal) ||
      type.literal.kind === ts.SyntaxKind.TrueKeyword ||
      type.literal.kind === ts.SyntaxKind.FalseKeyword
    );
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((candidate) =>
      isSafeDeclaredScalarType(source, candidate, seenAliases),
    );
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return isSafeDeclaredScalarType(source, type.type, seenAliases);
  }
  if (
    ts.isIndexedAccessTypeNode(type) &&
    type.indexType.kind === ts.SyntaxKind.NumberKeyword &&
    ts.isParenthesizedTypeNode(type.objectType) &&
    ts.isTypeQueryNode(type.objectType.type) &&
    ts.isIdentifier(type.objectType.type.exprName)
  ) {
    const tupleName = type.objectType.type.exprName.text;
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .filter(
        (statement) =>
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
      )
      .flatMap((statement) => statement.declarationList.declarations)
      .find(
        (candidate) =>
          ts.isIdentifier(candidate.name) && candidate.name.text === tupleName,
      );
    if (
      !declaration?.initializer ||
      !ts.isAsExpression(declaration.initializer) ||
      !ts.isTypeReferenceNode(declaration.initializer.type) ||
      !ts.isIdentifier(declaration.initializer.type.typeName) ||
      declaration.initializer.type.typeName.text !== "const" ||
      !ts.isArrayLiteralExpression(declaration.initializer.expression)
    ) {
      return false;
    }
    return declaration.initializer.expression.elements.every(
      (element) =>
        ts.isStringLiteral(element) ||
        ts.isNumericLiteral(element) ||
        element.kind === ts.SyntaxKind.TrueKeyword ||
        element.kind === ts.SyntaxKind.FalseKeyword,
    );
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    if (name === "Promise" && type.typeArguments?.length === 1) {
      return isSafeDeclaredScalarType(source, type.typeArguments[0], seenAliases);
    }
    if (seenAliases.has(name)) return false;
    const alias = source.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );
    if (!alias) return false;
    const next = new Set(seenAliases);
    next.add(name);
    return isSafeDeclaredScalarType(source, alias.type, next);
  }
  return false;
}

function isKnownNumericCall(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.CallExpression,
): boolean {
  if (
    ts.isIdentifier(expression.expression) &&
    ["durationMs", "jitteredBackoff", "retryDelaySeconds"].includes(
      expression.expression.text,
    ) &&
    isTrustedNamedHelper(source, call, expression.expression.text)
  ) {
    return callReturnsNumber(source, expression);
  }
  const path = propertyPath(expression.expression);
  if (path === "Date.now") {
    const root = path.includes(".") ? path.slice(0, path.indexOf(".")) : path;
    return (
      nearestValueDeclaration(source, call, root) === null &&
      callReturnsNumber(source, expression)
    );
  }
  if (
    path === "Number" ||
    path === "Math.floor" ||
    path === "Math.max" ||
    path === "Math.min"
  ) {
    const root = path.includes(".") ? path.slice(0, path.indexOf(".")) : path;
    return (
      nearestValueDeclaration(source, call, root) === null &&
      callReturnsNumber(source, expression) &&
      expression.arguments.every((argument) =>
        isSafeNumericExpression(source, call, argument, new Set()),
      )
    );
  }
  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "getTime" &&
    ts.isCallExpression(expression.expression.expression) &&
    propertyPath(expression.expression.expression.expression) === "runtime.now"
  ) {
    return callReturnsNumber(source, expression);
  }
  return (
    ts.isPropertyAccessExpression(expression.expression) &&
    propertyPath(expression.expression) === "input.expectedSize" &&
    callReturnsNumber(source, expression)
  );
}

function callReturnsNumber(
  source: ts.SourceFile,
  expression: ts.CallExpression,
): boolean {
  const type = checkerBySource.get(source)?.getTypeAtLocation(expression);
  if (!type) return false;
  if (type.isUnion()) return type.types.every((candidate) =>
    Boolean(candidate.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)),
  );
  return Boolean(type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral));
}

function isFilteredResultLength(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "length" &&
    ts.isCallExpression(expression.expression) &&
    ts.isPropertyAccessExpression(expression.expression.expression) &&
    expression.expression.expression.name.text === "filter"
  );
}

function isSafeNumericExpression(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
  seen: Set<string>,
): boolean {
  if (ts.isNumericLiteral(expression)) return true;
  if (ts.isParenthesizedExpression(expression)) {
    return isSafeNumericExpression(source, call, expression.expression, seen);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isSafeNumericExpression(source, call, expression.whenTrue, seen) &&
      isSafeNumericExpression(source, call, expression.whenFalse, seen)
    );
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      (expression.operator === ts.SyntaxKind.PlusToken ||
        expression.operator === ts.SyntaxKind.MinusToken) &&
      isSafeNumericExpression(source, call, expression.operand, seen)
    );
  }
  if (ts.isBinaryExpression(expression)) {
    return (
      safeNumericBinaryOperators.has(expression.operatorToken.kind) &&
      isSafeNumericExpression(source, call, expression.left, seen) &&
      isSafeNumericExpression(source, call, expression.right, seen)
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const path = propertyPath(expression);
    if (path !== null && numericScalarPropertyPaths.has(path)) {
      return isDeclaredScalarPropertyPath(source, call, expression);
    }
    return isFilteredResultLength(expression);
  }
  if (ts.isCallExpression(expression)) {
    return isKnownNumericCall(source, call, expression);
  }
  if (ts.isIdentifier(expression)) {
    if (forbiddenScalarIdentifiers.has(expression.text) || seen.has(expression.text)) {
      return false;
    }
    const declaration = nearestValueDeclaration(source, call, expression.text);
    if (!declaration) return false;
    const next = new Set(seen);
    next.add(expression.text);
    if (
      assignedValuesBeforeCall(source, call, declaration, expression.text).some(
        (value) =>
          value !== null &&
          !isSafeNumericExpression(source, call, value, next),
      )
    ) {
      return false;
    }
    if (declaration.initializer) {
      return isSafeNumericExpression(source, call, declaration.initializer, next);
    }
    return (
      declaration.type?.kind === ts.SyntaxKind.NumberKeyword ||
      (declaration.type !== undefined &&
        ts.isLiteralTypeNode(declaration.type) &&
        ts.isNumericLiteral(declaration.type.literal))
    );
  }
  return false;
}

function isSafeScalarExpression(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
  seen = new Set<string>(),
): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isSafeScalarExpression(source, call, expression.expression, seen);
  }
  if (ts.isAwaitExpression(expression)) {
    return isSafeScalarExpression(source, call, expression.expression, seen);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isSafeScalarExpression(source, call, expression.whenTrue, seen) &&
      isSafeScalarExpression(source, call, expression.whenFalse, seen)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return (
      isSafeScalarExpression(source, call, expression.left, seen) &&
      isSafeScalarExpression(source, call, expression.right, seen)
    );
  }
  if (ts.isBinaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
    return isSafeNumericExpression(source, call, expression, seen);
  }
  if (ts.isCallExpression(expression)) {
    return (
      isKnownNumericCall(source, call, expression) ||
      (ts.isIdentifier(expression.expression) &&
        safeScalarCallNames.has(expression.expression.text) &&
        isTrustedNamedHelper(source, call, expression.expression.text))
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const path = propertyPath(expression);
    return (
      (path !== null &&
        allowedScalarPropertyPaths.has(path) &&
        isDeclaredScalarPropertyPath(source, call, expression)) ||
      isFilteredResultLength(expression)
    );
  }
  if (ts.isIdentifier(expression)) {
    if (forbiddenScalarIdentifiers.has(expression.text) || seen.has(expression.text)) {
      return false;
    }
    const declaration = nearestValueDeclaration(source, call, expression.text);
    if (!declaration) return false;
    const next = new Set(seen);
    next.add(expression.text);
    if (
      assignedValuesBeforeCall(source, call, declaration, expression.text).some(
        (value) =>
          value === null ||
          !isSafeScalarExpression(source, call, value, next),
      )
    ) {
      return false;
    }
    return declaration.initializer
      ? isSafeScalarExpression(source, call, declaration.initializer, next)
      : isSafeDeclaredScalarType(source, declaration.type);
  }
  return false;
}

function isConsoleCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console" &&
    ["debug", "error", "info", "log", "warn"].includes(
      node.expression.name.text,
    )
  );
}

function isConsoleReference(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
): boolean {
  if (ts.isIdentifier(expression) && expression.text === "console") return true;
  if (!ts.isIdentifier(expression)) return false;
  const declaration = nearestValueDeclaration(source, call, expression.text);
  return Boolean(
    declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      containsConsoleIdentifier(declaration.initializer),
  );
}

function containsConsoleIdentifier(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "console") return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsConsoleIdentifier(child)) found = true;
  });
  return found;
}

function isDestructuredConsoleMethod(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
): boolean {
  if (!ts.isIdentifier(expression)) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (found || node.getStart(source) >= call.getStart(source)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "console"
    ) {
      found = node.name.elements.some((element) => {
        if (!ts.isIdentifier(element.name) || element.name.text !== expression.text) {
          return false;
        }
        const method = element.propertyName ?? element.name;
        return (
          ts.isIdentifier(method) &&
          ["debug", "error", "info", "log", "warn"].includes(method.text)
        );
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function isConsoleMethodReference(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
): boolean {
  if (isDestructuredConsoleMethod(source, call, expression)) return true;
  if (ts.isIdentifier(expression)) {
    const declaration = nearestValueDeclaration(source, call, expression.text);
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isConsoleMethodAliasInitializer(source, call, declaration.initializer)
    ) {
      return true;
    }
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ["debug", "error", "info", "log", "warn"].includes(
        expression.name.text,
      ) && isConsoleReference(source, call, expression.expression)
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return isConsoleReference(source, call, expression.expression);
  }
  return false;
}

function isConsoleMethodAliasInitializer(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isConsoleMethodAliasInitializer(source, call, expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isConsoleMethodAliasInitializer(source, call, expression.whenTrue) ||
      isConsoleMethodAliasInitializer(source, call, expression.whenFalse)
    );
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    if (isConsoleMethodReference(source, call, expression)) return true;
    return isConsoleMethodReference(source, call, expression.expression);
  }
  if (
    ts.isCallExpression(expression) &&
    (ts.isPropertyAccessExpression(expression.expression) ||
      ts.isElementAccessExpression(expression.expression))
  ) {
    return isConsoleMethodReference(source, call, expression.expression.expression);
  }
  return false;
}

function isIndirectConsoleCall(
  source: ts.SourceFile,
  node: ts.Node,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || isConsoleCall(node)) return false;
  if (isConsoleMethodReference(source, node, node.expression)) return true;
  if (
    (ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)) &&
    isConsoleMethodReference(source, node, node.expression.expression)
  ) {
    return true;
  }
  return (
    ts.isCallExpression(node.expression) &&
    (ts.isPropertyAccessExpression(node.expression.expression) ||
      ts.isElementAccessExpression(node.expression.expression)) &&
    isConsoleMethodReference(
      source,
      node,
      node.expression.expression.expression,
    )
  );
}

function isApprovedNonMailIndirectConsoleCall(
  source: ts.SourceFile,
  node: ts.CallExpression,
  label: string,
): boolean {
  if (!label.endsWith("/workers/routes/bulk-api.ts")) return false;
  if (
    !ts.isElementAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "console" ||
    !ts.isIdentifier(node.expression.argumentExpression) ||
    node.expression.argumentExpression.text !== "level" ||
    node.arguments.length !== 2 ||
    !ts.isStringLiteral(node.arguments[0]) ||
    node.arguments[0].text !== "[bulk-send] route completed"
  ) {
    return false;
  }
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1 === 63;
}

function isApprovedConsoleIdentifierUse(
  source: ts.SourceFile,
  node: ts.Identifier,
  label: string,
): boolean {
  const access = node.parent;
  const call = access.parent;
  if (
    ts.isPropertyAccessExpression(access) &&
    access.expression === node &&
    ["debug", "error", "info", "log", "warn"].includes(access.name.text) &&
    ts.isCallExpression(call) &&
    call.expression === access
  ) {
    return true;
  }
  return (
    ts.isElementAccessExpression(access) &&
    access.expression === node &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    isApprovedNonMailIndirectConsoleCall(source, call, label)
  );
}

function bindingContainsName(name: ts.BindingName, expected: string): boolean {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(
    (element) =>
      ts.isBindingElement(element) &&
      bindingContainsName(element.name, expected),
  );
}

function unwrapOpaqueInitializer(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return unwrapOpaqueInitializer(expression.expression);
  }
  return expression;
}

function isExactNamedCall(
  source: ts.SourceFile,
  call: ts.CallExpression,
  expression: ts.Expression,
  name: string,
): boolean {
  const unwrapped = unwrapOpaqueInitializer(expression);
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === name &&
    (name === "projectionTelemetryRefs"
      ? hasVerifiedProjectionTelemetryRefsHelper(source, call)
      : name === "bestEffortMailTelemetryLogRef"
        ? hasVerifiedBestEffortMailTelemetryLogRefHelper(source)
        : isTrustedNamedHelper(source, unwrapped, name))
  );
}

function hasVerifiedBestEffortMailTelemetryLogRefHelper(
  source: ts.SourceFile,
): boolean {
  const helpers = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "bestEffortMailTelemetryLogRef",
  );
  if (helpers.length !== 1 || !helpers[0].body) return false;
  const text = helpers[0].body.getText(source);
  return (
    /Promise\.race\(\[/.test(text) &&
    (/mailTelemetryLogRef\(kind, value\)/.test(text) ||
      /runtime\.telemetryLogRef\(kind, value\)/.test(text)) &&
    (/setTimeout\(\(\) => resolve\("unavailable"\), 25\)/.test(text) ||
      /runtime\.bestEffortTimeoutMs/.test(text)) &&
    /catch\s*\{\s*return "unavailable";\s*\}/s.test(text) &&
    /clearTimeout\(timeout\)/.test(text)
  );
}

function hasVerifiedProjectionTelemetryRefsHelper(
  source: ts.SourceFile,
  call: ts.CallExpression,
): boolean {
  const helpers: ts.FunctionDeclaration[] = [];
  function findHelper(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "projectionTelemetryRefs"
    ) {
      helpers.push(node);
      return;
    }
    ts.forEachChild(node, findHelper);
  }
  findHelper(source);
  if (helpers.length !== 1 || !helpers[0].body) return false;
  const helper = helpers[0];
  const refs = ["ingressRef", "objectRef", "queueRef"] as const;
  const returnedDeclarations = new Map<string, ts.VariableDeclaration>();
  const checker = checkerBySource.get(source);
  if (!checker) return false;
  function inspect(node: ts.Node): void {
    if (ts.isFunctionLike(node) && node !== helper) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrapOpaqueInitializer(node.expression);
      if (
        ts.isObjectLiteralExpression(expression) &&
        expression.properties.length === refs.length &&
        refs.every((ref) =>
          expression.properties.some(
            (property) =>
              ts.isShorthandPropertyAssignment(property) &&
              property.name.text === ref,
          ),
        )
      ) {
        for (const property of expression.properties) {
          if (!ts.isShorthandPropertyAssignment(property)) continue;
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          let declaration = symbol?.valueDeclaration;
          while (declaration && !ts.isVariableDeclaration(declaration)) {
            declaration = declaration.parent;
          }
          if (declaration && ts.isVariableDeclaration(declaration)) {
            returnedDeclarations.set(property.name.text, declaration);
          }
        }
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(helper.body);
  return refs.every((ref) => {
    const declaration = returnedDeclarations.get(ref);
    return Boolean(
      declaration &&
        bindingContainsName(declaration.name, ref) &&
        initializerHasExactOpaqueRefOrigin(source, call, declaration, ref),
    );
  });
}

function initializerHasExactOpaqueRefOrigin(
  source: ts.SourceFile,
  call: ts.CallExpression,
  declaration: ts.VariableDeclaration,
  refName: string,
): boolean {
  if (!declaration.initializer) return false;
  if (ts.isIdentifier(declaration.name)) {
    const initializer = unwrapOpaqueInitializer(declaration.initializer);
    return (
      declaration.name.text === refName &&
      ((ts.isStringLiteral(initializer) &&
        initializer.text === "unavailable") ||
        isExactNamedCall(
          source,
          call,
          declaration.initializer,
          "mailTelemetryLogRef",
        ) ||
        isExactNamedCall(
          source,
          call,
          declaration.initializer,
          "bestEffortMailTelemetryLogRef",
        ))
    );
  }
  if (ts.isObjectBindingPattern(declaration.name)) {
    return (
      declaration.name.elements.some(
        (element) =>
          ts.isIdentifier(element.name) && element.name.text === refName,
      ) &&
      isExactNamedCall(
        source,
        call,
        declaration.initializer,
        "projectionTelemetryRefs",
      )
    );
  }
  if (!ts.isArrayBindingPattern(declaration.name)) return false;
  const index = declaration.name.elements.findIndex(
    (element) =>
      ts.isBindingElement(element) &&
      ts.isIdentifier(element.name) &&
      element.name.text === refName,
  );
  const initializer = unwrapOpaqueInitializer(declaration.initializer);
  if (
    index < 0 ||
    !ts.isCallExpression(initializer) ||
    propertyPath(initializer.expression) !== "Promise.all" ||
    initializer.arguments.length !== 1 ||
    !ts.isArrayLiteralExpression(initializer.arguments[0])
  ) {
    return false;
  }
  const refSource = initializer.arguments[0].elements[index];
  return Boolean(
    refSource &&
      (isExactNamedCall(source, call, refSource, "mailTelemetryLogRef") ||
        isExactNamedCall(
          source,
          call,
          refSource,
          "bestEffortMailTelemetryLogRef",
        )),
  );
}

function assertOpaqueRefOrigin(
  source: ts.SourceFile,
  call: ts.CallExpression,
  reference: ts.Identifier,
  label: string,
): void {
  const refName = reference.text;
  const checker = checkerBySource.get(source);
  const symbol =
    checker && ts.isShorthandPropertyAssignment(reference.parent)
      ? checker.getShorthandAssignmentValueSymbol(reference.parent)
      : checker?.getSymbolAtLocation(reference);
  let declaration = symbol?.valueDeclaration;
  while (declaration && !ts.isVariableDeclaration(declaration)) {
    declaration = declaration.parent;
  }
  assert.equal(
    Boolean(declaration) &&
      ts.isVariableDeclaration(declaration) &&
      Boolean(declaration.initializer) &&
      initializerHasExactOpaqueRefOrigin(source, call, declaration, refName) &&
      !isReassignedBeforeCall(source, call, declaration, refName),
    true,
    `${label} derives ${refName} from the checked resolved opaque-ref binding`,
  );
}

function assertClosedPrivacySafeConsoleScope(
  source: ts.SourceFile,
  scope: ts.Node,
  label: string,
  options: {
    expectedPrefix?: string;
    onlyStaticMail?: boolean;
    requireCalls?: boolean;
  } = {},
): number {
  let callCount = 0;

  function isWorkerGlobalIdentifier(node: ts.Identifier): boolean {
    if (node.text === "globalThis") return true;
    if (node.text !== "self") return false;
    const symbol = checkerBySource.get(source)?.getSymbolAtLocation(node);
    if (!symbol) return true;
    const declarations = symbol.getDeclarations();
    return !declarations?.some(
      (declaration) => !declaration.getSourceFile().isDeclarationFile,
    );
  }

  function visit(node: ts.Node): void {
    if (
      options.onlyStaticMail &&
      ts.isIdentifier(node) &&
      isWorkerGlobalIdentifier(node)
    ) {
      assert.fail(
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} production telemetry code cannot reach console through Worker globals`,
      );
    }
    if (
      options.onlyStaticMail &&
      ts.isIdentifier(node) &&
      node.text === "console"
    ) {
      assert.equal(
        isApprovedConsoleIdentifierUse(source, node, label),
        true,
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} production console is used only through a direct recognized method`,
      );
    }
    if (isIndirectConsoleCall(source, node)) {
      assert.equal(
        isApprovedNonMailIndirectConsoleCall(source, node, label),
        true,
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} production console calls use a direct recognized method`,
      );
      ts.forEachChild(node, visit);
      return;
    }
    if (isConsoleCall(node)) {
      const candidateMessage = node.arguments[0];
      if (options.onlyStaticMail) {
        assert.ok(
          candidateMessage && ts.isStringLiteral(candidateMessage),
          `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} production console message is a static literal`,
        );
      }
      if (
        options.onlyStaticMail &&
        candidateMessage &&
        ts.isStringLiteral(candidateMessage) &&
        !candidateMessage.text.startsWith("[mail-")
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      callCount += 1;
      assert.equal(
        node.arguments.length,
        2,
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} telemetry call has message and one payload`,
      );
      const payload = node.arguments[1];
      const message = node.arguments[0];
      const prefix =
        message && ts.isStringLiteral(message)
          ? message.text.slice(0, message.text.indexOf("]") + 1)
          : "";
      assert.ok(
        message &&
          ts.isStringLiteral(message) &&
          approvedMailTelemetryPrefixes.has(prefix) &&
          /^\[mail-[a-z-]+\] [A-Za-z0-9 .-]+$/.test(message.text) &&
          (!options.expectedPrefix || message.text.startsWith(options.expectedPrefix)),
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} telemetry message is a recognized static event in the expected mail scope`,
      );
      assert.ok(
        payload && ts.isObjectLiteralExpression(payload),
        `${label}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} telemetry payload is an object literal`,
      );
      for (const property of payload.properties) {
        assert.ok(
          ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property),
          `${label} telemetry payload has only ordinary scalar properties`,
        );
        assert.ok(
          ts.isIdentifier(property.name),
          `${label} telemetry property name is a non-computed identifier`,
        );
        const propertyName = property.name.text;
        assert.equal(
          forbiddenTelemetryFields.has(propertyName),
          false,
          `${label} telemetry excludes ${propertyName}`,
        );
        assert.equal(
          allowedTelemetryFields.has(propertyName),
          true,
          `${label} telemetry field ${propertyName} is explicitly allowed`,
        );
        const initializer = ts.isPropertyAssignment(property)
          ? property.initializer
          : property.name;
        if (telemetryRefFields.has(propertyName)) {
          assert.ok(
            ts.isIdentifier(initializer) && initializer.text === propertyName,
            `${label} telemetry field ${propertyName} uses its opaque ref variable`,
          );
          assertOpaqueRefOrigin(source, node, initializer, label);
        } else {
          assert.equal(
            isSafeScalarExpression(source, node, initializer),
            true,
            `${label}:${source.getLineAndCharacterOfPosition(property.getStart()).line + 1} telemetry field ${propertyName} is a provably scalar expression`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(scope);
  if (options.requireCalls !== false) {
    assert.ok(callCount > 0, `${label} contains telemetry calls`);
  }
  return callCount;
}

function assertClosedPrivacySafeConsolePayloads(
  relativePath: string,
  expectedPrefix: string,
): void {
  const url = new URL(relativePath, import.meta.url);
  const source = projectSource(fileURLToPath(url));
  assertClosedPrivacySafeConsoleScope(source, source, relativePath, {
    expectedPrefix,
  });
}

function classMethodNode(source: ts.SourceFile, name: string): ts.MethodDeclaration {
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
  return method;
}

function productionTypescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(path);
    return entry.isFile() &&
      [".ts", ".tsx", ".mts", ".cts"].some((extension) =>
        entry.name.endsWith(extension),
      ) &&
      !/\.test\.(?:ts|tsx|mts|cts)$/.test(entry.name)
      ? [path]
      : [];
  });
}

test("inbound ingress emits only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads("./inbound-email.ts", "[mail-ingress]");
});

test("Queue and dead-letter consumers emit only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads("./inbound-queue.ts", "[mail-projection]");
});

test("mail storage emits only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads("./lib/store-email.ts", "[mail-store]");
  assertClosedPrivacySafeConsolePayloads("./lib/streaming-email.ts", "[mail-store]");
});

test("repair and cleanup sweep logs emit only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads(
    "./lib/inbound-derived-content-repair-attempt.ts",
    "[mail-reconciliation]",
  );
  assertClosedPrivacySafeConsolePayloads(
    "./lib/inbound-derived-content-cleanup-intent.ts",
    "[mail-reconciliation]",
  );
  const path = "./durableObject/index.ts";
  const source = projectSource(fileURLToPath(new URL(path, import.meta.url)));
  assertClosedPrivacySafeConsoleScope(
    source,
    classMethodNode(source, "processR2DeletionOutbox"),
    `${path}#processR2DeletionOutbox`,
    { expectedPrefix: "[mail-cleanup]" },
  );
});

test("manual import and recovery emit only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads("./lib/import/import-email.ts", "[mail-import]");
  assertClosedPrivacySafeConsolePayloads(
    "./lib/import/audited-inbound-recovery.ts",
    "[mail-recovery]",
  );
  assertClosedPrivacySafeConsolePayloads(
    "./routes/admin-inbound-recovery.ts",
    "[mail-recovery]",
  );
});

test("the Worker inbound-email catch logs a bounded event and rethrows", () => {
  const source = projectSource(
    fileURLToPath(new URL("./app.ts", import.meta.url)),
  );
  assertClosedPrivacySafeConsoleScope(
    source,
    classMethodNode(source, "email"),
    "app.ts#email",
    { expectedPrefix: "[mail-ingress]" },
  );
  const handler = classMethodText(source, "email");
  assert.match(handler, /\[mail-ingress\] outer handler failed/);
  assert.match(handler, /errorCode: "INBOUND_EMAIL_HANDLER_FAILED"/);
  assert.match(handler, /throw error/);
  assert.doesNotMatch(handler, /\.message|\.name|\.stack/);
});

test("inbound reconciliation emits only closed privacy-safe telemetry", () => {
  assertClosedPrivacySafeConsolePayloads(
    "./inbound-reconciliation.ts",
    "[mail-reconciliation]",
  );
});

test("every static production mail event is recursively covered", () => {
  const workersRoot = fileURLToPath(new URL(".", import.meta.url));
  let callCount = 0;
  for (const path of productionTypescriptFiles(workersRoot)) {
    const source = projectSource(path);
    callCount += assertClosedPrivacySafeConsoleScope(source, source, path, {
      onlyStaticMail: true,
      requireCalls: false,
    });
  }
  assert.ok(callCount > 0);
});

test("the privacy guard rejects aliases, object values, and scope evasions", () => {
  const candidates = [
    `function example(rawId: string) {
      const ingressRef = rawId;
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `function example() {
      const error = new Error("poison");
      console.error("[mail-ingress] failed", { status: error });
    }`,
    `function makeError() { return new Error("poison"); }
    function example() {
      console.error("[mail-ingress] failed", { status: makeError() });
    }`,
    `function example(condition: boolean) {
      console.error(condition ? "[mail-ingress] failed" : "[mail-ingress] degraded", { status: "failed" });
    }`,
    `function example() {
      console.error("[mail-cleanup] failed", { status: "failed" });
    }`,
    `function example(error: Error) {
      console.error("[mail-ingress] failed", { status: error.message });
    }`,
    `function example(error: Error) {
      const status = error.message;
      console.error("[mail-ingress] failed", { status });
    }`,
    `function example(result: { secret: string }) {
      const status = result.secret;
      console.error("[mail-ingress] failed", { status });
    }`,
    `async function example(condition: boolean, rawId: string) {
      const ingressRef = condition
        ? await mailTelemetryLogRef("ingress", rawId)
        : rawId;
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `async function helper(value: unknown) { return value; }
    async function example(rawId: string) {
      const ingressRef = await helper(mailTelemetryLogRef("ingress", rawId));
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `async function projectionTelemetryRefs(rawId: string) {
      return { ingressRef: rawId, objectRef: rawId, queueRef: rawId };
    }
    async function example(rawId: string) {
      const { ingressRef } = await projectionTelemetryRefs(rawId);
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `function example(rawId: string) {
      console.error("[mail-ingress] failed", { status: "failed:" + rawId });
    }`,
    `function example(poison: { privatePayload: string }) {
      console.error("[mail-ingress] failed", { status: poison.privatePayload });
    }`,
    `function example() {
      const status = { privatePayload: "poison" };
      console.error("[mail-ingress] failed", { status });
    }`,
    `function example() {
      console.error("[mail-anything] failed", { status: "failed" });
    }`,
    `function example(privatePayload: string) {
      console.error("[mail-ingress] failed", { status: privatePayload.length });
    }`,
    `const STATUSES = ["safe", process.env.SECRET] as const;
    type Status = (typeof STATUSES)[number];
    function example(status: Status) {
      console.error("[mail-ingress] failed", { status });
    }`,
    `async function example(rawId: string) {
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      ingressRef = rawId;
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `function mailTelemetryLogRef(_kind: string, rawId: string) { return rawId; }
    async function example(rawId: string) {
      const ingressRef = await mailTelemetryLogRef("ingress", rawId);
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { rawIdentity as mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      const ingressRef = await mailTelemetryLogRef("ingress", rawId);
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./fake/mail-telemetry.ts";
    async function example(rawId: string) {
      const ingressRef = await mailTelemetryLogRef("ingress", rawId);
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `async function example(rawId: string) {
      const ingressRef = rawId;
      async function unused() {
        const ingressRef = await mailTelemetryLogRef("ingress", rawId);
        return ingressRef;
      }
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `async function example(rawId: string) {
      const ingressRef = rawId;
      {
        const ingressRef = await mailTelemetryLogRef("ingress", rawId);
        void ingressRef;
      }
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      (() => { ingressRef = rawId; })();
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      for (ingressRef of [rawId]) break;
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      function poison() { ingressRef = rawId; }
      poison();
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      function poison() { ingressRef = rawId; }
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      poison();
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
    async function example(rawId: string) {
      let ingressRef = await mailTelemetryLogRef("ingress", rawId);
      for ([ingressRef] of [[rawId]]) break;
      console.error("[mail-ingress] failed", { ingressRef, status: "failed" });
    }`,
    `function example(rawId: string) {
      let status = "failed";
      status = rawId;
      console.error("[mail-ingress] failed", { status });
    }`,
    `function example(result: { failed: { privatePayload: string } }) {
      console.error("[mail-ingress] failed", { failed: result.failed });
    }`,
    `function example(event: { rawSize: { privatePayload: string } }) {
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(input: { operation: { privatePayload: string } }) {
      console.error("[mail-ingress] failed", { operation: input.operation });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      event.rawSize = rawId;
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      event["rawSize"] = rawId;
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any, key: string) {
      event[key as "rawSize"] = rawId;
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      const alias = event;
      alias.rawSize = rawId;
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      Object.assign(event, { rawSize: rawId });
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      const patch = { rawSize: rawId };
      Object.assign(event, patch);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      Reflect.set(event, "rawSize", rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      Object.defineProperty(event, "rawSize", { value: rawId });
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(event: { rawSize: number }, rawId: any) {
      Reflect.defineProperty(event, "rawSize", { value: rawId });
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      poison(event, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const { value: alias } = { value: event };
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const [alias] = [event];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const alias = event as { rawSize: number };
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      let alias: typeof event;
      alias = event;
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = { value: event };
      poison(holder.value, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = { value: event };
      poison(holder["value"], rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = { value: event };
      const alias = holder.value;
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = [{ nested: event }];
      poison(holder[0].nested, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any, condition: boolean) {
      const alias = condition ? event : event;
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = { value: event };
      const key = "value" as const;
      poison(holder[key], rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: { value?: typeof event } = {};
      holder.value = event;
      poison(holder.value!, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: Array<typeof event> = [];
      holder[0] = event;
      poison(holder[0], rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = { ...{ value: event } };
      poison(holder.value, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: { value?: typeof event } = {};
      const holderAlias = holder;
      holderAlias.value = event;
      poison(holder.value!, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      let holder: { value: typeof event | null } = { value: null };
      holder = { value: event };
      poison(holder.value!, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: { value?: typeof event } = {};
      const patch = { value: event };
      Object.assign(holder, patch);
      poison(holder.value!, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = [event];
      const alias = holder.at(0)!;
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const alias = (() => event)();
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: { value?: typeof event } = {};
      holder.value ??= event;
      poison(holder.value, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder: { value?: typeof event } = {};
      Object.defineProperty(holder, "value", { value: event });
      poison(holder.value!, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const readEvent = () => event;
      const alias = readEvent();
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = [...[event]];
      poison(holder[0], rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const alias = [event].slice()[0];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, rawId: any) {
      const holder = [event].filter(Boolean);
      const alias = holder[0];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, other: typeof event, rawId: any) {
      const [, ...rest] = [other, event];
      poison(rest[0], rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, other: typeof event, rawId: any) {
      const alias = [other, event].filter((value) => value === event)[0];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, other: typeof event, rawId: any) {
      const alias = [other, event].slice(1)[0];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function poison(target: { rawSize: number }, rawId: any) {
      target.rawSize = rawId;
    }
    function example(event: { rawSize: number }, other: typeof event, rawId: any) {
      const alias = [other, event].reverse()[0];
      poison(alias, rawId);
      console.error("[mail-ingress] failed", { rawSize: event.rawSize });
    }`,
    `function example(input: { expectedSize: () => { privatePayload: string } }) {
      console.error("[mail-ingress] failed", { byteLength: input.expectedSize() });
    }`,
    `function example(runtime: { now: () => { getTime: () => { privatePayload: string } } }) {
      console.error("[mail-ingress] failed", { durationMs: runtime.now().getTime() });
    }`,
    `function safeErrorCode(value: unknown): string { return String(value); }
    function example(rawId: string) {
      console.error("[mail-ingress] failed", { errorCode: safeErrorCode(rawId) });
    }`,
    `function example(rawId: string) {
      console.error("[mail-ingress] failed", { rawSize: Number(rawId) });
    }`,
    `function example(rawId: string) {
      console.error("[mail-ingress] failed", { rawSize: Math.floor(Number(rawId)) });
    }`,
  ];
  for (const [index, text] of candidates.entries()) {
    const source = parseCheckedFixture(text, `adversarial-${index}.ts`);
    assert.throws(
      () =>
        assertClosedPrivacySafeConsoleScope(
          source,
          source,
          `adversarial-${index}.ts`,
          { expectedPrefix: "[mail-ingress]" },
        ),
      undefined,
      `privacy adversarial candidate ${index} is rejected`,
    );
  }
});

test("the recursive production guard rejects dynamic and indirect console evasion", () => {
  const candidates = [
    `function example(message: string) {
      console.error(message, { status: "failed" });
    }`,
    `function example(rawId: string) {
      console["error"]("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      const logger = console;
      logger.error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      const { error } = console;
      error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      console.error.apply(console, ["[mail-ingress] failed", { status: rawId }]);
    }`,
    `function example(rawId: string) {
      console.error.bind(console)("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string, condition: boolean, other: Console) {
      const logger = condition ? console : other;
      logger.error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      const error = console.error.bind(console);
      error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      const first = console;
      const second = first;
      second.error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      const first = console.error;
      const second = first;
      second("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      Reflect.apply(console.error, console, ["[mail-ingress] failed", { status: rawId }]);
    }`,
    `function invoke(callback: (...values: unknown[]) => void) { callback(); }
    function example() {
      invoke(console.error);
    }`,
    `function example(rawId: string) {
      globalThis["console"]["error"]("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      (globalThis as any)["con" + "sole"].error("[mail-ingress] failed", { status: rawId });
    }`,
    `function example(rawId: string) {
      (self as any)["con" + "sole"]["error"]("[mail-ingress] failed", { status: rawId });
    }`,
  ];
  for (const [index, text] of candidates.entries()) {
    const source = parseCheckedFixture(
      text,
      `dynamic-production-console-${index}.ts`,
    );
    assert.throws(
      () =>
        assertClosedPrivacySafeConsoleScope(
          source,
          source,
          `dynamic-production-console-${index}.ts`,
          { onlyStaticMail: true, requireCalls: false },
        ),
      undefined,
      `indirect console candidate ${index} is rejected`,
    );
  }
});
