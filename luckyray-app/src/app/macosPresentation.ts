// Lexical presentation/routing only: these helpers do not grant access to a
// path, migrate a library, change a saved shortcut, or prove filesystem identity.
export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^Mac/i.test(platform);
}

export function formatShortcutForDisplay(value: string, platform?: string): string {
  if (!isMacPlatform(platform)) return value;
  return value.split("+").map((part) => {
    switch (part.trim().toLowerCase()) {
      // The application matches a stored Ctrl modifier as Ctrl or Command.
      case "ctrl":
      case "control":
      case "commandorcontrol":
      case "meta":
      case "cmd":
      case "command": return "Cmd";
      case "alt": return "Option";
      default: return part;
    }
  }).join("+");
}

export function appDataChildPath(appDataDir: string, name: string, platform?: string): string {
  if (!appDataDir) return "";
  if (!isMacPlatform(platform)) return `${appDataDir}\\${name}`;
  return joinMacPath(appDataDir, name);
}

export function macPathKey(path: string): string {
  return !path ? "" : path.replace(/\/+$/, "") || "/";
}

export function isMacAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\0")
    && !path.split("/").some((part) => part === "." || part === "..");
}

// Callers still validate any relative component and perform their own native
// authorization. This only renders an already accepted reference as a path.
export function joinMacPath(root: string, relative: string): string {
  if (!isMacAbsolutePath(root) || relative.includes("\0")) return "";
  const base = macPathKey(root);
  if (!relative) return base;
  if (relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) return "";
  return `${base === "/" ? "" : base}/${relative}`;
}

// Watch events are hints, never authorization. A non-matching or ambiguous
// spelling must cause a full refresh instead of becoming a relative path.
export function macRelativeWatchPath(root: string, path: string): string | null {
  if (!isMacAbsolutePath(root) || !isMacAbsolutePath(path)) return null;
  const base = macPathKey(root);
  if (path === base) return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return relative;
}

export function sameManagedLibraryPath(left: string, right: string, platform?: string): boolean {
  if (!isMacPlatform(platform)) {
    const windowsKey = (path: string) => path.trim().replace(/[\\/]+$/g, "").replace(/\//g, "\\").toLowerCase();
    return windowsKey(left) === windowsKey(right);
  }
  // macOS volumes may be case-sensitive; a backslash and trailing whitespace
  // are valid filename characters. Only remove redundant trailing slashes.
  // Even an exact match is only a UI shortcut, never filesystem authorization.
  return macPathKey(left) === macPathKey(right);
}
