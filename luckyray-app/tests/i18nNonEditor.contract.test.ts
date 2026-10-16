import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  messageCatalog,
  normalizeLocale,
  selectPluralKey,
  translate,
  type MessageKey,
} from "../src/core/i18n/index.ts";
import {
  SETTINGS_DEFAULTS,
  readSavedLocale,
  writeSavedSettingsPatch,
} from "../src/features/settings/useSettings.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BATCH_ONE_SURFACES = [
  "src/app/AppShell.tsx",
  "src/app/AppSidebar.tsx",
  "src/features/search/SearchOverlay.tsx",
  "src/features/settings/SettingsPage.tsx",
  "src/features/settings/AiModelProfilesPanel.tsx",
  "src/features/settings/CompanionGatewayPanel.tsx",
  "src/features/materials/MaterialsPage.tsx",
  "src/features/folders/FolderTree.tsx",
  "src/features/canvas/CanvasHomePage.tsx",
  "src/features/tags/TagsPage.tsx",
  "src/features/tags/TagDetail.tsx",
  "src/features/favorites/FavoritesPage.tsx",
  "src/features/smartFolders/SmartFoldersPage.tsx",
  "src/features/smartFolders/AutoImportManager.tsx",
  "src/features/community/CommunityPage.tsx",
  "src/features/collection/CollectionPage.tsx",
  "src/features/browser/BrowserPage.tsx",
  "src/features/ai/DshNativeSurfacePage.tsx",
] as const;

const BATCH_TWO_SURFACES = [
  "src/features/notes/NotesPage.tsx",
  "src/CanvasSpike.tsx",
  "src/features/graph/GraphPage.tsx",
] as const;

test("i18n catalogs have exact typed zh/en parity and Chinese remains the default", () => {
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(SETTINGS_DEFAULTS["general.language"], DEFAULT_LOCALE);
  assert.deepEqual(Object.keys(messageCatalog["zh-CN"]).sort(), Object.keys(messageCatalog["en-US"]).sort());
  assert.ok(Object.keys(messageCatalog["zh-CN"]).length > 0);
});

test("locale normalization is closed to zh-CN and en-US", () => {
  assert.equal(isSupportedLocale("zh-CN"), true);
  assert.equal(isSupportedLocale("en-US"), true);
  assert.equal(isSupportedLocale("fr-FR"), false);
  assert.equal(normalizeLocale("en-US"), "en-US");
  assert.equal(normalizeLocale("anything"), "zh-CN");
});

test("semantic messages support safe parameters and select natural one/other forms", () => {
  const forms = { one: "common.count.items.one", other: "common.count.items.other" } as const satisfies { one: MessageKey; other: MessageKey };
  assert.equal(selectPluralKey("zh-CN", 1, forms), forms.other);
  assert.equal(selectPluralKey("en-US", 1, forms), forms.one);
  assert.equal(selectPluralKey("en-US", 2, forms), forms.other);
  assert.equal(translate("zh-CN", selectPluralKey("zh-CN", 1, forms), { count: 1 }), "1 项");
  assert.equal(translate("en-US", selectPluralKey("en-US", 1, forms), { count: 1 }), "1 item");
  assert.equal(translate("en-US", selectPluralKey("en-US", 2, forms), { count: 2 }), "2 items");
  assert.equal(translate("en-US", "common.status.failed", { reason: "<b>offline</b>" }), "Failed: <b>offline</b>");
});

test("Batch 1 count-bearing surfaces route visible English nouns through plural selection", async () => {
  const expected = new Map<string, RegExp[]>([
    ["src/features/materials/MaterialsPage.tsx", [/plural\(result\.assets\.length/u, /materials\.batch\.selected\.one/u, /materials\.filter\.atLeastStars\.one/u, /materials\.detail\.stars\.one/u]],
    ["src/features/canvas/CanvasHomePage.tsx", [/plural\(canvases\.length/u, /summary\.count\.one/u]],
    ["src/features/tags/TagsPage.tsx", [/plural\(summary\.tags/u, /card\.total\.one/u]],
    ["src/features/tags/TagDetail.tsx", [/plural\(items\.length/u, /toolbar\.count\.one/u]],
    ["src/features/favorites/FavoritesPage.tsx", [/pluralRef\.current\(nodes/u, /source\.canvasEdges\.one/u]],
    ["src/features/search/searchCore.ts", [/searchPluralText\(query\.locale, canvas\.nodeCount/u, /search\.secondary\.canvasEdges\.one/u]],
    ["src/features/smartFolders/SmartFoldersPage.tsx", [/plural\(visibleItems\.length/u, /criteria\.tags\.one/u, /plural\(nodes/u, /result\.canvasEdges\.one/u]],
    ["src/features/smartFolders/AutoImportManager.tsx", [/plural\(sources\.length/u, /header\.status\.one/u, /scan\.skipped\.one/u]],
    ["src/features/folders/FolderTree.tsx", [/plural\(deleteImpact\.folderCount/u, /delete\.folderImpact\.one/u]],
    ["src/features/collection/CollectionPage.tsx", [/plural\(selectedItems\.length/u, /status\.batch\.one/u]],
    ["src/features/settings/AiModelProfilesPanel.tsx", [/plural\(profile\.availableModels\.length/u, /profile\.models\.one/u]],
    ["src/features/settings/SettingsPage.tsx", [/plural\(result\.cleared_tables\.length/u, /settings\.status\.cleared\.one/u]],
  ]);
  for (const [path, patterns] of expected) {
    const text = await source(path);
    for (const pattern of patterns) assert.match(text, pattern, `${path} must select one/other copy`);
  }
});

test("AppShell owns one provider and Settings exposes a live language control", async () => {
  const [shell, settings] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/features/settings/SettingsPage.tsx"),
  ]);
  assert.match(shell, /I18nProvider/);
  assert.match(settings, /general\.language/);
  assert.match(settings, /zh-CN/);
  assert.match(settings, /en-US/);
  assert.doesNotMatch(settings, /English 后续支持/);
});

test("the existing settings authority persists locale and publishes its canonical change event", () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousCustomEvent = globalThis.CustomEvent;
  const values = new Map<string, string>();
  const eventTarget = new EventTarget();
  class LocalCustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init: CustomEventInit<T> = {}) {
      super(type);
      this.detail = init.detail as T;
    }
  }
  const observed: string[] = [];
  eventTarget.addEventListener("luckyray:settings-change", (event) => {
    observed.push(String((event as CustomEvent<{ settings: Record<string, unknown> }>).detail.settings["general.language"]));
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: LocalCustomEvent });
  try {
    assert.equal(readSavedLocale(), "zh-CN");
    writeSavedSettingsPatch({ "general.language": "en-US" });
    assert.equal(readSavedLocale(), "en-US");
    assert.deepEqual(observed, ["en-US"]);
    assert.equal(JSON.parse(values.get("luckyray-settings-v1") || "{}")["general.language"], "en-US");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
    Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: previousCustomEvent });
  }
});

test("Batch 1 and Batch 2 surfaces share the typed translation authority", async () => {
  for (const path of [...BATCH_ONE_SURFACES, ...BATCH_TWO_SURFACES]) {
    const text = await source(path);
    assert.match(text, /useI18n|useMessages|translate\(/, `${path} must consume the typed i18n authority`);
  }
});

test("Batch 1 production markup has no unowned Chinese literals outside exact internal allowlists", async () => {
  const leaks: string[] = [];
  for (const path of BATCH_ONE_SURFACES) {
    const text = (await source(path)).replace(/const COPY = defineMessages\(\{[\s\S]*?\n\}\);\r?\n/g, "");
    const lines = text.split(/\r?\n/);
    let inSettingsSearchIndex = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.startsWith("const panelSearchText:")) inSettingsSearchIndex = true;
      if (inSettingsSearchIndex && trimmed === "};") inSettingsSearchIndex = false;
      if (!/[\u3400-\u9fff]/u.test(line)) continue;
      const allowed = trimmed.startsWith("//")
        || trimmed.startsWith("*")
        || (trimmed.startsWith("{/*") && trimmed.endsWith("*/}"))
        || (path === "src/features/settings/SettingsPage.tsx" && (
          line.includes("searchText=")
          || line.includes("const key = ({ 全局:")
          || inSettingsSearchIndex
        ))
        || (path === "src/features/community/CommunityPage.tsx" && (
          trimmed.startsWith("if (templateId")
          || trimmed.startsWith("return \"# 技术笔记")
        ));
      if (!allowed) leaks.push(`${path}:${index + 1}:${trimmed}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test("locale reaches search caching and the Favorites and Smart Folder source projections", async () => {
  const [search, searchHook, favorites, favoritePage, smartResults, smartPage] = await Promise.all([
    source("src/features/search/searchCore.ts"),
    source("src/features/search/useGlobalSearch.ts"),
    source("src/features/favorites/favoriteSources.ts"),
    source("src/features/favorites/FavoritesPage.tsx"),
    source("src/features/smartFolders/smartFolderResults.ts"),
    source("src/features/smartFolders/SmartFoldersPage.tsx"),
  ]);
  assert.match(searchHook, /locale,/u);
  assert.ok(search.includes("${provider.id}|${query.locale || DEFAULT_LOCALE}|"));
  assert.match(favorites, /copy: FavoriteSourceCopy/u);
  assert.doesNotMatch(favorites, /copy\?\.|[\u3400-\u9fff]/u);
  assert.match(favoritePage, /hydrateFavoriteSources\([\s\S]*source\.untitledNote[\s\S]*source\.missingSummary/u);
  assert.match(favoritePage, /openFavoriteSource\(entry, t\("source\.legacyConfirm"\)\)/u);
  assert.match(smartResults, /copy\?: SmartFolderResultCopy/u);
  assert.match(smartPage, /readSmartFolderResults\([\s\S]*result\.untitledMaterial[\s\S]*result\.canvasNodes\.one[\s\S]*result\.canvasEdges\.one/u);
});

test("official DSH child content is not translated or mutated", async () => {
  const surface = await source("src/features/ai/DshNativeSurfacePage.tsx");
  assert.match(surface, /DshNativeSurfacePage/);
  assert.doesNotMatch(surface, /querySelector\([^)]*dsh|innerHTML\s*=/i);
});

test("translated hook callbacks cannot retain the previous locale", async () => {
  const missing: string[] = [];
  for (const path of [...BATCH_ONE_SURFACES, ...BATCH_TWO_SURFACES]) {
    const text = await source(path);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && ["useCallback", "useEffect", "useLayoutEffect", "useMemo"].includes(node.expression.text)) {
        const callback = node.arguments[0];
        const dependencies = node.arguments[1];
        if (callback && dependencies && ts.isArrayLiteralExpression(dependencies)) {
          const callbackText = callback.getText(file);
          for (const authority of ["t", "plural", "locale"] as const) {
            const used = authority === "locale"
              ? /\blocale\b/u.test(callbackText)
              : new RegExp(`\\b${authority}\\s*\\(`, "u").test(callbackText);
            if (used
              && !dependencies.elements.some((element) => element.getText(file) === authority)) {
              const position = file.getLineAndCharacterOfPosition(node.getStart(file));
              missing.push(`${path}:${position.line + 1}:${authority}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  assert.deepEqual(missing, []);
});

test("LuckyRay shell status surfaces localize stable service outcomes instead of rendering backend messages", async () => {
  const [companion, settings, dshSurface, profiles] = await Promise.all([
    source("src/features/settings/CompanionGatewayPanel.tsx"),
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/ai/DshNativeSurfacePage.tsx"),
    source("src/features/settings/AiModelProfilesPanel.tsx"),
  ]);
  assert.match(companion, /gatewayErrorMessage\(reason, t\)/u);
  assert.doesNotMatch(companion, /companionGatewayErrorMessage/u);
  assert.match(settings, /localizedDshHostStatus\(dshHostStatus, t\)/u);
  assert.match(settings, /localizedAgentSearchConnection\(result\.code, t\)/u);
  assert.doesNotMatch(settings, /dshHostStatus\?\.message|showStatus\(result\.label/u);
  assert.match(dshSurface, /setError\(t\("error\.startup"\)\)/u);
  assert.doesNotMatch(dshSurface, /describeDshHostStartupError/u);
  assert.match(profiles, /result\.outcome === "synced"[\s\S]*t\(statusKey\)/u);
  assert.doesNotMatch(profiles, /onStatus\(result\.message/u);
});

test("Batch 1 presentation boundaries never expose internal service error prose", async () => {
  const presentationBoundaries = [
    "src/features/settings/SettingsPage.tsx",
    "src/features/settings/CompanionGatewayPanel.tsx",
    "src/features/materials/MaterialsPage.tsx",
    "src/features/canvas/CanvasHomePage.tsx",
    "src/features/tags/TagsPage.tsx",
    "src/features/tags/TagDetail.tsx",
    "src/features/favorites/FavoritesPage.tsx",
    "src/features/smartFolders/SmartFoldersPage.tsx",
    "src/features/smartFolders/AutoImportManager.tsx",
    "src/features/community/CommunityPage.tsx",
    "src/features/collection/CollectionPage.tsx",
  ] as const;
  const forbidden = /\b(?:error|err|cause|reason|outcome)\.message\b|knowledgeErrorMessage|result\.errors\[[^\]]+\]\.error|status\.lastError/u;
  for (const path of presentationBoundaries) {
    assert.doesNotMatch(await source(path), forbidden, `${path} must render its own locale copy`);
  }

  const browser = await source("src/features/browser/BrowserPage.tsx");
  assert.match(browser, /const code = reason instanceof Error \? reason\.message/u);
  assert.match(browser, /return messages\[code\] \|\| t\("error\.generic"\)/u);
});
