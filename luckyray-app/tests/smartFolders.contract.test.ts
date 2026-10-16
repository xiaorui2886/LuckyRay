import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BUILT_IN_SMART_FOLDERS,
  canRetainSmartFolderStale,
  createLatestSmartFolderResultLoader,
  filterCanvasSmartFolder,
  filterMaterialSmartFolder,
  filterNoteSmartFolder,
  reconcileSmartFolderDetailSort,
  smartFolderLocalDateInput,
  smartFolderLocalDateIso,
} from "../src/features/smartFolders/smartFolderModel.ts";
import type {
  CanvasSmartFolderCriteria,
  MaterialSmartFolderCriteria,
  NoteSmartFolderCriteria,
} from "../src/core/services/smartFolders.ts";
import { readSmartFolderDraft } from "../src/core/services/smartFolders.ts";

test("typed criteria keep each smart folder on one source with AND and any-tag semantics", () => {
  const materialCriteria: MaterialSmartFolderCriteria = {
    source: "material",
    query: "海边",
    kinds: ["image"],
    tagIds: ["tag-blue", "tag-trip"],
    favorite: true,
    added: { after: "2026-08-01T00:00:00.000Z", before: null },
    modified: { after: null, before: null },
  };
  const materials = [
    { id: "a", name: "海边日落", description: "", kind: "image", importedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" },
    { id: "b", name: "海边视频", description: "", kind: "video", importedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" },
    { id: "c", name: "海边清晨", description: "", kind: "image", importedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" },
  ] as never;
  const result = filterMaterialSmartFolder(materialCriteria, "added-desc", materials, {
    tagMap: { a: ["tag-blue"], b: ["tag-trip"], c: ["tag-other"] },
    favoriteIds: new Set(["a", "b", "c"]),
  });
  assert.deepEqual(result.map((item) => item.id), ["a"]);

  const noteCriteria: NoteSmartFolderCriteria = {
    source: "note",
    query: "计划",
    tagIds: [],
    favorite: null,
    modified: { after: null, before: null },
  };
  const notes = [{
    documentRef: { vaultId: "vault", relativePath: "计划.md" },
    relativePath: "计划.md",
    fileName: "计划.md",
    title: "旅行计划",
    revision: "1",
    headings: [], wikiLinks: [], embeds: [], tags: ["旅行"], frontmatterTags: [], inlineTags: [],
    plainText: "路线", excerpt: "路线", contentLength: 2, modifiedAt: "2026-08-20T00:00:00.000Z", size: 2,
  }] as never;
  assert.equal(filterNoteSmartFolder(noteCriteria, "modified-desc", "vault", notes, { favoriteIds: new Set() }).length, 1);

  const canvasCriteria: CanvasSmartFolderCriteria = {
    source: "canvas",
    query: "分镜",
    favorite: false,
    modified: { after: null, before: null },
  };
  assert.deepEqual(filterCanvasSmartFolder(canvasCriteria, "name-asc", [
    { id: "canvas-a", name: "分镜 A", updatedAt: "2026-08-20T00:00:00.000Z" },
    { id: "canvas-b", name: "分镜 B", updatedAt: "2026-08-21T00:00:00.000Z" },
  ] as never, { favoriteIds: new Set(["canvas-b"]) }).map((item) => item.id), ["canvas-a"]);
});

test("built-ins are code-owned and cover the five promised views", () => {
  assert.deepEqual(BUILT_IN_SMART_FOLDERS.map((item) => item.id), [
    "builtin:recent-materials",
    "builtin:modified-notes",
    "builtin:edited-canvases",
    "builtin:untagged-materials",
    "builtin:untagged-notes",
  ]);
  assert.ok(BUILT_IN_SMART_FOLDERS.every((item) => item.builtIn));
});

test("latest-only loader coalesces one folder refresh and preserves stale entries on failure", async () => {
  let calls = 0;
  let release!: (value: string[]) => void;
  const published: string[][] = [];
  const loader = createLatestSmartFolderResultLoader(
    async () => {
      calls += 1;
      return new Promise<string[]>((resolve) => { release = resolve; });
    },
    (items) => published.push(items),
  );
  loader.activate("folder-a");
  const first = loader.refresh("folder-a");
  const second = loader.refresh("folder-a");
  release(["result"]);
  assert.deepEqual(await first, ["result"]);
  assert.deepEqual(await second, ["result"]);
  assert.equal(calls, 1);
  assert.deepEqual(published.at(-1), ["result"]);

  loader.setRead(async () => { throw new Error("offline"); });
  await assert.rejects(loader.refresh("folder-a", { invalidate: true }), /offline/);
  assert.deepEqual(published.at(-1), ["result"], "refresh failure must retain stale content");
});

test("source invalidations queue at most one trailing refresh without overlapping reads", async () => {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const releases: Array<(value: string[]) => void> = [];
  const published: string[][] = [];
  const loader = createLatestSmartFolderResultLoader(
    async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const result = await new Promise<string[]>((resolve) => releases.push(resolve));
      concurrent -= 1;
      return result;
    },
    (items) => published.push(items),
  );
  loader.activate("folder-a");
  const initial = loader.refresh("folder-a");
  const changedOnce = loader.refresh("folder-a", { invalidate: true });
  const changedTwice = loader.refresh("folder-a", { invalidate: true });
  assert.equal(calls, 1);
  releases.shift()!(["stale"]);
  await initial;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()!(["latest"]);
  assert.deepEqual(await changedOnce, ["latest"]);
  assert.deepEqual(await changedTwice, ["latest"]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(published.at(-1), ["latest"]);
});

test("saved date windows round-trip as local calendar dates and persisted sort wins after edit", () => {
  const start = smartFolderLocalDateIso("2026-08-28", false);
  const end = smartFolderLocalDateIso("2026-08-28", true);
  assert.ok(start);
  assert.ok(end);
  assert.equal(smartFolderLocalDateInput(start), "2026-08-28");
  assert.equal(smartFolderLocalDateInput(end), "2026-08-28");
  assert.equal(new Date(end).getTime() - new Date(start).getTime(), 86_399_999);

  assert.equal(
    reconcileSmartFolderDetailSort(
      { id: "smart-a", source: "note", sort: "modified-desc" },
      { id: "smart-a", source: "note", sort: "name-asc" },
      "modified-asc",
    ),
    "name-asc",
  );
  assert.equal(
    reconcileSmartFolderDetailSort(
      { id: "smart-a", source: "note", sort: "modified-desc" },
      { id: "smart-a", source: "note", sort: "modified-desc" },
      "name-asc",
    ),
    "name-asc",
  );
  assert.equal(
    reconcileSmartFolderDetailSort(
      { id: "smart-a", source: "material", sort: "modified-desc" },
      { id: "smart-a", source: "note", sort: "modified-desc" },
      "added-desc",
    ),
    "modified-desc",
  );
  assert.equal(
    canRetainSmartFolderStale(
      { id: "smart-a", source: "material" },
      { id: "smart-a", source: "note" },
    ),
    false,
    "changing the one-source definition must not retain results from the old source",
  );
  assert.equal(
    canRetainSmartFolderStale(
      { id: "smart-a", source: "material" },
      { id: "smart-a", source: "material" },
    ),
    true,
  );
});

test("URL drafts are completed per source and malformed fields fail soft", () => {
  const hash = (input: unknown) => `#smart?draft=${encodeURIComponent(JSON.stringify(input))}`;
  assert.deepEqual(readSmartFolderDraft(hash({
    name: "素材",
    sort: "name-asc",
    criteria: { source: "material" },
  }))?.criteria, {
    source: "material",
    query: "",
    kinds: [],
    tagIds: [],
    favorite: null,
    added: { after: null, before: null },
    modified: { after: null, before: null },
  });
  assert.equal(readSmartFolderDraft(hash({
    name: "笔记",
    sort: "modified-desc",
    criteria: { source: "note", tagIds: "not-an-array" },
  })), null);
  assert.equal(readSmartFolderDraft(hash({
    name: "画布",
    sort: "modified-desc",
    criteria: { source: "canvas", modified: { after: 7 } },
  })), null);
  assert.equal(readSmartFolderDraft(hash({
    name: "笔记",
    sort: "added-desc",
    criteria: { source: "note" },
  })), null);
});

test("the smart-folder definitions table remains the only result authority in the current schema", async () => {
  const backend = await readFile(new URL("../src-tauri/src/backend/mod.rs", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/smart_folders.rs", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(backend, /const SCHEMA_VERSION: u32 = 20/);
  assert.match(backend, /CREATE TABLE smart_folder_definition/);
  assert.doesNotMatch(backend, /smart_folder_(result|cache|snapshot)/);
  assert.match(rust, /enum SmartFolderCriteria/);
  assert.match(rust, /Material \{/);
  assert.match(rust, /Note \{/);
  assert.match(rust, /Canvas \{/);
  assert.doesNotMatch(rust, /field.*operator.*value|RuleTree|serde_json::Value/);
  assert.match(app, /listSmartFolders: \(\) => Promise<SmartFolderDefinition\[\]>/);
});

test("smart route is real, overview stays metadata-only, and detail reuses source authorities", async () => {
  const sidebar = await readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/features/smartFolders/SmartFoldersPage.tsx", import.meta.url), "utf8");
  const results = await readFile(new URL("../src/features/smartFolders/smartFolderResults.ts", import.meta.url), "utf8");
  assert.match(sidebar, /\| "smart" \|/);
  assert.doesNotMatch(sidebar, /id === "smart"[\s\S]{0,120}onNavigate\("materials"\)/);
  assert.match(shell, /const SmartFoldersPage = lazy/);
  assert.match(shell, /<SmartFoldersPage hashPath=\{hashPath\}/);
  assert.match(page, /function SmartFolderOverview/);
  assert.doesNotMatch(page.slice(page.indexOf("function SmartFolderOverview"), page.indexOf("function DefinitionCard")), /readSmartFolderResults|ensureSnapshot|listCanvases/);
  assert.match(results, /materialStore\.ensureSnapshot/);
  assert.match(results, /knowledgeStore\.ensureSnapshot/);
  assert.match(results, /bridge\.listCanvases\(\)/);
  assert.match(results, /listItemTagMap\("asset", ids, \{ batchOnly: true \}\)/);
  assert.doesNotMatch(results, /ids\.map\([\s\S]{0,100}listItemTagMap|for \([^)]+\)[\s\S]{0,100}listItemTagMap/);
  assert.match(page, /let effectActive = true/);
  assert.match(page, /if \(!effectActive\) return;[\s\S]{0,100}setError/);
  assert.match(page, /effectActive = false;[\s\S]{0,100}loader\.deactivate\(\)/);
});

test("source pages save only their real supported filters and automatic import has one editable home", async () => {
  const materials = await readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const notes = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
  const canvas = await readFile(new URL("../src/features/canvas/CanvasHomePage.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/features/smartFolders/SmartFoldersPage.tsx", import.meta.url), "utf8");
  const autoImport = await readFile(new URL("../src/features/smartFolders/AutoImportManager.tsx", import.meta.url), "utf8");
  assert.match(materials, /saveCurrentMaterialSmartFolder/);
  assert.match(materials, /sortBy === "recent"/);
  assert.match(materials, /sortBy === "random"/);
  assert.match(notes, /onSaveSmartFolder/);
  assert.match(canvas, /sortMode === "oldest" \? "modified-asc"/);
  assert.match(page, /<AutoImportManager mode="inline" \/>/);
  assert.match(page, /\.\/AutoImportManager/);
  assert.doesNotMatch(page, /#settings\?focus=auto-import/);
  assert.doesNotMatch(settings, /addMaterialWatchSource|readMaterialWatchSources|updateMaterialWatchSource|removeMaterialWatchSource/);
  assert.doesNotMatch(settings, /settings-auto-import|focus !== "auto-import"|Watch 文件夹|自动导入/);
  assert.match(autoImport, /addMaterialWatchSource/);
  assert.match(autoImport, /updateMaterialWatchSource/);
  assert.match(autoImport, /removeMaterialWatchSource/);
  assert.match(autoImport, /general\.watchFolder/);
  assert.match(autoImport, /materials\.importMode/);
  assert.match(autoImport, /luckyray:material-watch-run-now/);
  assert.doesNotMatch(autoImport, /role="dialog"|smart-dialog-backdrop|aria-haspopup="dialog"/);
  assert.match(autoImport, /className=\{`smart-auto-import-region \$\{mode\}`\}/);
  assert.match(autoImport, /role="switch"/);
  assert.match(autoImport, /aria-label=\{enabled \? t\("master\.turnOff"\) : t\("master\.turnOn"\)\}/);
  assert.doesNotMatch(autoImport, /setInterval|WATCH_POLL|startMaterialWatchService|localStorage\.setItem/);
});

test("smart folder UI stays responsive and editor exposes bounded source-specific criteria", async () => {
  const page = await readFile(new URL("../src/features/smartFolders/SmartFoldersPage.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/features/smartFolders/smartFolders.css", import.meta.url), "utf8");
  assert.match(page, /t\("field\.kinds"\)/);
  assert.match(page, /t\("field\.tags"\)/);
  assert.match(page, /t\("field\.favorite"\)/);
  assert.match(page, /t\("field\.added"\)/);
  assert.match(page, /t\("field\.modified"\)/);
  assert.doesNotMatch(page, /正则|排除条件|AND\/OR|子文件夹|规则导入|自动动作/);
  assert.match(css, /repeat\(auto-fit, minmax/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(page, /className="smart-dialog-header editorial-dialog-head"/);
  assert.match(page, /className="editorial-dialog-header-row"/);
  assert.match(page, /smart-dialog-header-icon editorial-dialog-header-icon/);
  assert.match(page, /className="smart-editor-body editorial-dialog-body"/);
  assert.match(page, /className="smart-dialog-actions smart-editor-actions editorial-dialog-footer"/);
  assert.match(css, /\.smart-dialog\.editor\s*\{[^}]*height:\s*min\([^;]+;[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.smart-editor-body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.smart-editor-actions\s*\{[^}]*margin-top:\s*0/s);
  assert.match(css, /\.smart-search:focus-within\s*\{[^}]*border-color:[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /filter:\s*drop-shadow|text-shadow|animation:[^;]*(glow|pulse)/);
});

test("smart folder details use one quiet heading hierarchy and line-icon navigation", async () => {
  const page = await readFile(new URL("../src/features/smartFolders/SmartFoldersPage.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/features/smartFolders/smartFolders.css", import.meta.url), "utf8");
  const detail = page.slice(page.indexOf("function SmartFolderDetail"), page.indexOf("function ResultCard"));
  const sharedCss = await readFile(new URL("../src/components/editorialContentChrome.css", import.meta.url), "utf8");
  assert.match(sharedCss, /assets\/icons\/lightseek-ui-v2\/back\.svg/);
  assert.match(detail, /className="smart-back-icon editorial-back-icon"/);
  assert.match(detail, /className="smart-detail-title-copy"[\s\S]*className="smart-rule-chips"/);
  assert.doesNotMatch(detail, /<p>\{summarizeSmartFolderCriteria/);
  assert.match(css, /\.smart-detail h1\s*\{[^}]*font-size:\s*clamp\(25px, 2\.6vw, 34px\)[^}]*font-weight:\s*700[^}]*line-height:\s*1\.18/s);
  assert.match(sharedCss, /\.editorial-page-heading h1\s*\{[^}]*font-size:\s*clamp\(25px, 2\.6vw, 34px\)/s);
  assert.match(sharedCss, /\.editorial-back-icon\s*\{[^}]*mask:[^}]*back\.svg/s);
});
