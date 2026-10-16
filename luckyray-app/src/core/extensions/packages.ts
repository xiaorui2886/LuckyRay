import { invoke } from "@tauri-apps/api/core";

export type PackageManifest = {
  schemaVersion: 0 | 1; id: string; name: string; version: string; type: "theme" | "template" | "script";
  entry: "theme.json" | "template.json" | "main.js"; minHostVersion: string; apiVersion: 0 | 1;
  requiredModules: string[]; optionalModules: string[];
};
export type ThemeResource = { base: "dark" | "light"; tokens: Record<string, string> };
export type TemplateResource = { markdown: string; parameters: Record<string, string> };
export type ScriptContribution = { id: string; label: string; kind: "command" | "menu" | "panel" | "settings" | "page" };
export type ScriptResource = { code: string; requiredPermissions: string[]; optionalPermissions: string[]; dataVersion: number; contributions: ScriptContribution[] };
export type ExtensionPackage = { manifest: PackageManifest; resource: ThemeResource | TemplateResource | ScriptResource };
export type InstalledPackage = { package: ExtensionPackage; enabled: boolean; digest: string; grants?: string[]; epoch?: number };
export type PackageState = { revision: number; packages: InstalledPackage[]; hostVersion: string };
/** Client-side load projection: true only after the first transport round-trip succeeded.
 * A genuinely empty library can still be `ready` — this is not `revision > 0`. */
export type PackageLoadState = PackageState & { ready: boolean };
export type PackageTransport = (request: Record<string, unknown>) => Promise<PackageState>;
export class ExtensionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ExtensionError"; }
}
export const THEME_TOKEN_KEYS = ["--theme-app-bg", "--theme-sidebar-bg", "--theme-titlebar-bg", "--theme-surface-base", "--theme-surface-raised", "--theme-surface-panel", "--theme-card-bg", "--theme-hover", "--theme-selected", "--theme-border-subtle", "--theme-border-strong", "--theme-dialog-border", "--theme-text-muted", "--text-primary", "--text-secondary"] as const;
export function packageCompatibility(pkg: ExtensionPackage, hostVersion: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : [];
  const required = parse(pkg.manifest.minHostVersion), host = parse(hostVersion);
  const versionOk = required.length === 3 && host.length === 3 && (required[0] < host[0] || (required[0] === host[0] && (required[1] < host[1] || (required[1] === host[1] && required[2] <= host[2]))));
  return {
    compatible: versionOk && pkg.manifest.apiVersion === (pkg.manifest.type === "script" ? 1 : 0) && pkg.manifest.requiredModules.every(m => ["knowledge", "materials", "canvas"].includes(m)),
    unavailableOptional: pkg.manifest.optionalModules.filter(m => !["knowledge", "materials", "canvas"].includes(m)),
  };
}
/** No filesystem paths. UI supplies a user-selected File.text() JSON envelope. */
export function parseLocalPackage(text: string): ExtensionPackage {
  if (new TextEncoder().encode(text).length > 131072) throw new ExtensionError("extension-package-too-large");
  try { return JSON.parse(text) as ExtensionPackage; } catch { throw new ExtensionError("extension-invalid-json"); }
}
export function createExtensionPackageService(transport: PackageTransport = request => invoke("manage_extension_packages", { request: JSON.stringify(request) })) {
  let state: PackageState = { revision: 0, packages: [], hostVersion: "0.0.0" };
  let ready = false;
  let preview: { id: string; version: string } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(fn => fn());
  const apply = (next: PackageState) => {
    if (next.revision < state.revision) return;
    state = next;
    if (preview && !state.packages.some(p => p.package.manifest.id === preview!.id && p.package.manifest.version === preview!.version)) preview = null;
    notify();
  };
  const run = async (request: Record<string, unknown>) => {
    const previewAtStart = preview;
    try {
      const next = await transport(request);
      if (next.revision >= state.revision && preview && preview === previewAtStart && (request.op === "enable" || ((request.op === "disable" || request.op === "uninstall") && request.id === preview.id))) preview = null;
      ready = true;
      apply(next);
      return { ...structuredClone(state), ready };
    }
    catch (e) { throw e instanceof ExtensionError ? e : new ExtensionError(e instanceof Error ? e.message : String(e)); }
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    snapshot: (): PackageLoadState => ({ ...structuredClone(state), ready }),
    refresh: () => run({ op: "list" }),
    install: async (text: string, expectedRevision: number) => run({ op: "install", package: parseLocalPackage(text), expectedRevision }),
    update: async (text: string, expectedRevision: number) => run({ op: "update", package: parseLocalPackage(text), expectedRevision }),
    grant: (id: string, grants: string[], expectedRevision: number) => run({ op: "grant", id, grants, expectedRevision }),
    enable: (id: string, expectedRevision: number) => run({ op: "enable", id, expectedRevision }),
    disable: (id: string, expectedRevision: number) => run({ op: "disable", id, expectedRevision }),
    uninstall: (id: string, expectedRevision: number) => run({ op: "uninstall", id, expectedRevision }),
    previewTheme(id: string) {
      const entry = state.packages.find(p => p.package.manifest.id === id && p.package.manifest.type === "theme");
      if (!entry) throw new ExtensionError("extension-theme-not-installed");
      if (!packageCompatibility(entry.package, state.hostVersion).compatible) throw new ExtensionError("extension-incompatible");
      preview = { id, version: entry.package.manifest.version }; notify();
      // Closing the preview owner must call this disposer, including unmount.
      const owned = preview;
      return () => { if (preview === owned) { preview = null; notify(); } };
    },
    cancelPreview() { preview = null; notify(); },
    async confirmPreview(expectedRevision: number) {
      if (!preview) throw new ExtensionError("extension-no-preview");
      const owned = preview;
      const next = await run({ op: "enable", id: owned.id, expectedRevision });
      if (preview === owned) { preview = null; notify(); }
      return next;
    },
    activeTheme(): ThemeResource | null {
      const entry = preview
        ? state.packages.find(p => p.package.manifest.id === preview!.id && p.package.manifest.version === preview!.version)
        : state.packages.find(p => p.enabled && p.package.manifest.type === "theme");
      return entry && packageCompatibility(entry.package, state.hostVersion).compatible ? structuredClone(entry.package.resource as ThemeResource) : null;
    },
    /** The enabled (non-preview) theme package id, for switching back to built-ins. */
    enabledThemeId(): string | null {
      return state.packages.find(p => p.enabled && p.package.manifest.type === "theme")?.package.manifest.id ?? null;
    },
  };
}
export type ExtensionPackageService = ReturnType<typeof createExtensionPackageService>;
export const extensionPackages = createExtensionPackageService();
