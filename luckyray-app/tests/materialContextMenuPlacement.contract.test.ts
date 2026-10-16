import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateContextMenuPosition } from "../src/features/materials/materialContextMenuPlacement.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("calculateContextMenuPosition places menu below-right when within viewport", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 100,
    anchorY: 100,
    menuWidth: 200,
    menuHeight: 300,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });
  assert.equal(pos.x, 100);
  assert.equal(pos.y, 100);
});

test("calculateContextMenuPosition flips menu above when overflowing bottom", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 100,
    anchorY: 600,
    menuWidth: 200,
    menuHeight: 300,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });
  // 600 + 300 = 900 > 760 (768-8) -> flip above: 600 - 300 = 300
  assert.equal(pos.x, 100);
  assert.equal(pos.y, 300);
});

test("calculateContextMenuPosition flips menu to left when overflowing right", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 900,
    anchorY: 100,
    menuWidth: 200,
    menuHeight: 300,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });
  // 900 + 200 = 1100 > 1016 (1024-8) -> flip left: 900 - 200 = 700
  assert.equal(pos.x, 700);
  assert.equal(pos.y, 100);
});

test("calculateContextMenuPosition flips both axes near bottom-right corner", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 950,
    anchorY: 700,
    menuWidth: 200,
    menuHeight: 300,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });
  assert.equal(pos.x, 750);
  assert.equal(pos.y, 400);
});

test("calculateContextMenuPosition clamps to 8px margin when anchor is near viewport edges", () => {
  const posLeftTop = calculateContextMenuPosition({
    anchorX: 2,
    anchorY: 4,
    menuWidth: 200,
    menuHeight: 300,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });
  assert.equal(posLeftTop.x, 8);
  assert.equal(posLeftTop.y, 8);
});

test("calculateContextMenuPosition bounds maxHeight and allows internal scroll when viewport is smaller than menu", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 100,
    anchorY: 200,
    menuWidth: 200,
    menuHeight: 600,
    viewportWidth: 800,
    viewportHeight: 500,
    margin: 8,
  });
  // 500 - 16 = 484
  assert.equal(pos.y, 8);
  assert.equal(pos.maxHeight, 484);
});

test("MaterialsPage presentation uses dynamic measurement instead of hard-coded menuHeight = 450", async () => {
  const [materialsPage, materialsCss] = await Promise.all([
    source("src/features/materials/MaterialsPage.tsx"),
    source("src/features/materials/materials.css"),
  ]);

  // Hardcoded constant must be removed
  assert.doesNotMatch(materialsPage, /menuHeight\s*=\s*450/);
  assert.doesNotMatch(materialsPage, /menuWidth\s*=\s*190/);

  // Dynamic calculation and layout effect measurement must be present
  assert.match(materialsPage, /calculateContextMenuPosition/);
  const contextMenuComponent = materialsPage.slice(
    materialsPage.indexOf("function AssetContextMenu"),
    materialsPage.indexOf("function MaterialViewer"),
  );
  assert.match(contextMenuComponent, /useLayoutEffect/);
  assert.match(contextMenuComponent, /offsetWidth/);
  assert.match(contextMenuComponent, /offsetHeight/);
  assert.doesNotMatch(contextMenuComponent, /getBoundingClientRect/);

  // CSS must enforce bounded height and scrollable overflow
  assert.match(materialsCss, /\.asset-ctx-react\s*\{[^}]*max-height:\s*calc\(100(?:dvh|vh)\s*-\s*16px\)/s);
  assert.match(materialsCss, /\.asset-ctx-react\s*\{[^}]*overflow-y:\s*auto/s);
});

test("final scale=1 context-menu layout remains inside the right and bottom 8px margins", () => {
  const pos = calculateContextMenuPosition({
    anchorX: 1000,
    anchorY: 750,
    menuWidth: 220,
    menuHeight: 420,
    viewportWidth: 1024,
    viewportHeight: 768,
    margin: 8,
  });

  assert.ok(pos.x >= 8);
  assert.ok(pos.y >= 8);
  assert.ok(pos.x + 220 <= 1024 - 8);
  assert.ok(pos.y + 420 <= 768 - 8);
});

test("Materials context menu adds image compare to the root and preserves every leaf action exactly once", async () => {
  const materialsPage = await source("src/features/materials/MaterialsPage.tsx");
  const ctxMenuIndex = materialsPage.indexOf("function AssetContextMenu");
  assert.ok(ctxMenuIndex > 0, "AssetContextMenu component must exist");
  const ctxBody = materialsPage.slice(ctxMenuIndex, materialsPage.indexOf("function MaterialViewer", ctxMenuIndex));
  const actionsStart = ctxBody.indexOf("const actions:");
  const actionsEnd = ctxBody.indexOf("const organizeActions", actionsStart);
  const actionsBlock = ctxBody.slice(actionsStart, actionsEnd);
  const leafIds = [...actionsBlock.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  const expectedLeafIds = [
    "open", "preview", "compare", "addTag", "move", "reveal", "rename", "renameFile",
    "graph", "insertNote", "linkNote", "sendLightSeek", "favorite", "copy", "export", "delete",
  ];
  assert.deepEqual(leafIds, expectedLeafIds);
  assert.equal(new Set(leafIds).size, expectedLeafIds.length, "leaf actions must not be duplicated");

  const rootStart = ctxBody.indexOf('data-material-context-root="true"');
  const rootEnd = ctxBody.indexOf("{submenu &&", rootStart);
  const rootMarkup = ctxBody.slice(rootStart, rootEnd);
  const rootEntries = [...rootMarkup.matchAll(/renderAction\(actions\.([A-Za-z]+), "main"\)|submenuId="([^"]+)"/g)]
    .map((match) => match[1] || match[2]);
  assert.deepEqual(rootEntries, ["open", "preview", "compare", "organize", "create", "favorite", "copy", "export", "delete"]);

  const normalized = ctxBody.replace(/\s+/g, " ");
  assert.ok(normalized.includes("const organizeActions = [ actions.addTag, actions.move, actions.reveal, actions.rename,"));
  assert.ok(normalized.includes("...(canRenameRealAssetFile(state.asset) ? [actions.renameFile] : []),"));
  assert.ok(normalized.includes("const createActions = [actions.graph, actions.insertNote, actions.linkNote, actions.sendLightSeek];"));
});

test("Materials context menu leaf handlers retain their existing authority identity", async () => {
  const materialsPage = await source("src/features/materials/MaterialsPage.tsx");
  const start = materialsPage.indexOf("const actions:");
  const end = materialsPage.indexOf("const organizeActions", start);
  const actionDefinitions = materialsPage.slice(start, end).replace(/\s+/g, " ");
  const handlerIdentity: Record<string, string> = {
    open: "onOpen",
    preview: "onPreview",
    compare: "onCompare",
    addTag: "onTags",
    move: "onMove",
    reveal: "onRevealFolder",
    rename: "onRename",
    renameFile: "onRenameFile",
    graph: "onShowInGraph",
    insertNote: "onInsertToNote",
    linkNote: "onLinkNote",
    sendLightSeek: "onAskAi",
    favorite: "onToggleFavorite",
    copy: "onCopy",
    export: "onExport",
    delete: "onDelete",
  };

  const entries = [...actionDefinitions.matchAll(/(?:^| )([A-Za-z]+): \{(?:(?! [A-Za-z]+: \{).)*?id: "([^"]+)"(?:(?! [A-Za-z]+: \{).)*?onSelect: ([A-Za-z]+)/g)];
  const actual = Object.fromEntries(entries.map((match) => [match[2], match[3]]));
  assert.deepEqual(actual, handlerIdentity);
  assert.doesNotMatch(actionDefinitions, /copy: \{[^}]*shortcut: "Ctrl\+C"/, "Copy must not advertise a shortcut that Materials does not register");
});

test("Materials context menu supports submenu ARIA, layered keyboard navigation, and focus restoration", async () => {
  const materialsPage = await source("src/features/materials/MaterialsPage.tsx");
  const start = materialsPage.indexOf("type MaterialContextSubmenuId");
  const end = materialsPage.indexOf("function MaterialViewer", start);
  const ctxBody = materialsPage.slice(start, end);

  assert.match(ctxBody, /role="menu"/);
  assert.match(ctxBody, /role="menuitem"/);
  assert.match(ctxBody, /aria-haspopup="menu"/);
  assert.match(ctxBody, /aria-expanded=\{expanded\}/);
  assert.match(ctxBody, /aria-controls=\{`materials-context-\$\{submenuId\}-submenu`\}/);
  for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Escape", "Tab"]) {
    assert.match(ctxBody, new RegExp(`event\\.key (?:===|===? \\\"|[^\\n]*includes)[^\\n]*${key}|\\[\\\"ArrowDown\\\"[^\\n]*${key}`), `${key} contract must remain present`);
  }
  assert.match(materialsPage, /contextMenu\.trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(ctxBody, /state\.trigger\.focus\(\{ preventScroll: true \}\)[\s\S]*action\.onSelect\(state\.asset\)/);
  assert.match(ctxBody, /target\.click\(\)/);
  assert.match(ctxBody, /data-material-context-level=\{level\}[\s\S]*tabIndex=\{-1\}/);
  assert.equal((materialsPage.match(/data-native-material-drag-source="true"[\s\S]{0,120}tabIndex=\{0\}/g) || []).length, 3);
  assert.equal((ctxBody.match(/window\.setTimeout\(\(\) => onClose\(false\), 0\)/g) || []).length, 2);
  assert.match(ctxBody, /onPointerEnter=\{\(\) => onOpen\(submenuId, false\)\}/);
  assert.match(ctxBody, /onClick=\{\(\) => onOpen\(submenuId, true\)\}/);
});

test("Materials context menu keeps offset measurement, two-axis submenu flipping, and all three view triggers", async () => {
  const materialsPage = await source("src/features/materials/MaterialsPage.tsx");
  const start = materialsPage.indexOf("function AssetContextMenu");
  const end = materialsPage.indexOf("function MaterialViewer", start);
  const ctxBody = materialsPage.slice(start, end);
  assert.match(ctxBody, /const gap = 0/);
  assert.match(ctxBody, /const rightX = parentLeft \+ parent\.offsetWidth \+ gap/);
  assert.match(ctxBody, /const leftX = parentLeft - width - gap/);
  assert.match(ctxBody, /preferredY \+ height > window\.innerHeight - margin/);
  assert.match(ctxBody, /triggerBottom - height \+ 5/);
  assert.match(ctxBody, /offsetWidth/);
  assert.match(ctxBody, /offsetHeight/);
  assert.doesNotMatch(ctxBody, /getBoundingClientRect/);

  const viewCards = materialsPage.slice(materialsPage.indexOf("function AssetCard"), materialsPage.indexOf("function BatchCheckbox"));
  assert.equal((viewCards.match(/onContextMenu=\{/g) || []).length, 3);
  assert.equal((viewCards.match(/aria-haspopup="menu"/g) || []).length, 3);
});

test("Materials context menu appearance follows the Experience Lab material-menu tokens", async () => {
  const materialsCss = await source("src/features/materials/materials.css");
  const start = materialsCss.indexOf(".asset-ctx-react {");
  const end = materialsCss.indexOf("/* 素材沉浸式查看器", start);
  const contextCss = materialsCss.slice(start, end);

  assert.match(contextCss, /width:\s*min\(232px, calc\(100vw - 16px\)\)/);
  assert.match(contextCss, /padding:\s*5px/);
  assert.match(contextCss, /border-radius:\s*15px/);
  assert.match(contextCss, /min-height:\s*32px/);
  assert.match(contextCss, /grid-template-columns:\s*16px minmax\(0, 1fr\) auto/);
  assert.match(contextCss, /gap:\s*8px/);
  assert.match(contextCss, /\.asset-ctx-react-submenu\s*\{[^}]*218px/s);
  assert.match(contextCss, /0 18px 48px[\s\S]*0 2px 8px/);
  assert.match(contextCss, /var\(--border-subtle\)/);
  assert.match(contextCss, /var\(--bg-elevated\)/);
  assert.match(contextCss, /var\(--accent\)/);
  assert.match(contextCss, /\.react-nav-shell \.asset-ctx-react-item\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-size:\s*12px/s);
  assert.match(contextCss, /\.asset-ctx-react-item:focus-visible/);
  assert.match(contextCss, /\.asset-ctx-react-item:disabled/);
  assert.match(contextCss, /\.asset-ctx-react-item\.danger/);
  assert.match(contextCss, /prefers-reduced-motion: reduce/);
  assert.match(contextCss, /data-animations="off"/);
  assert.doesNotMatch(contextCss, /rgba\(148,\s*153,\s*166/);
});
