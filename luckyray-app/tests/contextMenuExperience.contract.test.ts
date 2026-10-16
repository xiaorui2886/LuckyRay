import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateContextMenuPlacement } from "../src/components/contextMenuPlacement.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("shared context-menu placement flips on both axes and preserves the 8px viewport fence", () => {
  assert.deepEqual(calculateContextMenuPlacement({
    anchorX: 950,
    anchorY: 700,
    menuWidth: 232,
    menuHeight: 320,
    viewportWidth: 1024,
    viewportHeight: 768,
  }), { x: 718, y: 380, maxHeight: undefined });

  assert.deepEqual(calculateContextMenuPlacement({
    anchorX: 2,
    anchorY: 4,
    menuWidth: 232,
    menuHeight: 900,
    viewportWidth: 1024,
    viewportHeight: 640,
  }), { x: 8, y: 8, maxHeight: 624 });
});

test("shared surface owns only presentation keyboard and measured placement", async () => {
  const shared = await source("src/components/ContextMenuSurface.tsx");
  for (const token of [
    'role="menu"',
    'event.key === "Escape"',
    'event.key === "Enter"',
    'event.key === " "',
    'event.key === "Tab"',
    'event.key === "ArrowDown"',
    'event.key === "ArrowUp"',
    'event.key === "Home"',
    'event.key === "End"',
    "menu.offsetWidth",
    "menu.scrollHeight",
    "ResizeObserver",
    "returnFocusTo.focus",
    "scrollIntoView",
  ]) assert.match(shared, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(shared, /createContext|useContext|store|router|dispatch\(/i);
});

test("tag detail keeps its four real actions as a single-level menu", async () => {
  const tags = await source("src/features/tags/TagDetail.tsx");
  const start = tags.indexOf("{menu && (");
  const end = tags.indexOf("{previewItem &&", start);
  const menu = tags.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const action of ["action.open", "action.preview", "action.unselect", "action.select", "action.remove"]) {
    assert.match(menu, new RegExp(action.replace(".", "\\.")));
  }
  assert.equal((menu.match(/<TagDetailContextItem/g) || []).length, 4);
  assert.equal((menu.match(/tag-detail-context-separator/g) || []).length, 2);
  assert.doesNotMatch(menu, /submenu|aria-haspopup/i);
  assert.match(menu, /label=\{t\("action\.remove"\)\}[\s\S]*?danger/);
  assert.match(tags, /danger \? " danger"/);
  const css = await source("src/features/tags/tags.css");
  assert.match(css, /\.tag-detail-context-item\.danger/);
  assert.match(menu, /shortcut="Enter"/);
  assert.match(menu, /shortcut="Space"/);
});

test("tag detail preserves measured pointer placement and adds keyboard semantics without another menu authority", async () => {
  const tags = await source("src/features/tags/TagDetail.tsx");
  assert.match(tags, /createPortal\(/);
  assert.match(tags, /menuWidth: menu\.offsetWidth/);
  assert.match(tags, /menuHeight: menu\.scrollHeight/);
  assert.match(tags, /calculateContextMenuPlacement\(/);
  assert.match(tags, /role="menu"/);
  assert.match(tags, /role="menuitem"/);
  assert.match(tags, /event\.key === "ArrowDown"/);
  assert.match(tags, /event\.key === "ArrowUp"/);
  assert.match(tags, /event\.key === "Home"/);
  assert.match(tags, /event\.key === "End"/);
  assert.match(tags, /contextMenuTriggerRef\.current = event\.currentTarget/);
  assert.match(tags, /className="tag-detail-card" tabIndex=\{0\} aria-haspopup="menu"/);
  assert.match(tags, /returnFocusTo\.focus\(\{ preventScroll: true \}\)/);

  const css = await source("src/features/tags/tags.css");
  assert.match(css, /\.tag-detail-context-menu[\s\S]*width: min\(212px/);
  assert.match(css, /\.tag-detail-context-menu[\s\S]*font-size: 11px/);
  assert.match(css, /\.tag-detail-context-item[\s\S]*min-height: 30px/);
  assert.match(css, /color: var\(--text-secondary\)/);
  assert.match(css, /var\(--border-subtle\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
