export type ShellRouteMode = "dsh-native-surface" | "react" | "legacy";

/** Read compatibility only: old bookmarks/startup preferences go to Notes.
 * This never clears layouts, drafts, recovery records or other saved pages. */
export function normalizeRetiredWorkspaceRoute(path: string): string {
  return path.split(/[/?]/)[0] === 'workspace' ? 'notes' : path;
}

export function selectShellRouteMode(route: string, reactEnabled: boolean): ShellRouteMode {
  if (route === "ai") return "dsh-native-surface";
  return reactEnabled ? "react" : "legacy";
}
