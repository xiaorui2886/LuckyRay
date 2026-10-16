import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FAVORITE_TYPES,
  createFavoriteSourceListLoader,
  createFavoriteShelfLoader,
  defaultFavoriteViewState,
  filterAndSortFavorites,
  selectFavoriteSourcesById,
  type FavoriteShelfEntry,
} from "../src/features/favorites/favoriteShelfModel.ts";
import { resolveFavoriteNoteIdentity } from "../src/features/favorites/favoriteNoteIdentity.ts";
import { loadMaterialFavoriteTags } from "../src/features/favorites/favoriteTagProjection.ts";
import { knowledgeDocumentNoteId, resolveKnowledgeNoteNavigation } from "../src/core/services/knowledge.ts";
import type { FavoriteItem, FavoriteItemType } from "../src/core/services/favorites.ts";

function entry(input: Partial<FavoriteShelfEntry> & { id: string; type?: FavoriteItemType }): FavoriteShelfEntry {
  const favorite: FavoriteItem = {
    itemType: input.type || "material",
    itemId: input.id,
    theme: input.favorite?.theme || "",
    copy: input.favorite?.copy || "",
    favoritedAt: input.favorite?.favoritedAt || "2026-08-01T00:00:00Z",
    noteUpdatedAt: input.favorite?.noteUpdatedAt || null,
  };
  return {
    favorite,
    sourceId: input.sourceId || input.id,
    sourceConfirmation: input.sourceConfirmation || null,
    missing: input.missing || false,
    name: input.name || input.id,
    summary: input.summary || "",
    sourceUpdatedAt: input.sourceUpdatedAt || null,
    previewKind: input.previewKind || "image",
    previewUrl: input.previewUrl || null,
    previewPoster: input.previewPoster || null,
    tags: input.tags || [],
  };
}

test("favorites have exactly three lazy categories and no aggregate all route", () => {
  assert.deepEqual(FAVORITE_TYPES, ["material", "note", "canvas"]);
  assert.deepEqual(Object.keys(defaultFavoriteViewState()), FAVORITE_TYPES);
  assert.equal(FAVORITE_TYPES.includes("all" as FavoriteItemType), false);
});

test("current-category search includes source name, summary, theme and copy", () => {
  const values = [
    entry({ id: "a", name: "海报", summary: "蓝色构图" }),
    entry({ id: "b", name: "笔记", favorite: { theme: "灵感主题" } as FavoriteItem }),
    entry({ id: "c", name: "画布", favorite: { copy: "回看这个节奏" } as FavoriteItem }),
  ];
  assert.deepEqual(filterAndSortFavorites(values, { query: "构图", sort: "favorited" }).map((value) => value.favorite.itemId), ["a"]);
  assert.deepEqual(filterAndSortFavorites(values, { query: "灵感主题", sort: "favorited" }).map((value) => value.favorite.itemId), ["b"]);
  assert.deepEqual(filterAndSortFavorites(values, { query: "节奏", sort: "favorited" }).map((value) => value.favorite.itemId), ["c"]);
});

test("favorite shelf coalesces same-category refresh and rejects late inactive results", async () => {
  const resolvers = new Map<FavoriteItemType, (entries: FavoriteShelfEntry[]) => void>();
  const calls: FavoriteItemType[] = [];
  const published: FavoriteItemType[] = [];
  const loader = createFavoriteShelfLoader(
    (type) => {
      calls.push(type);
      return new Promise<FavoriteShelfEntry[]>((resolve) => resolvers.set(type, resolve));
    },
    (type) => published.push(type),
  );

  loader.activate("material");
  const first = loader.refresh("material");
  const duplicate = loader.refresh("material");
  assert.deepEqual(calls, ["material"]);
  loader.activate("note");
  const note = loader.refresh("note");
  resolvers.get("material")?.([entry({ id: "material" })]);
  await Promise.all([first, duplicate]);
  assert.deepEqual(published, []);
  resolvers.get("note")?.([entry({ id: "note", type: "note" })]);
  await note;
  assert.deepEqual(published, ["note"]);
});

test("favorite shelf publishes generation-fenced core entries before note decoration", async () => {
  const materialDecoration: Array<(entries: FavoriteShelfEntry[]) => void> = [];
  const published: string[][] = [];
  const loader = createFavoriteShelfLoader(
    (type, publishCore) => {
      const core = [entry({ id: `${type}-core`, type })];
      publishCore(core);
      return new Promise<FavoriteShelfEntry[]>((resolve) => materialDecoration.push(resolve));
    },
    (_type, items) => published.push(items.map((item) => item.favorite.itemId)),
  );

  loader.activate("note");
  const note = loader.refresh("note");
  assert.deepEqual(published, [["note-core"]]);
  loader.activate("material");
  materialDecoration[0]([entry({ id: "note-decorated", type: "note" })]);
  await note;
  assert.deepEqual(published, [["note-core"]]);
});

test("material source selection handles empty and more than 64 favorites without truncation", () => {
  const favorites = Array.from({ length: 65 }, (_, index) => entry({ id: `asset-${index}` }).favorite);
  const sources = favorites.map((favorite) => ({ id: favorite.itemId, label: favorite.itemId }));
  assert.deepEqual(selectFavoriteSourcesById([], sources), []);
  assert.equal(selectFavoriteSourcesById(favorites.slice(0, 1), sources).length, 1);
  assert.equal(selectFavoriteSourcesById(favorites.slice(0, 64), sources).length, 64);
  assert.equal(selectFavoriteSourcesById(favorites, sources).length, 65);
});

test("same-category invalidation gets one trailing read and publishes only its latest result", async () => {
  const resolvers: Array<(items: string[]) => void> = [];
  const published: string[][] = [];
  const loader = createFavoriteSourceListLoader(
    () => new Promise<string[]>((resolve) => resolvers.push(resolve)),
    (items) => published.push(items),
  );
  loader.activate();
  const first = loader.refresh();
  const invalidated = loader.refresh({ invalidate: true });
  assert.equal(resolvers.length, 1);
  resolvers[0](["stale"]);
  await Promise.resolve();
  assert.equal(resolvers.length, 2);
  assert.deepEqual(published, []);
  resolvers[1](["current"]);
  await Promise.all([first, invalidated]);
  assert.deepEqual(published, [["current"]]);
});

test("shelf invalidation during hydration publishes one trailing current snapshot", async () => {
  const resolvers: Array<(items: FavoriteShelfEntry[]) => void> = [];
  const published: string[][] = [];
  const loader = createFavoriteShelfLoader(
    () => new Promise<FavoriteShelfEntry[]>((resolve) => resolvers.push(resolve)),
    (_type, items) => published.push(items.map((item) => item.favorite.itemId)),
  );
  loader.activate("material");
  const first = loader.refresh("material");
  const invalidated = loader.refresh("material", { invalidate: true });
  resolvers[0]([entry({ id: "stale" })]);
  await Promise.resolve();
  assert.equal(resolvers.length, 2);
  assert.deepEqual(published, []);
  resolvers[1]([entry({ id: "current" })]);
  await Promise.all([first, invalidated]);
  assert.deepEqual(published, [["current"]]);
});

test("production contracts retain one reference table, batch source hydration and true shell route", async () => {
  const [backend, rustFavorites, sources, page, shell, sidebar, materials, notes, canvas] = await Promise.all([
    readFile(new URL("../src-tauri/src/backend/mod.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/favorites.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/favoriteSources.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/FavoritesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/canvas/CanvasHomePage.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(backend, /CREATE TABLE favorite_item/);
  assert.match(backend, /PRIMARY KEY\(item_type,item_id\)/);
  assert.match(rustFavorites, /INSERT OR IGNORE INTO favorite_item/);
  assert.doesNotMatch(rustFavorites, /copy_file|create_dir|std::fs/);
  assert.match(sources, /materialStore\.ensureSnapshot/);
  assert.doesNotMatch(sources, /getMaterialAssetsByIds|listMaterialAssets/);
  assert.match(sources, /knowledgeStore\.ensureSnapshot/);
  assert.match(sources, /listCanvases\(\)/);
  assert.doesNotMatch(sources, /for \([^)]*favorite[^)]*\)[\s\S]{0,120}await/);
  assert.match(page, /createFavoriteShelfLoader/);
  assert.match(page, /entriesByType/);
  assert.match(page, /materialStore\.retainChangeProtocol\(\)/);
  assert.match(page, /materialStore\.subscribe\(/);
  assert.match(page, /nextVersion <= observedVersion/);
  assert.doesNotMatch(page, /window\.addEventListener\(MATERIAL_CHANGE_EVENT/);
  assert.match(page, /favorite\.theme/);
  assert.match(page, /favorite\.copy/);
  assert.match(page, /favoriteHasNotes\(entry\.favorite\)/);
  assert.doesNotMatch(page, /setInterval|setTimeout|watch\(/);
  assert.match(shell, /route === "favorites"/);
  assert.match(sidebar, /onNavigate\(id\)/);
  assert.doesNotMatch(sidebar, /id === "favorites"/);
  assert.match(materials, /useFavoriteItems\("material",\s*scope\?\.libraryId\)/);
  assert.match(notes, /useFavoriteItems\("note"\)/);
  assert.match(canvas, /useFavoriteItems\("canvas"\)/);
});

test("favorite presentation uses one asset, icon-only source actions, staged note cards and shared browse controls", async () => {
  const [glyph, asset, favorites, favoriteCss, materials, materialCss, notes, notesCss, tags, tagsCss, browseCss, canvas] = await Promise.all([
    readFile(new URL("../src/components/FavoriteGlyph.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/assets/icons/lightseek-ui-v2/favorite.svg", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/FavoritesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/favorites.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/materials/materials.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/notes.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/tags/TagsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/tags/tags.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/contentBrowserControls.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/canvas/CanvasHomePage.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(glyph, /lightseek-ui-v2\/favorite\.svg\?raw/);
  assert.match(glyph, /filled/);
  assert.doesNotMatch(glyph, /<path|<polygon/);
  assert.match(asset, /fill="none"/);
  assert.match(favorites, /<FavoriteGlyph/);
  assert.doesNotMatch(favorites, /function FavoriteAssetIcon/);
  assert.match(favoriteCss, /favorite-note-cover\.article/);
  assert.match(favoriteCss, /\.favorite-material-cover, \.favorite-canvas-cover, \.favorite-note-cover\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;/s);
  assert.match(favoriteCss, /\.favorite-note-cover\.article\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*14px 14px 0 0;/s);
  const noteCoverRule = favoriteCss.match(/(?:^|\n)\.favorite-note-cover\s*\{([^}]*)\}/s)?.[1] || "";
  const articleRule = favoriteCss.match(/\.favorite-note-cover\.article\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(noteCoverRule, /min-height:\s*250px;/);
  assert.match(noteCoverRule, /aspect-ratio:\s*4\s*\/\s*5;/);
  assert.doesNotMatch(articleRule, /min-height|height\s*:|aspect-ratio/);
  assert.match(articleRule, /padding:\s*\d+px 15px \d+px;/);
  assert.match(articleRule, /background:\s*color-mix\(/);
  assert.match(articleRule, /box-shadow:\s*none;/);
  assert.doesNotMatch(articleRule, /linear-gradient|5px 100%|min-height:\s*174px/);
  assert.match(favoriteCss, /\.favorite-material-cover, \.favorite-canvas-cover, \.favorite-note-cover\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(favoriteCss, /\.favorite-note-cover\.article \.favorite-note-cover-content strong\s*\{[^}]*display:\s*-webkit-box;[^}]*-webkit-line-clamp:\s*3;[^}]*-webkit-box-orient:\s*vertical;[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(favoriteCss, /\.favorite-note-cover-content small\s*\{[^}]*-webkit-line-clamp:\s*3;[^}]*overflow:\s*hidden;/s);
  const articleContentRule = favoriteCss.match(/\.favorite-note-cover\.article \.favorite-note-cover-content\s*\{([^}]*)\}/s)?.[1] || "";
  const articleSummaryRule = favoriteCss.match(/\.favorite-note-cover\.article \.favorite-note-cover-content small\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(articleContentRule, /flex:\s*1(?:\s+1\s+auto)?;/);
  assert.match(articleContentRule, /min-height:\s*0;/);
  assert.match(articleContentRule, /overflow:\s*hidden;/);
  assert.match(articleSummaryRule, /display:\s*block;/);
  assert.match(articleSummaryRule, /flex:\s*1(?:\s+1\s+auto)?;/);
  assert.match(articleSummaryRule, /min-height:\s*0;/);
  assert.match(articleSummaryRule, /overflow:\s*hidden;/);
  assert.match(articleSummaryRule, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(articleSummaryRule, /-webkit-line-clamp:\s*\d+/);
  assert.doesNotMatch(articleSummaryRule, /text-align:\s*justify|justify-content:\s*space-between/);
  assert.match(favoriteCss, /\.favorite-card-body\s*\{[^}]*padding:\s*14px 15px 15px;/s);
  assert.match(favoriteCss, /\.favorite-note-cover\.article \.favorite-note-cover-content\s*\{[^}]*min-height:\s*0;/s);
  assert.doesNotMatch(`${favorites}\n${favoriteCss}`, /favorite-book-spine/);
  assert.doesNotMatch(favoriteCss, /\.favorite-note-cover\.article::after/);
  assert.doesNotMatch(favoriteCss, /\.favorite-card\.note-article \.favorite-card-body/);
  assert.equal(favorites.match(/<div className="favorite-card-body">/g)?.length, 1);
  assert.match(favorites, /type === "note" \? <p className="favorite-note-footer-meta">\{t\("note\.meta", \{ date: formatDate\(entry\.sourceUpdatedAt, locale, t\) \}\)\}<\/p>/);
  assert.match(favoriteCss, /\.favorite-source-row \.favorite-note-footer-meta\s*\{[^}]*margin:\s*0;/s);
  assert.match(materials, /useFavoriteItems\("material",\s*scope\?\.libraryId\)/);
  assert.equal(materials.match(/useFavoriteItems\("material",\s*scope\?\.libraryId\)/g)?.length, 1);
  assert.match(materials, /asset-favorite-fab-react/);
  assert.match(materials, /event\.stopPropagation\(\)/);
  assert.ok(materials.indexOf("asset-preview-fab-react") < materials.indexOf("asset-favorite-fab-react"));
  assert.match(materialCss, /\.asset-preview-fab-react\s*\{[^}]*right:\s*40px;/s);
  assert.match(materialCss, /\.asset-favorite-fab-react\s*\{[^}]*right:\s*10px;[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/s);
  assert.match(materialCss, /\.asset-favorite-fab-react\.active\s*\{[^}]*color:\s*var\(--accent[^}]*background:\s*transparent;/s);
  const favoriteInteractiveRule = materialCss.match(/\.asset-favorite-fab-react:hover,\s*\.asset-favorite-fab-react:focus-visible\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(favoriteInteractiveRule, /background:\s*transparent/);
  assert.match(favoriteInteractiveRule, /backdrop-filter:\s*none/);
  assert.doesNotMatch(materials, /function IconBookmark/);
  assert.match(materialCss, /focus-within[\s\S]{0,240}asset-favorite-fab-react/);
  assert.match(notes, /<FavoriteGlyph/);
  assert.match(notes, /aria-label=(?:"发送到 LightSeek"|\{t\("editor\.notes\.sendLightSeek"\)\})/);
  assert.doesNotMatch(notes, />\s*发送到 LightSeek\s*</);
  assert.match(notesCss, /note-favorite-action[\s\S]{0,400}30px/);
  assert.match(canvas, /<FavoriteGlyph filled=\{canvasFavorites\.byId\.has\(canvas\.id\)\}/);
  assert.doesNotMatch(favorites, /一篇值得重读的笔记/);
  assert.match(tags, /contentBrowserControls\.css/);
  assert.match(favorites, /contentBrowserControls\.css/);
  assert.match(browseCss, /content-browser-control/);
  assert.match(tagsCss, /repeat\(auto-fit/);
});

test("favorite source consumers refresh only their own domain", async () => {
  const hook = await readFile(new URL("../src/features/favorites/useFavoriteItems.ts", import.meta.url), "utf8");
  assert.match(hook, /detail\?\.itemType !== itemType/);
  assert.match(hook, /createFavoriteSourceListLoader/);
});

test("note favorites canonicalize the NotesPage internal identity without accepting unrelated ids", () => {
  const vaultId = "vault-fixture";
  const canonicalId = knowledgeDocumentNoteId({ vaultId, relativePath: "folder/note.md" });
  assert.equal(resolveFavoriteNoteIdentity("real-vault:folder/note.md", vaultId), null);
  assert.deepEqual(resolveFavoriteNoteIdentity(
    "real-vault:folder/note.md",
    vaultId,
    { allowCurrentVaultLegacy: true },
  ), {
    canonicalId,
    aliases: ["real-vault:folder/note.md", canonicalId],
    documentRef: { vaultId, relativePath: "folder/note.md" },
  });
  assert.deepEqual(resolveFavoriteNoteIdentity(canonicalId, vaultId), {
    canonicalId,
    aliases: [canonicalId],
    documentRef: { vaultId, relativePath: "folder/note.md" },
  });
  assert.deepEqual(resolveKnowledgeNoteNavigation(canonicalId, vaultId), {
    ok: true,
    documentRef: { vaultId, relativePath: "folder/note.md" },
    internalNoteId: "real-vault:folder/note.md",
  });
  assert.equal(resolveFavoriteNoteIdentity("note-from-untrusted-source", vaultId), null);
  assert.equal(resolveFavoriteNoteIdentity("real-vault:../outside.md", vaultId, { allowCurrentVaultLegacy: true }), null);
  assert.equal(resolveFavoriteNoteIdentity("real-vault:folder/note.md", "", { allowCurrentVaultLegacy: true }), null);
});

test("material favorite tags use one catalog read and one bounded batch mapping", async () => {
  let catalogReads = 0;
  let mappingReads = 0;
  const projection = await loadMaterialFavoriteTags(["asset-a", "asset-b"], {
    listTags: async () => {
      catalogReads += 1;
      return [
        { id: "tag-a", name: "灵感", color: "#7c8aff" },
        { id: "tag-b", name: "参考", color: null },
      ];
    },
    listItemTagMap: async (itemType, itemIds) => {
      mappingReads += 1;
      assert.equal(itemType, "asset");
      assert.deepEqual(itemIds, ["asset-a", "asset-b"]);
      return { "asset-a": ["tag-a", "tag-b"], "asset-b": ["tag-b"] };
    },
  });
  assert.equal(catalogReads, 1);
  assert.equal(mappingReads, 1);
  assert.deepEqual(projection["asset-a"].map((tag) => tag.name), ["灵感", "参考"]);
  assert.deepEqual(projection["asset-b"].map((tag) => tag.name), ["参考"]);
  await assert.rejects(
    loadMaterialFavoriteTags(["asset-a"], {
      listTags: async () => { throw new Error("tag-catalog-unavailable"); },
      listItemTagMap: async () => ({ "asset-a": ["tag-a"] }),
    }),
    /tag-catalog-unavailable/,
  );
});

test("visual and navigation contracts keep favorites-specific chrome bounded", async () => {
  const [sources, page, sidebar, styles, notes, glyph] = await Promise.all([
    readFile(new URL("../src/features/favorites/favoriteSources.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/FavoritesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/favorites/favorites.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/FavoriteGlyph.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(notes, /resolveFavoriteNoteIdentity\([\s\S]{0,100}selectedNote\.id,[\s\S]{0,80}currentVault\?\.id,[\s\S]{0,100}allowCurrentVaultLegacy: true/);
  assert.doesNotMatch(notes, /noteFavorites\.toggle\(selectedNote\.id/);
  assert.match(sources, /sourceId:/);
  assert.match(sources, /sourceConfirmation: legacyCandidate \? "legacy-current-vault"/);
  assert.match(sources, /openFavoriteSource\(entry: FavoriteShelfEntry, legacyConfirmation: string\)/);
  assert.match(page, /openFavoriteSource\(entry, t\("source\.legacyConfirm"\)\)/);
  assert.match(sources, /focusNote\(entry\.sourceId/);
  assert.match(sources, /loadMaterialFavoriteTags/);
  assert.doesNotMatch(sources, /loadMaterialFavoriteTags\(favoriteIds\)\.catch/);
  assert.match(await readFile(new URL("../src/features/favorites/favoriteTagProjection.ts", import.meta.url), "utf8"), /batchOnly: true/);
  assert.doesNotMatch(sources, /listItemTagMap\("note"|getNoteTags/);
  assert.match(sidebar, /route !== "favorites"[\s\S]{0,220}titlebar-import/);
  assert.match(sidebar, /hideBreadcrumb[\s\S]{0,180}route === "favorites"/);
  assert.match(glyph, /lightseek-ui-v2\/favorite\.svg\?raw/);
  assert.doesNotMatch(page, /BookmarkIcon filled/);
  assert.match(page, /entry\.tags\.slice\(0, 3\)/);
  assert.match(styles, /favorite-remove \.favorite-glyph/);
  assert.match(styles, /grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(styles, /@media \(min-width: 1800px\)/);
  assert.match(styles, /\.favorite-card\.missing \.favorite-note-cover/);
});
