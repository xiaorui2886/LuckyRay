import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the header owns one native button and keeps the existing state machine", async () => {
  const [header, sidebar] = await Promise.all([source("src/app/SidebarBrandHeader.tsx"), source("src/app/AppSidebar.tsx")]);
  assert.equal(header.match(/<button\b/g)?.length, 1);
  assert.match(header, /type="button"/);
  assert.match(header, /aria-expanded=\{!collapsed\}/);
  assert.match(header, /data-tauri-no-drag="true"/);
  assert.doesNotMatch(header, /onMouseEnter|onPointerEnter|setTimeout|localStorage/);
  assert.match(sidebar, /collapsed=\{effectiveCollapsed\}[\s\S]*?onToggle=\{toggle\}/);
  const footer = sidebar.slice(sidebar.indexOf('<div className="sidebar-footer">'), sidebar.indexOf('{managingLayout&&'));
  assert.doesNotMatch(footer, /onClick=\{toggle\}|SidebarBrandHeader/);
  assert.match(footer, /PhoneConnectionEntry/);
  assert.match(footer, /管理布局/);
  assert.match(sidebar, /const SIDEBAR_KEY = "luckyray-sidebar-collapsed-v1"/);
  assert.match(sidebar, /if \(compactAutoCollapsed\) \{\s*onCompactToggle\?\.\(\);\s*return;/);
});

test("collapsed branding reveals the existing expansion icon on hover and keyboard focus", async () => {
  const css = await source("src/app/appShell.css");
  assert.match(css, /\.sidebar-brand-toggle \.sidebar-brand-toggle-icon\s*\{\s*width: 20px;\s*height: 20px;/);
  assert.match(css, /\.sidebar-header\[data-collapsed="true"\] \.sidebar-brand-toggle\s*\{\s*flex-basis: 44px;\s*width: 44px;\s*height: 44px;/);
  assert.match(css, /\.sidebar-brand-toggle:is\(:hover, :focus-visible\) \.sidebar-toggle-brand\s*\{\s*opacity: 0;/);
  assert.match(css, /\.sidebar-brand-toggle:is\(:hover, :focus-visible\) \.sidebar-brand-toggle-icon\s*\{\s*opacity: 1;/);
  assert.match(css, /\.sidebar-brand-toggle:focus-visible\s*\{\s*outline: 2px solid var\(--accent\);/);
  assert.match(css, /\.sidebar-header \.logo-text\s*\{\s*flex: 1 1 auto;\s*min-width: 0;\s*text-overflow: ellipsis;/);
});

test("automatic restore and reduced motion override even the collapsed logo transition", async () => {
  const css = await source("src/app/appShell.css");
  assert.match(css, /\[data-sidebar-motion="automatic"\] \.sidebar-header :is\(\.sidebar-brand-toggle, \.sidebar-toggle-brand, \.sidebar-brand-toggle-icon\)\s*\{\s*transition: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.react-nav-shell \.sidebar-header\[data-collapsed\] :is\(\.sidebar-brand-toggle, \.sidebar-toggle-brand, \.sidebar-brand-toggle-icon\)\s*\{\s*transition: none;/);
});
