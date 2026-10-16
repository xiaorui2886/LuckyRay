// Left notes-index panel width policy.
//
// Rules (Issue-116 C):
//  - Small windows keep the established 272 CSS px default.
//  - Large/maximized windows (>= LARGE_WINDOW_MIN_WIDTH CSS px) default wider
//    (320 px) so the tree is not cramped — but ONLY as a live default: it is
//    never persisted as a preference, so restoring a small window is never
//    forced wide, and it follows maximize/restore while unset.
//  - An explicit user drag IS a preference: it is persisted and always wins.
//
// Pure and window-free so tests drive the real rules directly.

export const NOTES_INDEX_DEFAULT_WIDTH = 272;
export const NOTES_INDEX_LARGE_DEFAULT_WIDTH = 320;
export const NOTES_INDEX_LARGE_WINDOW_MIN_WIDTH = 1600;
export const NOTES_INDEX_MIN_WIDTH = 240;
export const NOTES_INDEX_MAX_WIDTH = 560;
export const NOTES_INDEX_COLLAPSE_THRESHOLD = 100;

export function isLargeNotesIndexViewport(viewportWidth: number): boolean {
  return viewportWidth >= NOTES_INDEX_LARGE_WINDOW_MIN_WIDTH;
}

export function defaultNotesIndexWidthForViewport(viewportWidth: number): number {
  return isLargeNotesIndexViewport(viewportWidth) ? NOTES_INDEX_LARGE_DEFAULT_WIDTH : NOTES_INDEX_DEFAULT_WIDTH;
}

export function clampNotesIndexWidthTo(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(
    NOTES_INDEX_MIN_WIDTH,
    Math.min(NOTES_INDEX_MAX_WIDTH, viewportWidth - 420),
  );
  return Math.round(Math.min(Math.max(width, NOTES_INDEX_MIN_WIDTH), viewportMax));
}

/** Resolve the initial width plus whether a stored user preference exists. */
export function resolveNotesIndexWidth(input: {
  storedWidth: number | null;
  viewportWidth: number;
}): { width: number; userSet: boolean } {
  if (input.storedWidth === null || !Number.isFinite(input.storedWidth)) {
    return { width: defaultNotesIndexWidthForViewport(input.viewportWidth), userSet: false };
  }
  return { width: clampNotesIndexWidthTo(input.storedWidth, input.viewportWidth), userSet: true };
}

/**
 * The width to (re)expand to. A stored preference wins; without one the
 * CURRENT viewport decides, so a maximized window re-opens wide and a restored
 * small window re-opens compact — never one forcing the other.
 */
export function notesIndexRestoreWidth(input: {
  lastExpandedWidth: number | null;
  userSet: boolean;
  viewportWidth: number;
}): number {
  const basis = input.userSet
    ? Math.max(input.lastExpandedWidth ?? 0, NOTES_INDEX_MIN_WIDTH)
    : defaultNotesIndexWidthForViewport(input.viewportWidth);
  return clampNotesIndexWidthTo(basis, input.viewportWidth);
}
