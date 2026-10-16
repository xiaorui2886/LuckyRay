import { useCallback, useEffect, useMemo, useState } from "react";
import { sanitizeAiSettingsForBrowserStorage } from "../../core/services/aiSettingsPrivacy";
import { getThemePreset } from "../../core/theme/themePresets";
import { extensionPackages } from "../../core/extensions/packages";
import { applyPackageTheme } from "../../core/extensions/theme";
import { normalizeLocale, type Locale } from "../../core/i18n/index";
import {
  SHORTCUT_COMMANDS,
  type ShortcutCommandId,
  type ShortcutScope,
} from "../../app/shortcuts";

const SETTINGS_KEY = "luckyray-settings-v1";
const SHORTCUTS_KEY = "luckyray-settings-v1-shortcuts";
const DEFAULT_ACCENT = "#7c8aff";

export type SettingsValue = string | number | boolean;
export type SettingsMap = Record<string, SettingsValue>;

export type ShortcutItem = {
  id: ShortcutCommandId;
  name: string;
  scope: ShortcutScope;
  value: string;
  defaultValue: string;
};

export const SETTINGS_DEFAULTS: SettingsMap = {
  "search.modeShortcutEnabled": true,
  "general.language": "zh-CN",
  "general.startup": "last",
  "general.theme": "dark",
  "general.density": "comfortable",
  "general.onClose": "tray",
  "general.autoLaunch": false,
  "general.showCollectionNav": false,
  "general.watchFolder": false,
  "appearance.accentColor": DEFAULT_ACCENT,
  "appearance.fontSize": "md",
  "appearance.fontFamily": "system",
  "appearance.monoFont": "jetbrains",
  "appearance.lineHeight": "comfortable",
  "appearance.animations": true,
  "appearance.blur": true,
  "ai.provider": "deepseek",
  "ai.model": "deepseek-chat",
  "ai.apiKey": "",
  "ai.baseUrl": "https://api.deepseek.com",
  "ai.temperature": 0.7,
  "ai.maxTokens": 2000,
  "materials.importMode": "linked",
  "materials.managedLibraryDir": "",
  "materials.sourceDeletePolicy": "ask",
  "materials.importModePromptSeen": false,
};

export const DEFAULT_SHORTCUTS: ShortcutItem[] = SHORTCUT_COMMANDS.map((item) => ({
  id: item.id,
  name: item.id,
  scope: item.scope,
  value: item.defaultValue,
  defaultValue: item.defaultValue,
}));

function isSettingsValue(value: unknown): value is SettingsValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function flattenLegacy(raw: unknown): SettingsMap {
  if (!raw || typeof raw !== "object") return {};
  const out: SettingsMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isSettingsValue(value) && key.includes(".")) {
      out[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (isSettingsValue(childValue)) out[`${key}.${childKey}`] = childValue;
      }
    }
  }
  return out;
}

function loadSettings(): SettingsMap {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const loaded = raw ? { ...SETTINGS_DEFAULTS, ...flattenLegacy(JSON.parse(raw)) } : { ...SETTINGS_DEFAULTS };
    const sanitized = sanitizeAiSettingsForBrowserStorage(loaded);
    if (loaded["ai.apiKey"]) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    }
    return sanitized;
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function readSavedSettings(): SettingsMap {
  return loadSettings();
}

export function readSavedLocale(): Locale {
  return normalizeLocale(loadSettings()["general.language"]);
}

export function useSavedLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(readSavedLocale);
  useEffect(() => {
    const onSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: SettingsMap }>).detail;
      const candidate = detail?.settings?.["general.language"];
      setLocale(candidate === undefined ? readSavedLocale() : normalizeLocale(candidate));
    };
    window.addEventListener("luckyray:settings-change", onSettingsChange);
    return () => window.removeEventListener("luckyray:settings-change", onSettingsChange);
  }, []);
  return locale;
}

function saveSettings(data: SettingsMap) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeAiSettingsForBrowserStorage(data)));
  } catch {
    // Ignore storage failures in restricted webviews.
  }
}

export function writeSavedSettingsPatch(values: SettingsMap): SettingsMap {
  const next = { ...loadSettings(), ...values };
  saveSettings(next);
  broadcastSettingsChange(next);
  return next;
}

function broadcastSettingsChange(settings: SettingsMap) {
  window.dispatchEvent(new CustomEvent("luckyray:settings-change", { detail: { settings } }));
}

function hexToRgb(hex: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function lighten(hex: string, amount: number) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return `#${[mix(rgb.r), mix(rgb.g), mix(rgb.b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function readSavedAccentColor() {
  return String(loadSettings()["appearance.accentColor"] || DEFAULT_ACCENT);
}

export function getAccentTheme(color: string) {
  const rgb = hexToRgb(color);
  return {
    "--accent": color,
    "--accent-hover": lighten(color, 0.12),
    "--accent-muted": rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)` : "rgba(124, 138, 255, 0.12)",
    "--accent-soft-border": rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)` : "rgba(124, 138, 255, 0.3)",
    "--accent-glow": rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)` : "rgba(124, 138, 255, 0.35)",
  } as Record<string, string>;
}

export function getShellAccentTheme(themeId: string, color: string) {
  const derived = getAccentTheme(color);
  const preset = getThemePreset(themeId);
  const usesPresetAccent =
    preset.id !== "dark" &&
    preset.id !== "light" &&
    color.trim().toLowerCase() === preset.recommendedAccent.toLowerCase();

  if (!usesPresetAccent) return derived;

  return {
    "--accent-soft-border": derived["--accent-soft-border"],
    "--accent-glow": derived["--accent-glow"],
  } as Record<string, string>;
}

export function applyAccentTheme(color: string, target: HTMLElement = document.documentElement) {
  const theme = getAccentTheme(color);
  for (const [key, value] of Object.entries(theme)) {
    target.style.setProperty(key, value);
  }
}

function fontStack(value: SettingsValue | undefined) {
  if (value === "sf") return '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
  if (value === "inter") return '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif';
  if (value === "source") return '"Noto Sans SC", "Source Han Sans SC", "Segoe UI", sans-serif';
  if (value === "pingfang") return '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  return '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif';
}

function monoStack(value: SettingsValue | undefined) {
  if (value === "fira") return '"Fira Code", "SF Mono", Consolas, monospace';
  if (value === "cascadia") return '"Cascadia Code", "SF Mono", Consolas, monospace';
  if (value === "system") return '"SF Mono", Consolas, monospace';
  return '"JetBrains Mono", "SF Mono", Consolas, monospace';
}

function fontSizeValue(value: SettingsValue | undefined) {
  if (value === "xs") return "11px";
  if (value === "sm") return "12px";
  if (value === "lg") return "14px";
  if (value === "xl") return "15px";
  return "13px";
}

function lineHeightValue(value: SettingsValue | undefined) {
  if (value === "compact") return "1.35";
  if (value === "loose") return "1.72";
  return "1.55";
}

export function applyGlobalSettings(settings: SettingsMap = loadSettings(), target: HTMLElement = document.documentElement) {
  const theme = getThemePreset(String(settings["general.theme"] || "dark")).id;
  const density = String(settings["general.density"] || "comfortable");
  applyAccentTheme(String(settings["appearance.accentColor"] || DEFAULT_ACCENT), target);
  target.dataset.theme = theme;
  target.dataset.density = density;
  target.dataset.animations = settings["appearance.animations"] === false ? "off" : "on";
  target.dataset.blur = settings["appearance.blur"] === false ? "off" : "on";
  target.style.setProperty("--font", fontStack(settings["appearance.fontFamily"]));
  target.style.setProperty("--font-mono", monoStack(settings["appearance.monoFont"]));
  target.style.setProperty("--lr-font-family", fontStack(settings["appearance.fontFamily"]));
  target.style.setProperty("--lr-mono-font", monoStack(settings["appearance.monoFont"]));
  target.style.setProperty("--lr-font-size-base", fontSizeValue(settings["appearance.fontSize"]));
  target.style.setProperty("--lr-line-height", lineHeightValue(settings["appearance.lineHeight"]));
  applyPackageTheme(extensionPackages.activeTheme(), target);
}

function loadShortcuts(): ShortcutItem[] {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    const overrides = raw ? JSON.parse(raw) as Record<string, string> : {};
    return DEFAULT_SHORTCUTS.map((item) => ({ ...item, value: overrides[item.id] || item.defaultValue }));
  } catch {
    return DEFAULT_SHORTCUTS.map((item) => ({ ...item }));
  }
}

function saveShortcutOverrides(shortcuts: ShortcutItem[]) {
  try {
    const overrides: Record<string, string> = {};
    for (const item of shortcuts) {
      if (item.value !== item.defaultValue) overrides[item.id] = item.value;
    }
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(overrides));
  } catch {
    // Keep in-memory state.
  }
  window.dispatchEvent(new CustomEvent("luckyray:shortcuts-change", { detail: { shortcuts } }));
}

export function useSettings() {
  const [settings, setSettings] = useState<SettingsMap>(loadSettings);
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(loadShortcuts);

  const get = useCallback(<T extends SettingsValue>(key: string, fallback: T): T => {
    const value = settings[key];
    return (value === undefined ? fallback : value) as T;
  }, [settings]);

  const set = useCallback((key: string, value: SettingsValue) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      broadcastSettingsChange(next);
      return next;
    });
  }, []);

  const patch = useCallback((values: SettingsMap) => {
    setSettings((prev) => {
      const next = { ...prev, ...values };
      saveSettings(next);
      broadcastSettingsChange(next);
      return next;
    });
  }, []);

  const updateShortcut = useCallback((id: ShortcutCommandId, value: string) => {
    setShortcuts((prev) => {
      const next = prev.map((item) => item.id === id ? { ...item, value } : item);
      saveShortcutOverrides(next);
      return next;
    });
  }, []);

  const resetShortcut = useCallback((id: ShortcutCommandId) => {
    setShortcuts((prev) => {
      const next = prev.map((item) => item.id === id ? { ...item, value: item.defaultValue } : item);
      saveShortcutOverrides(next);
      return next;
    });
  }, []);

  const resetShortcuts = useCallback(() => {
    setShortcuts((prev) => {
      const next = prev.map((item) => ({ ...item, value: item.defaultValue }));
      saveShortcutOverrides(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    const next = { ...SETTINGS_DEFAULTS };
    saveSettings(next);
    setSettings(next);
    applyGlobalSettings(next);
    broadcastSettingsChange(next);
  }, []);

  return useMemo(() => ({
    settings,
    shortcuts,
    get,
    set,
    patch,
    updateShortcut,
    resetShortcut,
    resetShortcuts,
    resetSettings,
  }), [get, patch, resetShortcut, resetShortcuts, resetSettings, set, settings, shortcuts, updateShortcut]);
}
