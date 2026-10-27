import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { SETTINGS_DEFAULTS } from "../src/features/settings/useSettings.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function renderSettingsTab(tab: string, options: { locale?: "zh-CN" | "en-US"; automatic?: boolean } = {}) {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = {
    getItem: (key: string) => key === "luckyray-settings-v1-activePanel" ? tab
      : key === "luckyray-desktop-updates-auto-v1" && options.automatic !== undefined ? String(options.automatic) : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __LUCKYRAY__: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      location: { hash: "" },
    },
  });

  const server = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const module = await server.ssrLoadModule("/src/features/settings/SettingsPage.tsx") as typeof import("../src/features/settings/SettingsPage.tsx");
    const i18n = await server.ssrLoadModule("/src/core/i18n/index.ts") as typeof import("../src/core/i18n/index.ts");
    return renderToStaticMarkup(React.createElement(
      i18n.I18nProvider,
      { locale: options.locale ?? "zh-CN" },
      React.createElement(module.default),
    ));
  } finally {
    await server.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousSessionStorage });
  }
}

test("Storage retires the local Codex installer and manual pairing in both languages", async () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = await renderSettingsTab("storage", { locale });
    assert.doesNotMatch(html, /连接 AI 客户端|Connect an AI client|高级手动配对|Advanced manual pairing|Codex|素材 MCP 授权|Materials MCP access/);
    assert.match(html, locale === "zh-CN" ? /应用数据路径/ : /App data location/);
  }
});

test("AI settings keeps actions outside collapsed information and connections first", async () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = await renderSettingsTab("ai", { locale });
    assert.match(html, /settings-ai-panel/);
    assert.ok(html.indexOf('class="ai-profile-manager"') < html.indexOf('class="dsh-engine-update-card"'));
    const disclosures = [...html.matchAll(/<section class="settings-ai-disclosure">([\s\S]*?)<\/section>/g)];
    assert.equal(disclosures.length, 5, "model test, engine update, diagnostics, extensions and search remain available");
    assert.ok(disclosures.every((match) => match[1].includes('aria-expanded="false"') && /class="settings-ai-disclosure-body" hidden=""/.test(match[1])), "information starts collapsed but stays mounted");
    const actionsOutside = disclosures.map((match) => match[1].slice(0, match[1].indexOf('class="settings-ai-disclosure-body"'))).join("\n");
    assert.match(html, locale === "zh-CN" ? /添加 API 连接/ : /Add API connection/);
    for (const label of locale === "zh-CN" ? ["发送测试消息", "检查更新", "运行诊断", "重新检查扩展", "保存联网设置"] : ["Send test message", "Check for updates", "Run diagnostics", "Recheck extensions", "Save web settings"]) {
      assert.ok(actionsOutside.includes(label), `collapsing never hides ${label}`);
    }
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /settings\.ai\.[a-zA-Z.]+/);
  }
});

test("phone layout uses available settings width with content-based narrow fallbacks", async () => {
  const css = await source("src/features/settings/settings.css");
  const panel = css.match(/\.companion-panel\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(panel, /width:\s*100%/);
  assert.match(panel, /max-width:\s*none/);
  assert.match(css, /\.settings-content\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(css, /@container \(max-width: 820px\)[\s\S]*\.companion-console-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /settings-ai-disclosure-toggle:focus-visible/);
});

test("appearance shows nine miniature interface previews without changing theme selection", async () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = await renderSettingsTab("appearance", { locale });
    assert.equal((html.match(/class="settings-theme-miniature"/g) ?? []).length, 9);
    assert.equal((html.match(/role="radio"/g) ?? []).length, 9);
    assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
    assert.equal((html.match(/--preview-base:/g) ?? []).length, 9);
    assert.match(html, /settings-theme-mini-sidebar/);
    assert.match(html, /settings-theme-mini-tiles/);
    assert.match(html, /settings-theme-preset-footer/);
    assert.doesNotMatch(html, /settings-theme-swatch-dot/);
  }
  const page = await source("src/features/settings/SettingsPage.tsx");
  assert.match(page, /onSelect=\{handleSelectThemePreset\}/);
  assert.match(page, /onClick=\{\(\) => onSelect\(preset\)\}/);
});

test("global settings does not duplicate Knowledge or Materials export actions", async () => {
  const html = await renderSettingsTab("storage");
  assert.doesNotMatch(html, /导入 Markdown 笔记|导出笔记为 Markdown|导入笔记完成|导出笔记完成/);
  assert.doesNotMatch(html, /素材清单导出|导出素材索引清单|查看导出目录/);
});

test("Knowledge page keeps the real Vault import and export production actions", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8"));
  assert.match(source, /bridge\.importNotesVaultMarkdownFiles/);
  assert.match(source, /bridge\.importNotesVaultMarkdownFolder/);
  assert.match(source, /bridge\.exportNotesVaultMarkdownFile/);
  assert.match(source, /bridge\.exportNotesVaultMarkdownFolder/);
});

test("Materials folder tree keeps the real index export action", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8"));
  assert.match(source, /scope === "materials" && bridge\?\.exportAssetsIndex/);
  assert.match(source, /onExport=\{handleFolderExport\}/);
});

test("language is a real immediate Chinese-English control", async () => {
  const html = await renderSettingsTab("general");
  assert.match(html, /界面语言/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.doesNotMatch(html, /后续支持/);
  assert.doesNotMatch(html, /日本語|日期格式/);
});

test("shortcut settings projects one accessible active scope instead of stacking every scope", async () => {
  const html = await renderSettingsTab("shortcut");
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /settings-shortcut-scope-count/);
  assert.doesNotMatch(html, />\s*\d+\s*<\/span>/);
  assert.match(html, /全局搜索/);
  assert.doesNotMatch(html, /选择全部素材|保存当前笔记|保存画布/);
});

test("About uses the current package version without stale release labels", async () => {
  const [html, metadata] = await Promise.all([
    renderSettingsTab("about"),
    source("package.json").then((text) => JSON.parse(text) as { version: string }),
  ]);
  assert.match(html, new RegExp(metadata.version.replaceAll(".", "\\.")));
  assert.doesNotMatch(html, /1\.6\.0|1\.5\.0/);
});

test("About is release-facing and uses the canonical transparent icon without a carrier plate", async () => {
  const [html, page, css] = await Promise.all([
    renderSettingsTab("about"),
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/settings/settings.css"),
  ]);

  assert.match(html, /产品信息、版本与致谢/);
  assert.match(html, /本地优先/);
  assert.doesNotMatch(html, /技术栈|Tauri 2\.x|React \+ Vite|SQLite FTS5/);
  assert.match(page, /import aboutBrandIcon from "\.\.\/\.\.\/\.\.\/src-tauri\/icons\/icon\.png"/u);
  assert.match(page, /<img src=\{aboutBrandIcon\} alt="LuckyRay" \/>/u);
  const logoRule = css.match(/\.settings-about-logo\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(logoRule, /padding:\s*0;/u);
  assert.match(logoRule, /background:\s*transparent;/u);
  assert.doesNotMatch(logoRule, /var\(--bg-base\)|overflow:\s*hidden/u);
  assert.match(css, /\.settings-about-logo img\s*\{[^}]*object-fit:\s*contain;/s);
});

test("About links keep their order with the update entry before the footer", async () => {
  const page = await source("src/features/settings/SettingsPage.tsx");
  const start = page.indexOf('            <div className="setting-group settings-about-links-group"');
  const end = page.indexOf("          </Panel>", start);
  assert.ok(start >= 0 && end > start);
  const stableSlice = page.slice(start, end);
  const expectedOrder = [
    "settings.about.github.pending",
    "settings.about.feedback",
    "settings.about.feedback.pending",
    "settings.about.website",
    "settings.about.website.pending",
    "<DesktopUpdateCard",
  ];
  let cursor = -1;
  for (const key of expectedOrder) {
    const next = stableSlice.indexOf(key);
    assert.ok(next > cursor, `${key} remains in its canonical position`);
    cursor = next;
  }
  assert.match(stableSlice, /settings-about-footer/u);
  assert.match(stableSlice, /settings-about-links settings-about-links-with-updates/u);
  assert.match(stableSlice, /hidden=\{!shouldShow/u);
  assert.match(stableSlice, /<DesktopUpdateCard version=\{APP_VERSION\} active=\{activeTab === "about"\}/u);
  assert.equal((page.match(/<DesktopUpdateCard/g) ?? []).length, 1);
});

test("About renders one compact update disclosure with the saved accessible switch state", async () => {
  for (const automatic of [true, false]) {
    const html = await renderSettingsTab("about", { automatic });
    assert.equal((html.match(/class="settings-link-card/g) ?? []).length, 4);
    assert.match(html, /settings-update-entry[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/u);
    const panelId = html.match(/aria-controls="([^"]+)"/u)?.[1];
    assert.ok(panelId);
    assert.ok(html.includes(`id="${panelId}" class="settings-update-panel" hidden="" role="region"`));
    assert.match(html, new RegExp(`role="switch" class="toggle${automatic ? " on" : ""}" aria-checked="${automatic}"`));
    assert.match(html, /aria-labelledby="[^"]+-automatic"/u);
    assert.doesNotMatch(html, /type="checkbox"/u);
    assert.match(html, /应用内安装尚未启用/u);
    assert.match(html, /aria-label="关闭"/u);
  }
  const en = await renderSettingsTab("about", { locale: "en-US" });
  assert.match(en, /App updates/u);
  assert.match(en, /Check when opening About \(at most once a day\)/u);
  assert.match(en, /In-app installation is not enabled/u);
  assert.match(en, /aria-label="Close"/u);
});

test("Update disclosure keeps automatic checks independent and returns focus when closed", async () => {
  const [card, css] = await Promise.all([
    source("src/features/settings/DesktopUpdateCard.tsx"),
    source("src/features/settings/settings.css"),
  ]);
  assert.match(card, /if \(!active \|\| !automatic\) return;[\s\S]*?\}, \[active, automatic, version\]\);/u);
  assert.match(card, /hidden=\{!expanded\}/u);
  assert.match(card, /setExpanded\(false\);\s*triggerRef.current\?\.focus\(\)/u);
  assert.match(card, /event.key === "Escape"[^\n]*closePanel\(\)/u);
  assert.match(card, /setAutomatic\(!automatic\); desktopUpdateSession.setAutomatic\(!automatic\)/u);
  assert.match(card, /settings-update-dot/u);
  assert.match(css, /settings-update-panel\[hidden\]\s*\{\s*display: none;/u);
  assert.match(css, /settings-about-links-with-updates\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.match(css, /@container \(max-width: 720px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(css, /@container \(max-width: 380px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(css, /\.luckyray-settings-page \.toggle.on\s*\{\s*background: var\(--accent\);/u);
});

test("AI settings exposes DSH diagnostics and the independent production-backed search module", async () => {
  const html = await renderSettingsTab("ai");
  assert.match(html, /模型配置/);
  assert.match(html, /DeepSeek Harness 诊断/);
  assert.match(html, /class="setting-row setting-row-stack"><div class="setting-label">LightSeek 引擎更新/u);
  assert.match(html, /联网搜索模块/);
  assert.match(html, /当前尚未接入官方 DSH 对话/);
  assert.doesNotMatch(html, /启用 AI 功能|自动打标签|素材描述生成|AI 笔记助手|智能摘要/);
  assert.doesNotMatch(html, /使用量统计|今日调用|本月调用|累计 Tokens/);
});

test("AI settings no longer exposes the retired Agent startup acceleration choice", async () => {
  const html = await renderSettingsTab("ai");
  assert.doesNotMatch(html, /Agent 启动加速|后台准备 Agent|agent-engine-warm-runtime/);
});

test("Browser collection status moved from General to Community Collector without a duplicate Canvas entry", async () => {
  const html = await renderSettingsTab("general");
  assert.doesNotMatch(html, /浏览器收集服务|扩展连接状态仍以浏览器扩展自身为准/);
  const collector = await source("src/features/community/CollectorServiceStatus.tsx");
  assert.match(collector, /getCollectionServerBaseUrl/);
  assert.match(collector, /settings\.general\.collection\.service\.description/);
  assert.match(await source("src/features/community/CommunityPage.tsx"), /<CollectorServiceStatus \/>/);
  assert.doesNotMatch(html, /画布工作台|打开画布|Canvas 状态/);
});

test("settings does not present local backup export as multi-device sync", async () => {
  // renderSettingsTab temporarily supplies process-global browser storage, so keep
  // these projections serial to avoid one tab overwriting the other's fixture.
  const general = await renderSettingsTab("general");
  const storage = await renderSettingsTab("storage");
  assert.doesNotMatch(`${general}${storage}`, /配置多端数据同步|局域网同步|云同步|同步频率|冲突解决|上次同步：刚刚|立即同步/);
  assert.doesNotMatch(`${general}${storage}`, /<span>同步<\/span>/);
  assert.doesNotMatch(general, /立即备份/);
  assert.match(storage, /立即备份/);
});

test("General settings keeps real controls without duplicating the main Canvas navigation", async () => {
  const html = await renderSettingsTab("general");
  assert.match(html, /关闭窗口时|开机自启动|筛选下显示收集箱/);
  assert.doesNotMatch(html, /自动导入|Watch 文件夹|settings-auto-import|只扫描你在这里明确选择的目录/);
  assert.doesNotMatch(html, /启用系统托盘图标|剪贴板自动检测|启用 Native Messaging/);
  assert.doesNotMatch(html, /实验性|画布工作台|打开画布|正式画布 MVP/);
});

test("AI settings retires legacy grant and memory surfaces without deleting their authorities", async () => {
  const [html, page, css, workspaceService, memoryService, appBridge, bridgeAdapter, dshPage, dshSurface] = await Promise.all([
    renderSettingsTab("ai"),
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/settings/settings.css"),
    source("src/core/services/workspaceGrants.ts"),
    source("src/core/services/memory.ts"),
    source("src/App.tsx"),
    source("src/core/bridge/luckyRayBridge.ts"),
    source("src/features/ai/DshNativeSurfacePage.tsx"),
    source("src/core/services/dshNativeSurface.ts"),
  ]);

  assert.doesNotMatch(html, /权限与数据|全局工作区授权|记忆管理|授权文件夹|清空当前视图/);
  assert.doesNotMatch(page, /createWorkspaceGrantClient|WorkspaceGrant|createMemoryManagementSnapshotCoordinator|refreshAgentWorkspaceGrants|refreshMemories|memoryCoordinatorRef|settings-memory-manager/);
  assert.doesNotMatch(css, /\.settings-agent-grant|\.settings-memory-/u);

  assert.match(workspaceService, /agent_workspace_list/u);
  assert.match(workspaceService, /agent_workspace_add/u);
  assert.match(memoryService, /export async function listMemoryViewEntries/u);
  assert.match(memoryService, /export async function updateMemoryEntry/u);
  assert.match(appBridge, /async function listMemoryViews/u);
  assert.match(appBridge, /invoke<MemoryEntryView\[\]>\("agent_memory_list_view"/u);
  assert.match(appBridge, /async function deleteMemoryView/u);
  assert.match(appBridge, /invoke\("agent_memory_manage_delete"/u);
  assert.match(bridgeAdapter, /import type \{ LuckyRayBridge \} from "\.\/bridgeTypes"/u);
  assert.doesNotMatch(bridgeAdapter, /from "\.\.\/\.\.\/App"/u);
  assert.doesNotMatch(`${dshPage}\n${dshSurface}`, /WorkspaceGrant|workspaceGrant|agent_memory|agentMemory/u);
});

test("retired placeholder settings are absent while the language roadmap key remains", async () => {
  assert.equal(SETTINGS_DEFAULTS["general.language"], "zh-CN");
  for (const key of [
    "general.dateFormat",
    "general.trayIcon",
    "general.clipboard",
    "general.extension",
    "appearance.opacity",
    "ai.enabled",
    "ai.autoTag",
    "ai.autoCaption",
    "ai.noteAssistant",
    "ai.summary",
    "sync.lanEnabled",
    "sync.cloudEnabled",
    "sync.frequency",
    "storage.autoBackup",
    "storage.backupFrequency",
  ]) {
    assert.equal(Object.hasOwn(SETTINGS_DEFAULTS, key), false, key);
  }

  const general = await renderSettingsTab("general");
  const appearance = await renderSettingsTab("appearance");
  assert.doesNotMatch(general, /跟随系统/);
  assert.doesNotMatch(appearance, /窗口透明度/);
});

test("Storage does not offer an unimplemented app-data migration or overstate reset scope", async () => {
  const html = await renderSettingsTab("storage");
  assert.doesNotMatch(html, /选择新的 LuckyRay 数据目录|等待后续数据迁移|重置所有设置/);
  assert.match(html, /重置本地偏好/);
});

test("Storage describes the real app-owned backup and external Vault boundary", async () => {
  const html = await renderSettingsTab("storage");
  assert.match(html, /应用数据路径/);
  assert.match(html, /Canvas 与生成媒体/);
  assert.match(html, /外部 Vault 文件不会被复制/);
  assert.match(html, /清除应用内容/);
  assert.match(html, /不会删除外部 Vault/);
  assert.doesNotMatch(html, /所有素材、笔记和配置都存在这里|永久删除素材库、笔记、标签和配置/);
});
