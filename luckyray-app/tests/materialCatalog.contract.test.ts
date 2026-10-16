import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { materialLibrarySession } from "../src/core/services/materialLibraryContext.ts";
import { dragEdgeVelocity } from "../src/features/folders/dragEdgeScroll.ts";
import { createMaterialDragGesture } from "../src/features/materials/materialDragGesture.ts";

import {
  resolveVideoThumbnailBackfillInput,
  toLegacyMaterialBridgeFilter,
  type MaterialAssetFilter,
} from "../src/core/services/materialCatalog.ts";
import {
  hasEnabledMaterialWatchSources,
  runMaterialWatchScan,
  startMaterialWatchService,
  stopMaterialWatchService,
  type MaterialWatchSource,
} from "../src/features/materials/materialWatch.ts";
import {
  beginMaterialExternalDragWithTransport,
  consumeMaterialAppearanceDrag,
  clearActiveMaterialExternalDrag,
  markActiveMaterialExternalDragFinished,
  moveActiveMaterialExternalDragToFolderWithAdapter,
  peekActiveMaterialExternalDrag,
  resolveMaterialLightSeekResourcesWithTransport,
  resolveMaterialExternalDragSelection,
  setActiveMaterialExternalDrag,
} from "../src/core/services/materials.ts";

test("LightSeek material path resolution sends only ordered asset ids and returns canonical paths", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const paths = [
    "C:\\素材 空间\\第二张 #2.png",
    "D:\\图像\\第一张 (完成)`版`.jpg",
  ];
  const resources = await resolveMaterialLightSeekResourcesWithTransport(
    ["asset-two", "asset-one"],
    async (command, args) => {
      calls.push({ command, args });
      return paths;
    },
  );
  assert.deepEqual(calls, [{
    command: "material_catalog_resolve_lightseek_paths",
    args: { assetIds: ["asset-two", "asset-one"] },
  }]);
  assert.deepEqual(resources, [
    { kind: "material", assetId: "asset-two", canonicalPath: paths[0], delivery: "path-reference" },
    { kind: "material", assetId: "asset-one", canonicalPath: paths[1], delivery: "path-reference" },
  ]);
  assert.equal(JSON.stringify(calls).includes("canonicalPath"), false, "the UI sends ids, never caller paths");

  await assert.rejects(
    () => resolveMaterialLightSeekResourcesWithTransport(
      ["asset-missing"],
      async () => [],
    ),
    /素材原文件已移动或不存在/u,
  );
  await assert.rejects(
    () => resolveMaterialLightSeekResourcesWithTransport(
      ["asset-moved"],
      async () => {
        throw new Error('luckyray-material-error:{"code":"lightseek-material-unavailable","message":"素材原文件已移动或不存在，请在素材库重新定位后重试"}');
      },
    ),
    (error: unknown) => error instanceof Error
      && error.message === "素材原文件已移动或不存在，请在素材库重新定位后重试",
  );

  const sixtyFourIds = Array.from({ length: 64 }, (_, index) => `asset-${index}`);
  const sixtyFour = await resolveMaterialLightSeekResourcesWithTransport(
    sixtyFourIds,
    async () => sixtyFourIds.map((_, index) => `D:\\素材\\第 ${index + 1} 张.png`),
  );
  assert.equal(sixtyFour.length, 64);
  assert.deepEqual(sixtyFour.map((resource) => resource.assetId), sixtyFourIds);
  await assert.rejects(
    () => resolveMaterialLightSeekResourcesWithTransport([...sixtyFourIds, "asset-64"], async () => []),
    /一次最多发送 64 个素材/u,
  );
});

test("external material drag sends only bounded asset ids to the native command", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  await beginMaterialExternalDragWithTransport(
    ["asset-a", "asset-a", "asset-b"],
    async (command, args) => {
      calls.push({ command, args });
    },
  );
  assert.deepEqual(calls, [{
    command: "material_catalog_begin_external_drag",
    args: { assetIds: ["asset-a", "asset-b"] },
  }]);
  assert.equal(JSON.stringify(calls).includes("Path"), false);

  await assert.rejects(
    () => beginMaterialExternalDragWithTransport([], async () => undefined),
    /请选择要拖出的素材/,
  );
});

test("dragging a selected material carries the selection while an unselected card starts alone", () => {
  assert.deepEqual(
    resolveMaterialExternalDragSelection("asset-two", ["asset-one", "asset-two", "asset-three"]),
    ["asset-one", "asset-two", "asset-three"],
  );
  assert.deepEqual(
    resolveMaterialExternalDragSelection("asset-four", ["asset-one", "asset-two"]),
    ["asset-four"],
  );
});

test("one native material drag session moves selected ids once and never becomes a new import", async () => {
  clearActiveMaterialExternalDrag();
  setActiveMaterialExternalDrag(["asset-one", "asset-two"], 1_000);
  assert.deepEqual(peekActiveMaterialExternalDrag(1_100), ["asset-one", "asset-two"]);

  const calls: unknown[] = [];
  const result = await moveActiveMaterialExternalDragToFolderWithAdapter(
    "folder-target",
    async (assetIds, folderId) => {
      calls.push({ assetIds, folderId });
      return assetIds.map(() => ({ status: "fulfilled", value: undefined } as const));
    },
    1_200,
  );
  assert.deepEqual(result, { moved: 2, total: 2 });
  assert.deepEqual(calls, [{ assetIds: ["asset-one", "asset-two"], folderId: "folder-target" }]);
  assert.equal(peekActiveMaterialExternalDrag(1_201), null);
  assert.equal(await moveActiveMaterialExternalDragToFolderWithAdapter(null, async () => [], 1_202), null);
});

test("native drag completion keeps a short drop-delivery grace then expires", () => {
  clearActiveMaterialExternalDrag();
  setActiveMaterialExternalDrag(["asset-one"], 5_000);
  markActiveMaterialExternalDragFinished(6_000);
  assert.deepEqual(peekActiveMaterialExternalDrag(7_499), ["asset-one"]);
  assert.equal(peekActiveMaterialExternalDrag(8_001), null);
});

test("cross-library drag remains internal but cannot write into the new library", async () => {
  const original = materialLibrarySession.isCurrent;
  setActiveMaterialExternalDrag(["old-library-image"], 1000);
  let calls = 0;
  try {
    materialLibrarySession.isCurrent = () => false;
    assert.deepEqual(peekActiveMaterialExternalDrag(1100), ["old-library-image"], "do not reinterpret stale ids as external files");
    await assert.rejects(moveActiveMaterialExternalDragToFolderWithAdapter("new-folder", async () => { calls++; return []; }, 1200), /素材库已切换/);
    assert.equal(calls, 0);
  } finally { materialLibrarySession.isCurrent = original; clearActiveMaterialExternalDrag(); }
});

test("image query consumes internal drag once and refuses stale library identity", () => {
  const original = materialLibrarySession.isCurrent;
  try {
    materialLibrarySession.isCurrent = () => true;
    setActiveMaterialExternalDrag(["image"], 1000);
    assert.deepEqual(consumeMaterialAppearanceDrag(1100), ["image"]);
    assert.equal(consumeMaterialAppearanceDrag(1101), null);
    setActiveMaterialExternalDrag(["old-image"], 1200);
    materialLibrarySession.isCurrent = () => false;
    assert.throws(() => consumeMaterialAppearanceDrag(1300), /素材库已切换/);
    assert.equal(peekActiveMaterialExternalDrag(1301), null);
  } finally { materialLibrarySession.isCurrent = original; clearActiveMaterialExternalDrag(); }
});

test("cancelled drag never moves and rejected move results never count as successful", async () => {
  setActiveMaterialExternalDrag(["one", "two"], 1000);
  const result = await moveActiveMaterialExternalDragToFolderWithAdapter("nested-folder", async () => [
    { status: "fulfilled", value: undefined }, { status: "rejected", reason: new Error("unavailable") },
  ], 1100);
  assert.deepEqual(result, { moved: 1, total: 2 });
  setActiveMaterialExternalDrag(["one"], 1200);
  clearActiveMaterialExternalDrag();
  assert.equal(await moveActiveMaterialExternalDragToFolderWithAdapter(null, async () => { assert.fail("cancel must not write"); }, 1300), null);
});

test("drag edge scrolling is bounded to the visible container and stops outside or in its middle", () => {
  assert.equal(dragEdgeVelocity(99, 100, 500), 0);
  assert.equal(dragEdgeVelocity(501, 100, 500), 0);
  assert.equal(dragEdgeVelocity(300, 100, 500), 0);
  assert.equal(dragEdgeVelocity(100, 100, 500), -10);
  assert.equal(dragEdgeVelocity(500, 100, 500), 10);
  assert.equal(dragEdgeVelocity(118, 100, 500), -5);
});

test("material cards own native drag while the material folder tree accepts the drop", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8");
  const tree = await readFile(new URL("../src/features/folders/FolderTree.tsx", import.meta.url), "utf8");
  assert.match(tree, /getCurrentWebview\(\)\.onDragDropEvent/);
  assert.doesNotMatch(tree, /getCurrentWindow\(\)\.onDragDropEvent/);
  assert.match(page, /data-native-material-drag-source="true"/);
  assert.match(page, /useAssetDragGesture\(asset, onExternalDrag, onPointerDown\)/);
  assert.doesNotMatch(page, /ExternalDragButton|拖到其他软件即可导入/);
  assert.match(page, /const activeMaterialDrag = peekActiveMaterialExternalDrag\(\)/);
  assert.match(page, /consumeActiveMaterialExternalDrag\(\)/);
  assert.match(sidebar, /onExternalDrop=\{scope === "materials" \? handleExternalMaterialDrop : undefined\}/);
  assert.match(sidebar, /moveActiveMaterialExternalDragToFolder\(folderId\)/);
  assert.match(sidebar, /luckyray:materials-native-folder-import/);
});

test("native drag starts once from pointer threshold without relying on HTML dragstart", () => {
  const target = new EventTarget(); let started = 0;
  const gesture = createMaterialDragGesture(target, () => started++);
  const move = (x: number, buttons = 1) => target.dispatchEvent(Object.assign(new Event("pointermove", { cancelable: true }), { pointerId: 3, clientX: x, clientY: 10, buttons }));
  gesture.arm({ button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  move(14); assert.equal(started, 0);
  move(18); move(30); assert.equal(started, 1);
  gesture.arm({ button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  target.dispatchEvent(new Event("pointercancel")); move(30); assert.equal(started, 1);
  gesture.arm({ button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  move(30, 0); assert.equal(started, 1);
  gesture.arm({ button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  gesture.clear(); move(30); assert.equal(started, 1);
});

test("material file drops stay functional without rendering a full-page drop prompt", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/features/materials/materials.css", import.meta.url), "utf8");
  assert.match(page, /onDragDropEvent/);
  assert.match(page, /handleDroppedPaths\(payload\.paths \|\| \[\]\)/);
  assert.doesNotMatch(page, /<DropOverlay|function DropOverlay|松开后导入文件/);
  assert.doesNotMatch(styles, /\.file-drop-overlay-react|\.drop-hint-inner|\.drop-hint-sub/);
});

test("material imports merge into the catalog without navigating the current viewport", async () => {
  const page = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const start = page.indexOf("const mergeImportedAssets");
  const end = page.indexOf("useEffect(() => {", start);
  const merge = page.slice(start, end);

  assert.ok(start >= 0 && end > start, "missing viewport-preserving import merge authority");
  assert.match(merge, /materialStore\.optimistic/u);
  assert.doesNotMatch(merge, /requestAssetFocus|scrollTo|scrollIntoView/u);
  assert.doesNotMatch(merge, /setFilter|setSelectedFolderId/u);
  assert.doesNotMatch(page, /source:\s*"materials-import"/u);
});

test("canonical filter has one explicit legacy bridge adapter", () => {
  const canonical: MaterialAssetFilter = {
    kinds: ["image"],
    tagIds: ["tag-a", "tag-b"],
    folderId: "folder-a",
    recentOnly: true,
    dateFrom: "2026-07-01T00:00:00Z",
    dateTo: "2026-08-01T00:00:00Z",
    ratingMin: 3,
    dominantColor: "#abcdef",
    limit: 50,
  };
  assert.deepEqual(toLegacyMaterialBridgeFilter(canonical), {
    kinds: ["image"],
    tag_ids: ["tag-a", "tag-b"],
    folder_id: "folder-a",
    recent_only: true,
    date_from: "2026-07-01T00:00:00Z",
    date_to: "2026-08-01T00:00:00Z",
    rating_min: 3,
    dominant_color: "#abcdef",
    limit: 50,
  });
});

test("catalog video preview URLs cannot masquerade as persisted image thumbnails", () => {
  const localVideo = "C:\\LuckyRay\\materials\\browser-video.mp4";
  assert.deepEqual(resolveVideoThumbnailBackfillInput({
    kind: "video",
    thumbnailUrl: "",
    libraryPath: localVideo,
    originalPath: localVideo,
  }), { kind: "video-file", value: localVideo });

  assert.deepEqual(resolveVideoThumbnailBackfillInput({
    kind: "video",
    thumbnailUrl: "http://asset.localhost/C:/LuckyRay/materials/browser-video.mp4",
    libraryPath: localVideo,
    originalPath: localVideo,
  }), { kind: "video-file", value: localVideo });

  assert.equal(resolveVideoThumbnailBackfillInput({
    kind: "video",
    thumbnailUrl: "C:\\LuckyRay\\thumbnails\\video\\asset-a.jpg",
    libraryPath: localVideo,
    originalPath: localVideo,
  }), null);
});

test("production material bridge routes migrated capabilities to Rust Catalog", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  for (const command of [
    "material_catalog_list_assets",
    "material_catalog_search_assets",
    "material_catalog_import_paths",
    "material_catalog_import_bytes",
    "material_catalog_import_folder",
    "material_catalog_update_asset",
    "material_catalog_delete_asset",
    "material_catalog_list_folders",
    "material_catalog_list_tags",
    "material_catalog_set_asset_tags",
    "material_catalog_scan_missing",
    "material_catalog_remove_asset_record",
  ]) {
    assert.ok(app.includes(`"${command}"`), `missing production Catalog command: ${command}`);
  }
});

test("materials service owns canonical types instead of inferring them from LuckyRayBridge", async () => {
  const service = await readFile(new URL("../src/core/services/materials.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /Awaited<ReturnType<LuckyRayBridge\["listAssets"\]>>/);
  assert.match(service, /from "\.\/materialCatalog"/);
  assert.match(service, /function requireBridge\([^\n]*\): MaterialCatalogAdapter/);
  assert.match(service, /listMaterialFolders/);
  assert.match(service, /getMaterialCatalogChange/);
  assert.doesNotMatch(service, /library_path|file_still_exists|imported_count|failed_items/);

  const store = await readFile(new URL("../src/core/services/materialStore.ts", import.meta.url), "utf8");
  assert.doesNotMatch(store, /getLuckyRayBridgeSync/);
  assert.match(store, /listMaterialFolders/);
  assert.match(store, /getMaterialCatalogChange/);
});

test("canonical import and missing-asset results stay camelCase through consumers", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const watch = await readFile(new URL("../src/features/materials/materialWatch.ts", import.meta.url), "utf8");
  const types = await readFile(new URL("../src/core/bridge/bridgeTypes.ts", import.meta.url), "utf8");
  assert.match(app, /BridgeImportFolderResult/);
  assert.match(types, /type BridgeImportFolderResult = \{\s*importedCount:/);
  assert.match(types, /type BridgeMissingAsset = \{[\s\S]*libraryPath:/);
  assert.doesNotMatch(watch, /imported_count|skipped_duplicate_count|failed_count|failed_items/);
});

test("automatic import sleeps while disabled or empty and coalesces overlapping scans", async () => {
  const source: MaterialWatchSource = {
    id: "watch-fixture",
    path: "D:\\codex\\automatic-import-fixture",
    enabled: true,
    recursive: true,
    storageMode: "linked",
    preserveFolderStructure: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  assert.equal(hasEnabledMaterialWatchSources({ "general.watchFolder": false }, [source]), false);
  assert.equal(hasEnabledMaterialWatchSources({ "general.watchFolder": true }, []), false);
  assert.equal(hasEnabledMaterialWatchSources({ "general.watchFolder": true }, [source]), true);

  const storage = new Map<string, string>([
    ["luckyray-settings-v1", JSON.stringify({ "general.watchFolder": false })],
    ["luckyray-material-watch-sources-v1", JSON.stringify([source])],
  ]);
  let scheduled = 0;
  const eventTarget = new EventTarget();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    CustomEvent: class<T> extends Event {
      detail: T;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail as T;
      }
    },
    window: Object.assign(eventTarget, {
      setTimeout: () => { scheduled += 1; return scheduled; },
      clearTimeout: () => {},
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    }),
  });

  const bridge = { importFolder: async () => ({ importedCount: 0 }) } as never;
  startMaterialWatchService(bridge);
  assert.equal(scheduled, 0, "disabled automatic import must not keep a polling timer alive");
  stopMaterialWatchService();

  storage.set("luckyray-settings-v1", JSON.stringify({ "general.watchFolder": true }));
  let releaseImport!: (value: {
    importedCount: number;
    skippedDuplicateCount: number;
    failedCount: number;
    failedItems: [];
  }) => void;
  let importCalls = 0;
  const deferredBridge = {
    importFolder: async () => {
      importCalls += 1;
      return new Promise((resolve) => { releaseImport = resolve; });
    },
  } as never;
  const first = runMaterialWatchScan(deferredBridge);
  const second = runMaterialWatchScan(deferredBridge);
  releaseImport({ importedCount: 1, skippedDuplicateCount: 0, failedCount: 0, failedItems: [] });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(importCalls, 1, "overlapping triggers must share one import scan");
  assert.deepEqual(secondResult, firstResult, "coalesced callers must receive the real scan result, not an empty summary");
});

test("retired desktop import implementations cannot bypass Catalog", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const legacy of ["save_dropped_asset_file", "copy_asset_file_to_library", "list_assets_filtered"]) {
    assert.ok(!app.includes(legacy), `App still references retired implementation: ${legacy}`);
    assert.ok(!rust.includes(legacy), `Rust still exposes retired implementation: ${legacy}`);
  }
  assert.ok(!app.includes("ensureMaterialChangeSchema"), "WebView still owns duplicate material change schema");
  assert.match(rust, /import_downloaded_material/);
});


test("note attachment search retains the query alongside tag filters for native scoped filtering", () => {
  const translated=toLegacyMaterialBridgeFilter({scope:"note-attachments",vaultId:"v",query:"图 % name",tagIds:["tag"]});
  assert.equal(translated.query,"图 % name");
  assert.deepEqual(translated.tag_ids,["tag"]);
});
