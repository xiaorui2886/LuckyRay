import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { attachmentResolutionMatches } from "../src/core/services/vaultAttachmentResolution.ts";
import { normalizeVaultRelativePath } from "../src/core/markdown/wikiTargets.ts";
import { resolveAssetEmbed } from "../src/features/notes/editor/noteAssetResolver.ts";

const source = ts.createSourceFile("NotesPage.tsx", readFileSync(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionFunction(name: string, callback = false) {
  let result = "";
  const visit = (node: ts.Node) => {
    if (!callback && ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source);
    if (callback && ts.isVariableDeclaration(node) && node.name.getText(source) === name
      && node.initializer && ts.isCallExpression(node.initializer)) result = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(result, `production ${name} must remain available to this behavior test`);
  return result;
}

test("native attachment presentation preserves real material identity, version freshness, merge priority and open actions", async () => {
  const knownPath = "C:/Users/fixture/AppData/Roaming/luckyray/asset-library/known.png";
  const nativePath = "\\\\?\\C:\\Users\\fixture\\AppData\\Local\\Packages\\fixture\\LocalCache\\Roaming\\luckyray\\asset-library\\known.png";
  const assets = [
    { id: "material-known", name: "Catalog image", kind: "image", storageMode: "managed", libraryPath: knownPath, previewUrl: "fixture://stale", thumbnailUrl: "fixture://old-poster", description: "Keep catalog metadata" },
    { id: "collision-a", name: "Duplicate A", kind: "image", libraryPath: "C:/library/shared.png" },
    { id: "collision-b", name: "Duplicate B", kind: "image", libraryPath: "C:/library/shared.png" },
  ];
  const nativeMatch = (absolutePath: string, version = "file:1~watch:session:2", materialAssetId: string | null = null) => attachmentResolutionMatches({ status: "resolved", candidates: [], absolutePath, relativePath: null, fragment: "", version, materialAssetId })[0];
  const raw = ["known", "local", "catalog-ambiguous", "native-ambiguous", "pending", "missing", "unregistered-catalog-path", "unknown-catalog-id"].map((key) => ({
    wikiSyntax: false, sourceTarget: `file:///C:/reference/${key}.png`, target: `${key}.png`, display: key,
    assetLookupKey: key, assetRelativePath: null, absolutePath: null, targetNoteId: null, libraryAssetId: null, assetExists: null,
  }));
  const focusCalls: unknown[][] = [];
  const openedPaths: string[] = [];
  const context = vm.createContext({
    realVaultAssetMatches: {
      known: [nativeMatch(nativePath, "file:1~watch:session:2", "material-known")],
      local: [nativeMatch("C:/vault/attachments/known.png")],
      "catalog-ambiguous": [nativeMatch("C:/library/shared.png")],
      "native-ambiguous": ["C:/vault/first.png", "C:/vault/second.png"].map((path) => ({ ...nativeMatch(path), matchKind: "ambiguous" })),
      missing: [],
      "unregistered-catalog-path": [nativeMatch(knownPath)],
      "unknown-catalog-id": [nativeMatch(nativePath, "file:1", "deleted-material")],
    },
    currentVault: { id: "vault-exact" },
    materialAssetsById: new Map(assets.map((asset) => [asset.id, asset])),
    previewAssets: assets,
    realVaultResolvedAssets: [],
    knowledgeStorageMode: "real-vault",
    visibleVaultEmbedInputs: [{ noteId: "note", items: raw }],
    normalizeVaultRelativePath,
    convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
    REAL_VAULT_MARKDOWN_EMBED_PREFIX: "real-vault-markdown:",
    REAL_VAULT_ASSET_PREFIX: "real-vault-asset:",
    t: (key: string) => key,
    realVaultRelativePathFromNoteId: (id: string) => id,
    focusEntity: (...args: unknown[]) => focusCalls.push(args),
    window: { location: { hash: "#notes" } },
    realVaultAssetOpenPathRef: { current: new Map<string, string>() },
    bridge: { async openFilePath(path: string) { openedPaths.push(path); return true; } },
    setStatus() {},
  });
  const executable = [
    ...["mergeAssetsById", "realVaultAssetFileName", "realVaultAssetKind", "realVaultAssetPreviewUrl"].map((name) => productionFunction(name)),
    `const resolveVaultPresentation = ${productionFunction("resolveVaultPresentation", true)};`,
    `globalThis.fixture = { resolveVaultPresentation, activeAssets: ${productionFunction("activePreviewAssets", true)}, pane: ${productionFunction("getPaneMedia", true)}, open: ${productionFunction("openAssetFromPreview", true)}, locate: ${productionFunction("locateAssetInLibrary", true)} };`,
  ].join("\n");
  vm.runInContext(ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  const presentation = context.fixture.resolveVaultPresentation(raw);
  context.realVaultResolvedAssets = presentation.assets;
  const known = presentation.assets.find((asset: { id: string }) => asset.id === "material-known");
  assert.ok(known);
  assert.equal(known.description, assets[0].description);
  assert.equal(known.name, assets[0].name);
  assert.equal(known.libraryPath, nativePath);
  assert.notEqual(known.libraryPath, assets[0].libraryPath, "native physical identity must not be guessed from the catalog's logical path");
  assert.equal(new URL(known.previewUrl).searchParams.get("v"), "file:1~watch:session:2");
  assert.equal(new URL(known.previewUrl).searchParams.get("vault"), "vault-exact");
  assert.equal(presentation.embeds[0].assetId, "material-known");
  assert.equal(presentation.embeds[1].assetId, "real-vault-asset:C:/vault/attachments/known.png");
  assert.equal(presentation.embeds[2].assetId, "real-vault-asset:C:/library/shared.png");
  assert.equal(presentation.embeds[3].assetId, null);
  assert.equal(presentation.embeds[3].isMissing, 1);
  assert.equal(presentation.embeds[3].resolutionStatus, "ambiguous");
  assert.equal(presentation.embeds[4].assetId, null);
  assert.equal(presentation.embeds[4].resolutionStatus, "pending");
  assert.equal(presentation.embeds[5].assetId, null);
  assert.equal(presentation.embeds[5].resolutionStatus, "missing");
  assert.equal(presentation.embeds[6].assetId, `real-vault-asset:${knownPath}`, "a matching catalog string must not override native refusal to bind");
  assert.equal(presentation.embeds[7].assetId, `real-vault-asset:${nativePath}`, "an identity absent from the catalog remains a local attachment");
  for (const merged of [context.fixture.activeAssets(), context.fixture.pane("note").assets]) {
    assert.equal(merged.filter((asset: { id: string }) => asset.id === "material-known").length, 1);
    assert.equal(resolveAssetEmbed(raw[0].sourceTarget, presentation.embeds, merged, "markdown").asset?.previewUrl, known.previewUrl);
  }
  context.realVaultAssetMatches.known = [nativeMatch(nativePath, "file:1~watch:session:3", "material-known")];
  const refreshed = context.fixture.resolveVaultPresentation(raw);
  context.realVaultResolvedAssets = refreshed.assets;
  assert.equal(new URL(context.fixture.activeAssets().find((asset: { id: string }) => asset.id === "material-known").previewUrl).searchParams.get("v"), "file:1~watch:session:3");
  assert.equal(assets[0].previewUrl, "fixture://stale", "presentation must not mutate the catalog");
  context.fixture.open("material-known");
  assert.equal(focusCalls[0][1], "material-known");
  assert.equal((focusCalls[0][2] as { action: string }).action, "detail");
  assert.equal(context.window.location.hash, "#materials");
  context.fixture.locate("material-known");
  assert.equal((focusCalls[1][2] as { action: string }).action, "focus-only");
  const localId = presentation.embeds[1].assetId;
  context.realVaultAssetOpenPathRef.current.set(localId, "C:/vault/attachments/known.png");
  context.fixture.open(localId);
  await Promise.resolve();
  assert.deepEqual(openedPaths, ["C:/vault/attachments/known.png"]);
  assert.equal(focusCalls.length, 2, "a local Vault attachment must not navigate to an unrelated material");
});
