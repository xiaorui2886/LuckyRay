// Shell navigation keys. A key is either a built-in top-level route ("notes")
// or a plugin page path ("plugins/<enc(packageId)>/<enc(pageId)>"). Keys are
// what the nav stack, back/forward and last-route remember, so two plugin
// pages never collapse into one history entry. Extracted from AppShell for
// EXT-PAGE-R1; built-in routing behaviour is unchanged.

export const PLUGIN_ROUTE = "plugins" as const;

export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function pluginPagePath(packageId: string, pageId: string): string {
  return `${PLUGIN_ROUTE}/${encodeSegment(packageId)}/${encodeSegment(pageId)}`;
}

export function parsePluginPagePath(path: string): { packageId: string; pageId: string } | null {
  const segments = path.split("?")[0].split("/");
  if (segments.length !== 3 || segments[0] !== PLUGIN_ROUTE) return null;
  try {
    const packageId = decodeURIComponent(segments[1]);
    const pageId = decodeURIComponent(segments[2]);
    return packageId && pageId ? { packageId, pageId } : null;
  } catch {
    return null;
  }
}

export function isPluginPageKey(key: string): boolean {
  return key === PLUGIN_ROUTE || key.startsWith(`${PLUGIN_ROUTE}/`);
}

export type NavStack = { stack: string[]; index: number };

export function createNavStack(initialKey: string): NavStack {
  return { stack: [initialKey], index: 0 };
}

export function navPush(state: NavStack, key: string): NavStack {
  if (state.stack[state.index] === key) return state;
  const stack = [...state.stack.slice(0, state.index + 1), key];
  return { stack, index: stack.length - 1 };
}

export function navBack(state: NavStack): { next: NavStack; key: string | null } {
  const key = state.stack[state.index - 1] ?? null;
  if (key === null) return { next: state, key: null };
  return { next: { ...state, index: state.index - 1 }, key };
}

export function navForward(state: NavStack): { next: NavStack; key: string | null } {
  const key = state.stack[state.index + 1] ?? null;
  if (key === null) return { next: state, key: null };
  return { next: { ...state, index: state.index + 1 }, key };
}
