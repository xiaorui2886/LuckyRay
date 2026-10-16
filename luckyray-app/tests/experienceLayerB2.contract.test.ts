import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const themeIds = [
  "dark",
  "light",
  "ivory-editorial",
  "rose-tea",
  "github-dark",
  "white-zero",
  "bangladesh-green",
  "lilac-milk",
  "blue-whisper",
] as const;

const semanticTokens = [
  "--theme-app-bg",
  "--theme-sidebar-bg",
  "--theme-titlebar-bg",
  "--theme-surface-base",
  "--theme-surface-raised",
  "--theme-surface-panel",
  "--theme-card-bg",
  "--theme-border-subtle",
  "--theme-border-strong",
  "--theme-dialog-border",
  "--theme-hover",
  "--theme-selected",
  "--theme-overlay",
  "--theme-text-muted",
  "--theme-shadow-md",
  "--theme-glass-bg",
  "--theme-glass-filter",
  "--theme-canvas-workspace",
  "--theme-canvas-grid",
] as const;

test("all nine themes expose the complete shared semantic hierarchy", async () => {
  const css = await source("src/core/theme/themeTokens.css");
  for (const themeId of themeIds) {
    const marker = themeId === "dark" ? ":root," : `:root[data-theme="${themeId}"]`;
    const start = css.indexOf(marker);
    assert.ok(start >= 0, `${themeId} has a theme block`);
    const end = css.indexOf("\n}\n", start);
    const block = css.slice(start, end);
    for (const token of semanticTokens) assert.match(block, new RegExp(`${token}:`), `${themeId} defines ${token}`);
  }
});

test("startup prepaint reads only the existing settings authority before theme CSS and disables first-frame transitions", async () => {
  const [html, css, main, appCss] = await Promise.all([
    source("index.html"),
    source("src/core/theme/themeTokens.css"),
    source("src/main.tsx"),
    source("src/App.css"),
  ]);
  const scriptAt = html.indexOf("luckyray-settings-v1");
  const themeCssAt = html.indexOf("themeTokens.css");
  assert.ok(scriptAt >= 0 && themeCssAt > scriptAt);
  assert.match(html, /dark.*light.*ivory-editorial.*rose-tea.*github-dark.*white-zero.*bangladesh-green.*lilac-milk.*blue-whisper/s);
  assert.match(css, /data-theme-ready="false"/);
  assert.match(css, /transition:\s*none\s*!important/);
  assert.match(main, /applyGlobalSettings\(readSavedSettings\(\)\)/);
  assert.match(main, /dataset\.themeReady\s*=\s*"true"/);
  assert.doesNotMatch(main, /document\.body\.style\.background\s*=\s*"#0a0a0c"/);
  assert.match(appCss, /background:\s*var\(--theme-app-bg\)/);
  assert.doesNotMatch(appCss, /#0a0a0c/);
});

test("shell hierarchy, route loading, and dialogs consume semantic theme authority", async () => {
  const [shellComponent, shell, experience] = await Promise.all([
    source("src/app/AppShell.tsx"),
    source("src/app/appShell.css"),
    source("src/components/experienceLayer.css"),
  ]);
  assert.match(shell, /background:\s*var\(--theme-app-bg\)/);
  assert.match(shell, /background:\s*var\(--theme-sidebar-bg\)/);
  assert.match(shell, /background:\s*var\(--theme-titlebar-bg\)/);
  assert.doesNotMatch(shell, /:root\[data-theme=/);
  assert.doesNotMatch(shell, /--bg-base:\s*#/);
  assert.match(shellComponent, /className="shell-page-fallback"[^>]*role="status"/);
  assert.doesNotMatch(shellComponent, /LoadingFallback[\s\S]*background:\s*"#0a0a0c"/);
  assert.match(shell, /\.shell-page-fallback[^}]*background:\s*var\(--theme-app-bg\)/s);
  assert.match(shell, /\.shell-page-fallback[^}]*color:\s*var\(--text-secondary\)/s);
  assert.match(experience, /--experience-border:\s*var\(--theme-dialog-border\)/);
  assert.doesNotMatch(experience, /--experience-border:[^;]*var\(--text-primary\)/);
});

test("shortcut scope tabs keep the existing registry and persistence authority", async () => {
  const [page, settings, shortcuts] = await Promise.all([
    source("src/features/settings/SettingsPage.tsx"),
    source("src/features/settings/useSettings.ts"),
    source("src/app/shortcuts.ts"),
  ]);
  assert.match(page, /role="tablist"/);
  assert.match(page, /role="tab"/);
  assert.match(page, /role="tabpanel"/);
  assert.match(page, /aria-controls=/);
  assert.match(page, /aria-selected=/);
  assert.match(page, /ArrowRight/);
  assert.match(page, /ArrowLeft/);
  assert.match(page, /event\.key === "Home"/);
  assert.match(page, /event\.key === "End"/);
  assert.match(page, /activeScopeShortcuts\.map/);
  assert.match(page, /scopedConflicts > 0[\s\S]*scopeTab\.conflicts/);
  assert.doesNotMatch(page, /settings-shortcut-scope-count/);
  assert.match(settings, /luckyray-settings-v1-shortcuts/);
  assert.match(shortcuts, /export const SHORTCUT_COMMANDS/);
  assert.match(shortcuts, /resolveScopedShortcut/);
  assert.doesNotMatch(page, /localStorage\.setItem\([^)]*shortcut.*scope/is);
});

test("Canvas chrome uses theme semantics without changing node document colors", async () => {
  const [home, editor, main] = await Promise.all([
    source("src/features/canvas/canvasHome.css"),
    source("src/canvas-spike-scroll.css"),
    source("src/CanvasSpike.tsx"),
  ]);
  assert.match(home, /--theme-canvas-workspace/);
  assert.match(home, /--theme-surface-raised/);
  assert.match(editor, /\.canvas-editor-root[^}]*var\(--theme-canvas-workspace\)/s);
  assert.match(editor, /\.canvas-editor-floating-toolbar[^}]*var\(--theme-glass-bg\)/s);
  assert.match(editor, /\.canvas-stage-state p[^}]*color:\s*var\(--text-primary\)/s);
  assert.match(editor, /\.canvas-stage-state\.is-error strong[^}]*color:\s*var\(--text-primary\)/s);
  assert.match(main, /var\(--theme-canvas-grid\)/);
  assert.match(main, /var\(--theme-canvas-mask\)/);
  assert.match(main, /<I18nProvider locale=\{locale\}>/);
  assert.match(main, /useSavedLocale\(\)/);
  assert.match(main, /role=\{errorMsg \? "alert" : "status"\}/);
  assert.match(main, /aria-atomic="true"/);
  assert.doesNotMatch(main, /listLoadFailed", \{ error:/);
});
