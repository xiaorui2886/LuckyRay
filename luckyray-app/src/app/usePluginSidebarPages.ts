// Project only enabled, compatible pages from the existing package registry.
// Keep bounded stable-ID preferences through an empty/missing registry or an
// uninstall so reinstalling the same page restores its previous visibility.
import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { extensionPackages } from "../core/extensions/packages";
import { collectPluginPages, readSidebarPrefs, type PluginPage } from "../features/community/pluginPages";
import type { SettingsMap } from "../features/settings/useSettings";

export function usePluginSidebarPages(settings: SettingsMap): PluginPage[] {
  const [, setTick] = useState(0);
  useEffect(() => extensionPackages.subscribe(() => setTick((value) => value + 1)), []);
  const snapshot = extensionPackages.snapshot();
  const scriptPackages = useMemo(
    () => snapshot.packages.filter((entry) => entry.package.manifest.type === "script"),
    [snapshot],
  );
  const allPluginPages = useMemo(
    () => collectPluginPages(scriptPackages, snapshot.hostVersion),
    [scriptPackages, snapshot.hostVersion],
  );
  const prefs = readSidebarPrefs(settings);
  const sidebarPluginPages = useMemo(
    () => allPluginPages.filter((page) => prefs.includes(page.key)),
    [allPluginPages, settings], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Bootstrap once: the same first refresh AppShell used to run inline.
  useEffect(() => {
    if (!isTauri()) return;
    void extensionPackages.refresh().catch(() => console.warn("[extensions] package state unavailable"));
  }, []);
  return sidebarPluginPages;
}
