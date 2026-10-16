import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Deliberately bounded to the consumers moved in #183. This is not a
// repository-wide architecture rule or a replacement for the runtime App load.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumers = [
  "src/core/bridge/luckyRayBridge.ts",
  "src/core/services/knowledgeStore.ts",
  "src/core/services/graph.ts",
  "src/core/services/favorites.ts",
  "src/luckyrayBridge.ts",
  "src/features/notes/documentSource.ts",
  "src/features/notes/NotesPage.tsx",
  "src/features/notes/knownVaults.ts",
  "src/features/search/searchCore.ts",
];
const uiTypeOwners = new Set(["src/App", "src/features/notes/documentSource"]);

function targetFor(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  const absolute = path.resolve(root, path.dirname(file), specifier);
  return path.relative(root, absolute).replaceAll("\\", "/").replace(/\.(?:tsx?|jsx?)$/, "");
}

function violations(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    let specifier = null;
    let staticEdge = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text : null;
      staticEdge = true;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifier = node.argument.literal.text;
      staticEdge = true;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifier = node.arguments[0].text;
      // One existing runtime assembly edge is explicitly out of this type move.
      staticEdge = !(file === "src/luckyrayBridge.ts" && specifier === "./App");
    }
    if (staticEdge && specifier) {
      const target = targetFor(file, specifier);
      const forbidden = target === "src/App"
        || (file.startsWith("src/core/") && target === "src/features/notes/documentSource");
      if (uiTypeOwners.has(target) && forbidden && !(file === target)) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        found.push(`${file}:${line}: shared type import must not depend on ${target}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

if (process.argv.includes("--self-test")) {
  const appEdge = violations("src/core/bridge/luckyRayBridge.ts",
    'import type { LuckyRayBridge } from "../../App";');
  const uiEdge = violations("src/core/services/knowledgeStore.ts",
    'import type { KnowledgeTreeNode } from "../../features/notes/documentSource";');
  const runtimeException = violations("src/luckyrayBridge.ts",
    'const mod = await import("./App");');
  if (appEdge.length !== 1 || uiEdge.length !== 1 || runtimeException.length !== 0) {
    throw new Error("boundary negative control failed");
  }
  console.log("boundary negative control: two reintroduced type edges rejected; runtime App edge retained");
}

const failures = consumers.flatMap(file =>
  violations(file, fs.readFileSync(path.join(root, file), "utf8")));
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`domain type boundary: ${consumers.length} scoped consumers pass`);
}
