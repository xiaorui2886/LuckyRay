import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { THEME_PRESETS, type ThemePresetId, getThemePreset } from "../src/core/theme/themePresets.ts";
import { SETTINGS_DEFAULTS, applyGlobalSettings, getAccentTheme, getShellAccentTheme } from "../src/features/settings/useSettings.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const EXPECTED_THEMES = [
  { id: "dark", name: "深色", recommendedAccent: "#7c8aff" },
  { id: "light", name: "浅色", recommendedAccent: "#7c8aff" },
  { id: "ivory-editorial", name: "象牙刊物", recommendedAccent: "#b9824f" },
  { id: "rose-tea", name: "玫瑰茶雾", recommendedAccent: "#c97991" },
  { id: "github-dark", name: "GitHub Dark", recommendedAccent: "#58a6ff" },
  { id: "white-zero", name: "白域 Zero", recommendedAccent: "#18181b" },
  { id: "bangladesh-green", name: "孟加拉森绿", recommendedAccent: "#00b884" },
  { id: "lilac-milk", name: "丁香雪乳", recommendedAccent: "#6a7699" },
  { id: "blue-whisper", name: "蓝雾海岸", recommendedAccent: "#4b90a5" },
] as const;

const REQUIRED_TOKENS = [
  "--bg-base",
  "--bg-surface",
  "--bg-elevated",
  "--bg-hover",
  "--bg-active",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--accent",
  "--accent-hover",
  "--accent-muted",
  "--border",
  "--border-subtle",
  "--mint",
  "--amber",
  "--rose",
  "--purple",
  "--success",
  "--warning",
  "--danger",
  "--success-muted",
  "--warning-muted",
  "--danger-muted",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
];

function parseCssTokens(css: string, themeId: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match selector for the theme
  const regex = new RegExp(`:root\\[data-theme=["']${themeId}["']\\][^{]*\\{([^}]+)\\}`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css)) !== null) {
    const block = match[1];
    const lines = block.split(";");
    for (const line of lines) {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join(":").trim();
        if (key.startsWith("--")) {
          map.set(key, value);
        }
      }
    }
  }
  return map;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const srgb = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map((c) => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test("theme presets catalog defines exactly 9 themes with correct IDs, names, and recommended accents", () => {
  assert.equal(THEME_PRESETS.length, 9);
  for (let i = 0; i < EXPECTED_THEMES.length; i++) {
    const expected = EXPECTED_THEMES[i];
    const actual = THEME_PRESETS[i];
    assert.equal(actual.id, expected.id);
    assert.equal(actual.name, expected.name);
    assert.equal(actual.recommendedAccent, expected.recommendedAccent);
    assert.ok(Array.isArray(actual.previewTokens) && actual.previewTokens.length >= 4);
  }
});

test("getThemePreset returns correct preset by id or falls back to dark", () => {
  assert.equal(getThemePreset("ivory-editorial").name, "象牙刊物");
  assert.equal(getThemePreset("bangladesh-green").recommendedAccent, "#00b884");
  assert.equal(getThemePreset("unknown" as ThemePresetId).id, "dark");
});

test("AppShell theme CSS defines complete tokens with effective cascade reaching .react-nav-shell", async () => {
  const css = await source("src/app/appShell.css");

  for (const expected of EXPECTED_THEMES) {
    if (expected.id === "dark" || expected.id === "light") continue; // classic themes have base definition

    const tokens = parseCssTokens(css, expected.id);
    assert.ok(tokens.size > 0, `Theme ${expected.id} should have CSS token definitions in appShell.css`);

    for (const token of REQUIRED_TOKENS) {
      assert.ok(tokens.has(token), `Theme ${expected.id} missing token ${token}`);
    }

    // Cascade check: selector must target .react-nav-shell
    const selectorPattern = new RegExp(`:root\\[data-theme=["']${expected.id}["']\\]\\s*\\.react-nav-shell`);
    assert.match(css, selectorPattern, `Theme ${expected.id} CSS must have selector targeting .react-nav-shell for effective cascade`);
  }
});

test("All 7 new themes satisfy primary and secondary text contrast criteria against base/surface", async () => {
  const css = await source("src/app/appShell.css");

  for (const expected of EXPECTED_THEMES) {
    if (expected.id === "dark" || expected.id === "light") continue;
    const tokens = parseCssTokens(css, expected.id);
    const bgBase = tokens.get("--bg-base")!;
    const bgSurface = tokens.get("--bg-surface")!;
    const textPrimary = tokens.get("--text-primary")!;
    const textSecondary = tokens.get("--text-secondary")!;

    if (bgBase.startsWith("#") && textPrimary.startsWith("#")) {
      const primaryVsBase = contrastRatio(bgBase, textPrimary);
      assert.ok(primaryVsBase >= 4.5, `Theme ${expected.id} primary text contrast vs base (${primaryVsBase.toFixed(2)}) must be >= 4.5:1`);
    }

    if (bgSurface.startsWith("#") && textPrimary.startsWith("#")) {
      const primaryVsSurface = contrastRatio(bgSurface, textPrimary);
      assert.ok(primaryVsSurface >= 4.5, `Theme ${expected.id} primary text contrast vs surface (${primaryVsSurface.toFixed(2)}) must be >= 4.5:1`);
    }

    if (bgBase.startsWith("#") && textSecondary.startsWith("#")) {
      const secondaryVsBase = contrastRatio(bgBase, textSecondary);
      assert.ok(secondaryVsBase >= 3.0, `Theme ${expected.id} secondary text contrast vs base (${secondaryVsBase.toFixed(2)}) must be >= 3.0:1`);
    }
  }
});

test("applyGlobalSettings sets data-theme and applies accent theme tokens", () => {
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (key: string, value: string) => {
        root.styleProperties[key] = value;
      },
    },
    styleProperties: {} as Record<string, string>,
  } as unknown as HTMLElement & { styleProperties: Record<string, string> };

  applyGlobalSettings({
    "general.theme": "ivory-editorial",
    "appearance.accentColor": "#b9824f",
  }, root);

  assert.equal(root.dataset.theme, "ivory-editorial");
  assert.equal(root.styleProperties["--accent"], "#b9824f");
  assert.ok(root.styleProperties["--accent-hover"]);
  assert.ok(root.styleProperties["--accent-muted"]);
});

test("getAccentTheme derives helper tokens faithfully from any accent color", () => {
  const derived = getAccentTheme("#00b884");
  assert.equal(derived["--accent"], "#00b884");
  assert.ok(derived["--accent-hover"].startsWith("#"));
  assert.match(derived["--accent-muted"], /rgba\(0,\s*184,\s*132,\s*0\.12\)/);
  assert.match(derived["--accent-soft-border"], /rgba\(0,\s*184,\s*132,\s*0\.3\)/);
  assert.match(derived["--accent-glow"], /rgba\(0,\s*184,\s*132,\s*0\.35\)/);
});

test("AppShell preserves preset accent hover and muted tokens until the user customizes accent", async () => {
  const [css, appShell] = await Promise.all([
    source("src/app/appShell.css"),
    source("src/app/AppShell.tsx"),
  ]);
  const roseTokens = parseCssTokens(css, "rose-tea");
  const presetStyle = getShellAccentTheme("rose-tea", "#c97991");

  for (const preset of EXPECTED_THEMES.slice(2)) {
    const effectivePresetStyle = getShellAccentTheme(preset.id, preset.recommendedAccent);
    assert.equal(effectivePresetStyle["--accent"], undefined, `${preset.id} should inherit its CSS accent`);
    assert.equal(effectivePresetStyle["--accent-hover"], undefined, `${preset.id} should inherit its CSS hover`);
    assert.equal(effectivePresetStyle["--accent-muted"], undefined, `${preset.id} should inherit its CSS muted tone`);
  }

  assert.equal(presetStyle["--accent"], undefined);
  assert.equal(presetStyle["--accent-hover"], undefined);
  assert.equal(presetStyle["--accent-muted"], undefined);
  assert.equal(roseTokens.get("--accent-hover"), "#b6647e");
  assert.equal(roseTokens.get("--accent-muted"), "rgba(201,121,145,.16)");
  assert.ok(presetStyle["--accent-soft-border"]);
  assert.ok(presetStyle["--accent-glow"]);

  const customizedStyle = getShellAccentTheme("rose-tea", "#7c8aff");
  assert.equal(customizedStyle["--accent"], "#7c8aff");
  assert.ok(customizedStyle["--accent-hover"]);
  assert.match(customizedStyle["--accent-muted"], /rgba\(124,\s*138,\s*255,\s*0\.12\)/);

  const classicStyle = getShellAccentTheme("dark", "#7c8aff");
  assert.equal(classicStyle["--accent"], "#7c8aff");
  assert.ok(classicStyle["--accent-hover"]);
  assert.ok(classicStyle["--accent-muted"]);
  assert.match(appShell, /getShellAccentTheme\(themeId, accentColor\)/);
  assert.match(appShell, /style=\{accentStyle\}/);
});

test("Settings keeps the full theme preset grid only in Appearance", async () => {
  const settingsPage = await source("src/features/settings/SettingsPage.tsx");
  const generalPanel = settingsPage.slice(
    settingsPage.indexOf('<Panel tab="general"'),
    settingsPage.indexOf('<Panel tab="appearance"'),
  );
  const appearancePanel = settingsPage.slice(
    settingsPage.indexOf('<Panel tab="appearance"'),
    settingsPage.indexOf('<Panel tab="materials"'),
  );

  assert.doesNotMatch(generalPanel, /<ThemePresetSelector/);
  assert.match(appearancePanel, /<ThemePresetSelector/);
  assert.match(generalPanel, /信息密度/);
});

test("Settings appearance renders 9 theme presets and explanatory copy without modifying icon assets", async () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = {
    getItem: (key: string) => key === "luckyray-settings-v1-activePanel" ? "appearance" : null,
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
    const i18nModule = await server.ssrLoadModule("/src/core/i18n/index.ts") as typeof import("../src/core/i18n/index.ts");
    const html = renderToStaticMarkup(React.createElement(
      i18nModule.I18nProvider,
      { locale: "zh-CN" },
      React.createElement(module.default),
    ));

    for (const theme of EXPECTED_THEMES) {
      assert.match(html, new RegExp(theme.name), `Settings should display theme name ${theme.name}`);
    }
    assert.match(html, /选择预设主题会载入推荐主色|选择预设将载入推荐主色|选择预设会载入推荐主色/);
    assert.match(html, /role="radiogroup"|aria-label="主题预设"|settings-theme-preset/);
  } finally {
    await server.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousSessionStorage });
  }
});
