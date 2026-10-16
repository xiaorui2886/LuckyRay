import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SHORTCUT_COMMANDS,
  findShortcutConflicts,
  resolveScopedShortcut,
  type ShortcutCommandId,
  type ShortcutScope,
} from "../src/app/shortcuts.ts";
import { editorEnUS, editorZhCN } from "../src/core/i18n/editorMessages.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const HEAVY_EDITOR_SURFACES = [
  "src/features/notes/NotesPage.tsx",
  "src/CanvasSpike.tsx",
  "src/features/graph/GraphPage.tsx",
] as const;

function keyboardEvent(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    ...init,
  } as KeyboardEvent;
}

test("heavy editor surfaces consume the one B1 i18n authority", async () => {
  for (const path of HEAVY_EDITOR_SURFACES) {
    const text = await source(path);
    assert.match(text, /useI18n|useMessages/, `${path} must use the B1 provider`);
  }
});

test("heavy editor catalogs keep exact zh/en key parity", () => {
  assert.deepEqual(Object.keys(editorZhCN).sort(), Object.keys(editorEnUS).sort());
  assert.ok(Object.keys(editorZhCN).some((key) => key.startsWith("editor.notes.")));
  assert.ok(Object.keys(editorZhCN).some((key) => key.startsWith("editor.canvas.")));
  assert.ok(Object.keys(editorZhCN).some((key) => key.startsWith("editor.graph.")));
});

test("heavy editor presentation boundaries do not bypass semantic messages", async () => {
  const [notesRaw, canvasRaw, graphRaw] = await Promise.all(HEAVY_EDITOR_SURFACES.map(source));
  const withoutBlockComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
  const notes = withoutBlockComments(notesRaw);
  const canvas = withoutBlockComments(canvasRaw);
  const graph = withoutBlockComments(graphRaw);
  const visibleLiteral = />\s*[\u3400-\u9fff]|(?:title|aria-label|placeholder)="[^"]*[\u3400-\u9fff]/;
  assert.doesNotMatch(notes, visibleLiteral);
  assert.doesNotMatch(canvas, visibleLiteral);
  assert.doesNotMatch(graph, visibleLiteral);
  assert.doesNotMatch(notes, /setStatus\([^\n]*[\u3400-\u9fff]/);
  assert.doesNotMatch(canvas, /set(?:ErrorMsg|SaveError)\([^\n]*[\u3400-\u9fff]/);
  assert.doesNotMatch(graph, /showNotice\([^\n]*[\u3400-\u9fff]/);
  assert.doesNotMatch(notes, /"(?:未命名笔记|新标签页)"|toLocaleDateString\("zh-CN"/u);
  assert.match(notes, /shortDate\(item\.updatedAt, locale\)/u);
  assert.doesNotMatch(notes, /patch\.title \|\| "未命名文档"/u);
  assert.doesNotMatch(notes, /第 \$\{[^}]+\} 行|当前笔记|\$\{[^}]+\} 笔记|链接标题|已插入外部链接/u);
  assert.doesNotMatch(notes, /(?:path:|setStatus\(|setVaultSwitchError\(|activateRealVault\()[^\n]*(?:仓库根目录|未分类|个重名文件|个文件失败|个项目失败|知识库已移动|切换知识库失败|真实仓库已建立|真实仓库已打开)/u);
  const tableStatusHelper = notes.match(/function tableCommandStatusKey[\s\S]*?\n\}/u)?.[0] || "";
  const assetKindHelper = notes.match(/function assetKindLabel[\s\S]*?\n\}/u)?.[0] || "";
  assert.doesNotMatch(tableStatusHelper, /[\u3400-\u9fff]/u);
  assert.doesNotMatch(assetKindHelper, /[\u3400-\u9fff]/u);
  assert.doesNotMatch(canvas, /"(?:未命名图片|未命名视频)"/u);
  assert.doesNotMatch(canvas, /asset\.name \|\| "\(无标题素材\)"|note\.title \|\| "\(无标题笔记\)"/u);
  assert.doesNotMatch(canvas, /createCanvas\("(?:从 spike 导入|默认画布)"\)/u);
  assert.doesNotMatch(canvas, /setStorageCheckError\([^\n]*[\u3400-\u9fff]|message:\s*"上次生成/u);
  assert.match(canvas, /label: mediaKind === "video" \? t\("editor\.canvas\.node\.videoGenerate"\) : t\("editor\.canvas\.node\.imageGenerate"\)/u);
});

test("escaped editor presentation copy cannot bypass the semantic message boundary", async () => {
  const [notesRaw, canvasRaw, graphRaw] = await Promise.all(HEAVY_EDITOR_SURFACES.map(source));
  const decodeEscapes = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const notes = decodeEscapes(notesRaw);
  const canvas = decodeEscapes(canvasRaw);
  const graph = decodeEscapes(graphRaw);

  assert.doesNotMatch(notes, /请先打开真实仓库|已复制绝对路径|正在检查素材|AI 标签已应用|目标文档属于另一个知识库|请先建立或打开目标知识库|文档导航身份无效/u);
  assert.doesNotMatch(notes, /(?:folderPath|meta):[^\n]*知识库\//u);
  assert.doesNotMatch(canvas, /generationPrompt:[^\n]*(?:请根据引用素材编辑视频|请根据引用素材编辑图片|请根据引用素材生成脚本)/u);
  assert.doesNotMatch(canvas, /return\s+(?:"当前环境不支持真实 AI 调用"|`AI 请求失败|"AI 没有返回内容")/u);
  assert.doesNotMatch(graph, /throw new Error\("(?:当前知识库已经切换|文件创建后无法读回|知识库在创建期间发生切换|文件已创建，但知识索引尚未识别)/u);
});

test("shortcut registry is typed, scoped, and contains only commands with production owners", () => {
  const scopes = new Set<ShortcutScope>();
  const ids = new Set<string>();
  for (const command of SHORTCUT_COMMANDS) {
    assert.equal(ids.has(command.id), false, `duplicate shortcut id ${command.id}`);
    ids.add(command.id);
    scopes.add(command.scope);
    assert.ok(command.defaultValue);
    assert.ok(command.nameKey.startsWith("settings.shortcuts.name."));
    assert.ok(command.descriptionKey.startsWith("settings.shortcuts.description."));
    assert.ok(command.owner.length > 0);
  }
  assert.deepEqual([...scopes].sort(), ["canvas", "global", "graph", "knowledge", "materials"]);
  assert.ok(ids.has("materialsQuickPreview"));
  assert.ok(ids.has("knowledgeSave"));
  assert.ok(ids.has("canvasSave"));
  assert.ok(ids.has("graphCloseFloating"));
  assert.ok(ids.has("openSettings"));
  assert.ok(ids.has("navigateBack"));
  assert.ok(ids.has("navigateForward"));
});

test("scoped resolution retires inactive routes and gives global commands priority", () => {
  const values = Object.fromEntries(SHORTCUT_COMMANDS.map((item) => [item.id, item.defaultValue])) as Record<ShortcutCommandId, string>;
  assert.equal(resolveScopedShortcut(keyboardEvent(" "), "materials", values), "materialsQuickPreview");
  assert.equal(resolveScopedShortcut(keyboardEvent(" "), "knowledge", values), null);
  assert.equal(resolveScopedShortcut(keyboardEvent("k", { ctrlKey: true }), "materials", values), "globalSearch");
});

test("focused search mode shortcut never becomes an application-wide Tab binding", () => {
  const command = SHORTCUT_COMMANDS.find(item => item.id === "searchModeToggle");
  assert.equal(command?.defaultValue, "Tab");
  assert.equal(command?.focusedInputOnly, true);
  assert.equal(resolveScopedShortcut(keyboardEvent("Tab"), "materials", { searchModeToggle: "Tab" }), null);
  assert.equal(resolveScopedShortcut(keyboardEvent("m", { altKey: true }), "knowledge", { searchModeToggle: "Alt+M" }), null);
  assert.equal(findShortcutConflicts([{id: "searchModeToggle", value: "Ctrl+K"}, {id: "globalSearch", value: "Ctrl+K"}]).length, 1);
});

test("text entry, select, contenteditable, IME, and modal boundaries fail closed", () => {
  const values = Object.fromEntries(SHORTCUT_COMMANDS.map((item) => [item.id, item.defaultValue])) as Record<ShortcutCommandId, string>;
  const input = { tagName: "INPUT", isContentEditable: false } as HTMLElement;
  assert.equal(resolveScopedShortcut(keyboardEvent("i", { ctrlKey: true, target: input }), "materials", values), null);
  assert.equal(resolveScopedShortcut(keyboardEvent(" ", { isComposing: true }), "materials", values), null);
  assert.equal(resolveScopedShortcut(keyboardEvent(" "), "materials", values, { modalOpen: true }), null);
  assert.equal(resolveScopedShortcut(keyboardEvent("s", { ctrlKey: true, target: input }), "knowledge", values), "knowledgeSave");

  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: () => ({}) },
  });
  try {
    assert.equal(resolveScopedShortcut(keyboardEvent(" "), "materials", values), null);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});

test("conflicts block same-scope and global collisions but allow disjoint route reuse", () => {
  assert.deepEqual(findShortcutConflicts([
    { id: "materialsImport", value: "Ctrl+I" },
    { id: "materialsToggleFilter", value: "Ctrl+I" },
  ]).map((item) => item.kind), ["same-scope"]);
  assert.deepEqual(findShortcutConflicts([
    { id: "globalSearch", value: "Ctrl+K" },
    { id: "materialsToggleFilter", value: "Ctrl+K" },
  ]).map((item) => item.kind), ["global-route"]);
  assert.deepEqual(findShortcutConflicts([
    { id: "materialsImport", value: "Ctrl+I" },
    { id: "knowledgeItalic", value: "Ctrl+I" },
  ]), []);
  assert.deepEqual(findShortcutConflicts([
    { id: "materialsImport", value: "Ctrl+I" },
    { id: "materialsToggleFilter", value: "Meta+I" },
  ]).map((item) => item.kind), ["same-scope"]);
  assert.equal(resolveScopedShortcut(keyboardEvent("i", { metaKey: true }), "materials", {
    materialsImport: "Ctrl+Meta+I",
  }), null);
});

test("settings projects five accessible scope tabs and keeps the one existing storage authority", async () => {
  const [page, settings, shortcuts, styles] = await Promise.all([
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/settings/useSettings.ts"),
    source("src/app/shortcuts.ts"),
    source("src/features/settings/settings.css"),
  ]);
  assert.match(page, /SHORTCUT_SCOPE_ORDER/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /activeScopeShortcuts\.map/);
  assert.doesNotMatch(page, /settings-shortcut-scope-count/);
  assert.match(page, /findShortcutConflicts/);
  assert.match(settings, /luckyray-settings-v1-shortcuts/);
  assert.doesNotMatch(shortcuts, /localStorage\.setItem\([^)]*luckyray-settings-v1-shortcuts/);
  assert.match(styles, /\.settings-col-name\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*gap:/su);
  assert.match(page, /event\.ctrlKey && event\.metaKey[\s\S]*settings\.status\.shortcutMixedModifiers/u);
});

test("every real Materials modal participates in the shared DOM guard", async () => {
  const materials = await source("src/features/materials/MaterialsPage.tsx");
  const modalBoxes = [...materials.matchAll(/<div className="modal-box-react[^"]*"([^>]*)>/gu)];
  assert.equal(modalBoxes.length, 7);
  for (const [, attributes] of modalBoxes) {
    assert.match(attributes, /role="dialog"/u);
    assert.match(attributes, /aria-modal="true"/u);
  }
});

test("production handlers resolve through the shared scoped authority", async () => {
  const [shell, materials, notes, canvas, graph] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/notes/NotesPage.tsx"),
    source("src/CanvasSpike.tsx"),
    source("src/features/graph/GraphPage.tsx"),
  ]);
  assert.match(shell, /resolveScopedShortcut/);
  assert.match(materials, /resolveScopedShortcut/);
  assert.match(notes, /resolveScopedShortcut/);
  assert.match(canvas, /resolveScopedShortcut/);
  assert.match(graph, /resolveScopedShortcut/);
  assert.doesNotMatch(shell, /event\.key === ","/);
  assert.doesNotMatch(shell, /event\.key === "Arrow(?:Left|Right)"/);
  assert.doesNotMatch(notes, /Ctrl \+ O/);
});
