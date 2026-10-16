import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("window chrome assigns exactly one gesture owner and excludes interactive controls", async () => {
  const { resolveWindowChromeInteraction } = await import("../src/app/windowChromePolicy");

  assert.deepEqual(resolveWindowChromeInteraction("surface"), { gestureOwner: "native", draggable: true, selectable: false });
  assert.deepEqual(resolveWindowChromeInteraction("label"), { gestureOwner: "native", draggable: true, selectable: false });
  for (const target of ["button", "input", "textarea", "select", "tab", "link", "contenteditable"] as const) {
    const policy = resolveWindowChromeInteraction(target);
    assert.equal(policy.gestureOwner, "interactive");
    assert.equal(policy.draggable, false);
  }
  assert.equal(resolveWindowChromeInteraction("input").selectable, true);
  assert.equal(resolveWindowChromeInteraction("contenteditable").selectable, true);
});

test("the titlebar uses native drag/maximize once and does not also call startDragging", async () => {
  const sidebar = await source("src/app/AppSidebar.tsx");
  const titlebar = sidebar.slice(sidebar.indexOf("id=\"app-titlebar\""), sidebar.indexOf("function routeName("));

  assert.match(titlebar, /data-tauri-drag-region="true"/);
  assert.doesNotMatch(sidebar, /startTitlebarWindowDrag|startDragging\(/);
  assert.doesNotMatch(titlebar, /onDoubleClick|toggleMaximizeWindow/);
  assert.match(titlebar, /data-tauri-no-drag="true"/);
  assert.match(sidebar, /className="win-btn win-maximize"[\s\S]*runWindowAction\("toggleMaximize"\)/u);
});

test("drag coverage includes noninteractive chrome while text selection remains editor-safe", async () => {
  const [sidebar, css] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/app/appShell.css"),
  ]);

  assert.match(sidebar, /className="titlebar-left"[^>]*data-tauri-drag-region="true"/);
  assert.match(sidebar, /className="titlebar-breadcrumb"[^>]*data-tauri-drag-region="true"/);
  assert.match(sidebar, /className="breadcrumb-item current"[^>]*data-tauri-drag-region="true"/);
  assert.match(css, /\.react-nav-shell \.titlebar[\s\S]*user-select:\s*none;/u);
  assert.match(css, /\.react-nav-shell \.titlebar :is\(input, textarea, select, \[contenteditable="true"\]\)[\s\S]*user-select:\s*text;/u);
  assert.doesNotMatch(css, /\.react-nav-shell \*\s*\{[^}]*user-select:\s*none;/s);
});

test("every route keeps search and window controls on the materials trailing geometry", async () => {
  const [sidebar, css] = await Promise.all([
    source("src/app/AppSidebar.tsx"),
    source("src/app/appShell.css"),
  ]);

  assert.doesNotMatch(sidebar, /marginLeft:\s*isMaterials\s*\?/u);
  assert.match(css, /\.react-nav-shell \.titlebar\s*\{[^}]*--titlebar-inline-start:\s*14px;[^}]*--titlebar-inline-end:\s*14px;[^}]*padding-inline:\s*var\(--titlebar-inline-start\) var\(--titlebar-inline-end\);/s);
  assert.match(css, /\.react-nav-shell \.titlebar-right\s*\{[^}]*margin-left:\s*auto;[^}]*flex:\s*0 0 auto;/s);
  assert.match(css, /\.titlebar\.graph-titlebar-split \.titlebar-right\s*\{[^}]*right:\s*var\(--titlebar-inline-end\);/s);
  assert.match(css, /\.titlebar\.notes-titlebar-split \.titlebar-right\s*\{[^}]*right:\s*var\(--titlebar-inline-end\);/s);
  assert.match(css, /@media \(max-width:\s*1440px\)[\s\S]*?\.react-nav-shell \.titlebar\s*\{[^}]*--titlebar-inline-end:\s*10px;/u);
  assert.match(css, /@media \(max-width:\s*1440px\)[\s\S]*?\.materials-titlebar\s*\{[^}]*--titlebar-inline-start:\s*10px;/u);
  assert.doesNotMatch(css, /@media \(max-width:\s*1440px\)[\s\S]*?\.materials-titlebar\s*\{[^}]*padding-inline:/u);
  assert.match(css, /@media \(max-width:\s*1280px\)[\s\S]*?\.react-nav-shell \.titlebar-right\s*\{[^}]*gap:\s*3px;/u);
});
