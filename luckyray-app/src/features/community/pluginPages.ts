// EXT-PAGE-R1: host-owned projection of plugin pages — sidebar visibility
// preferences, page collection from the single package registry, and a small
// per-session UI cache for open pages. No second package/permission authority.
import { extensionPackages, packageCompatibility, type InstalledPackage, type ScriptContribution, type ScriptResource } from "../../core/extensions/packages";
import { readSavedSettings, writeSavedSettingsPatch, type SettingsMap } from "../settings/useSettings";
import { pluginPagePath } from "../../app/shellNav";

export type PluginPage = {
  /** Stable identity: packageId + "/" + pageId. Never the label. */
  key: string;
  packageId: string;
  pageId: string;
  label: string;
  packageName: string;
  /** hash path for navigation, e.g. plugins/<enc>/<enc> */
  path: string;
  digest: string;
  epoch: number | null;
};

export const SIDEBAR_PREFS_KEY = "extensions.sidebarPages";
const PREFS_LIMIT = 64;
const SESSION_LIMIT = 8;

export function pageKey(packageId: string, pageId: string): string {
  return `${packageId}/${pageId}`;
}

export function scriptContributions(entry: InstalledPackage): ScriptContribution[] {
  return (entry.package.resource as ScriptResource).contributions;
}

/** Page keys of every INSTALLED script package, regardless of enabled/compatibility.
 * Used for preference cleanup: disabling a plugin (reversible) or a temporary host
 * incompatibility must not erase the user's sidebar choice. */
export function collectInstalledPageKeys(packages: InstalledPackage[]): string[] {
  const keys: string[] = [];
  for (const entry of packages) {
    for (const contribution of scriptContributions(entry)) {
      if (contribution.kind === "page") keys.push(pageKey(entry.package.manifest.id, contribution.id));
    }
  }
  return keys;
}

/** Pages of enabled, compatible packages — the only source of sidebar entries and card entries. */
export function collectPluginPages(packages: InstalledPackage[], hostVersion: string): PluginPage[] {
  const pages: PluginPage[] = [];
  for (const entry of packages) {
    if (!entry.enabled || !packageCompatibility(entry.package, hostVersion).compatible) continue;
    for (const contribution of scriptContributions(entry)) {
      if (contribution.kind !== "page") continue;
      pages.push({
        key: pageKey(entry.package.manifest.id, contribution.id),
        packageId: entry.package.manifest.id,
        pageId: contribution.id,
        label: contribution.label,
        packageName: entry.package.manifest.name,
        path: pluginPagePath(entry.package.manifest.id, contribution.id),
        digest: entry.digest,
        epoch: entry.epoch ?? null,
      });
    }
  }
  return pages;
}

// --- host-owned sidebar visibility preferences (primitive settings value) ---

function parsePrefs(settings: SettingsMap): string[] {
  const raw = settings[SIDEBAR_PREFS_KEY];
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function readSidebarPrefs(settings: SettingsMap = readSavedSettings()): string[] {
  return parsePrefs(settings).slice(0, PREFS_LIMIT);
}

export function pageVisibleInSidebar(key: string, settings: SettingsMap = readSavedSettings()): boolean {
  return parsePrefs(settings).includes(key);
}

export function withSidebarPref(current: readonly string[], key: string, visible: boolean): string[] {
  const next = current.filter(value => value !== key);
  if (visible) {
    if (next.length >= PREFS_LIMIT) throw Error("最多显示 64 个插件导航入口，请先隐藏其他入口。");
    next.push(key);
  }
  return next;
}

export function writeSidebarPref(key: string, visible: boolean): void {
  const next = withSidebarPref(parsePrefs(readSavedSettings()), key, visible);
  writeSavedSettingsPatch({ [SIDEBAR_PREFS_KEY]: JSON.stringify(next) });
}

/**
 * Opportunistic cleanup: drop preferences for packages that are no longer
 * installed or pages that no longer exist (removed by an update). Pass keys for
 * every installed package (collectInstalledPageKeys), NOT only enabled pages —
 * disable is reversible and must keep the preference. Only writes when
 * something actually changed. Returns the effective preference list.
 */
export function pruneSidebarPrefs(installedPageKeys: string[]): string[] {
  const settings = readSavedSettings();
  const current = parsePrefs(settings);
  if (!current.length) return current;
  const valid = new Set(installedPageKeys);
  const next = current.filter((key) => valid.has(key));
  if (next.length === current.length) return current;
  writeSavedSettingsPatch({ [SIDEBAR_PREFS_KEY]: JSON.stringify(next) });
  return next;
}

// --- per-session UI cache for open pages (fields the user is typing, selection) ---

export type PageSession = {
  digest: string;
  epoch: number | null;
  /** Last rendered UI so returning to the page shows the draft immediately while the initial fetch runs. */
  ui: { title: string; text?: string; fields?: { id: string; label: string; value: string }[]; actions?: { id: string; label: string }[] } | null;
  fields: Record<string, string>;
  edited: string[];
  materialIds: string[];
  documents: string[];
  canvasIds: string[];
};
const sessions = new Map<string, PageSession>();

export function savePageSession(key: string, session: PageSession): void {
  sessions.delete(key);
  sessions.set(key, session);
  while (sessions.size > SESSION_LIMIT) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/** Restores the session only for the same package build (digest + epoch). */
export function restorePageSession(key: string, digest: string, epoch: number | null): PageSession | null {
  const session = sessions.get(key);
  if (!session || session.digest !== digest || session.epoch !== epoch) return null;
  return session;
}

export function dropPageSessions(packageId: string): void {
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(`${packageId}/`)) sessions.delete(key);
  }
}

// --- registry readiness for direct URL / startup restore ---

export function packagesLoaded(): boolean {
  return extensionPackages.snapshot().revision > 0;
}
