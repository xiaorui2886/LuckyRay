import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { performMaterialExternalActionWithTransport } from "../src/core/services/materials.ts";
import { resolveMaterialPathAction } from "../src/features/materials/materialMissingRecovery.ts";

const source = ts.createSourceFile("MaterialsPage.tsx", readFileSync(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT
  ? resolve(process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT, "src/features/materials/MaterialsPage.tsx")
  : new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function expression(name: string) {
  let result = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      result = (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(result, `production ${name} exists`);
  return result;
}
function prop(component: string, name: string) {
  let result = "";
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === component) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText(source) === name && attr.initializer && ts.isJsxExpression(attr.initializer)) {
          result = attr.initializer.expression?.getText(source) || "";
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(result, `production ${component}.${name} exists`);
  return result;
}

test("inspector open, explorer and viewer double-click share native material ID actions and wait for success", async () => {
  const asset = { id: "asset-current", libraryPath: "C:/logical/old.png", originalPath: "C:/unrelated/original.png" };
  const calls: unknown[] = [];
  const statuses: string[] = [];
  const alerts: unknown[] = [];
  let finish: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  let failure: Error | undefined;
  const transport = async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (pending) await pending;
    if (failure) throw failure;
  };
  class Element { closest() { return null; } }
  const context = vm.createContext({
    asset, assetPath: asset.libraryPath, missingList: [], Element, vaultId: undefined,
    libraryId: null, attachmentCollection: false, attachmentVaultId: undefined,
    materialLibrarySession: { getSnapshot: () => ({ libraryId: null }) },
    resolveMaterialPathAction,
    performMaterialExternalAction: (id: string, action: "open" | "reveal") => performMaterialExternalActionWithTransport(id, action, transport),
    scanMissingMaterialAssets: async () => [],
    setMissingOpen() {}, setMissingList() {}, setMissingScanError() {},
    setAlertDialog: (value: unknown) => alerts.push(value),
    setToast() {}, setStatus: (value: string) => statuses.push(value), t: (key: string) => key,
  });
  const code = [
    `const performMaterialPathAction = ${expression("performMaterialPathAction")};`,
    `const handleOpenAsset = ${expression("handleOpenAsset")};`,
    `const onReveal = ${prop("MaterialsDetailPanel", "onReveal")};`,
    `const onOpenOriginal = ${prop("MaterialViewer", "onOpenOriginal")};`,
    `globalThis.actions = { open: ${prop("MaterialsDetailPanel", "onOpen")}, reveal: ${expression("openInExplorer")}, doubleClick: ${expression("handleMediaDoubleClick")} };`,
  ].join("\n");
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  await context.actions.open(asset);
  context.actions.doubleClick({ target: new Element() });
  await new Promise(setImmediate);
  pending = new Promise<void>((resolve) => { finish = resolve; });
  const reveal = context.actions.reveal();
  assert.deepEqual(statuses, [""], "do not report revealed before native resolution and launch complete");
  finish!();
  await reveal;
  assert.equal(statuses.at(-1), "materials.detail.status.revealed");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["material_catalog_shell_action", { request: { assetId: asset.id, action: "open" } }],
    ["material_catalog_shell_action", { request: { assetId: asset.id, action: "open" } }],
    ["material_catalog_shell_action", { request: { assetId: asset.id, action: "reveal" } }],
  ]);
  pending = undefined;
  failure = new Error("native file resolution failed");
  statuses.length = 0;
  await context.actions.reveal();
  assert.deepEqual(statuses, ["", "materials.detail.status.revealFailed"]);
  assert.equal(alerts.length, 1);
});
