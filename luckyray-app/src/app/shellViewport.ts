export const COMPACT_SHELL_BREAKPOINT = 1240;

// Windows can report a 0/1px WebView while the native window is minimized.
// That transient surface is not an application layout and must retain the
// current compact state until a real client width returns.
const MIN_RENDERABLE_SHELL_WIDTH = 320;

export function selectCompactShellForViewport(viewportWidth: number, current: boolean): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth < MIN_RENDERABLE_SHELL_WIDTH) return current;
  return viewportWidth <= COMPACT_SHELL_BREAKPOINT;
}
