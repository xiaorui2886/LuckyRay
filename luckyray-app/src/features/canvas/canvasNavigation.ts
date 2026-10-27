export const PENDING_CANVAS_OPEN_KEY = "luckyray:canvas-open-id";

export function canvasEditorHash(canvasId?: string | null): string {
  const normalizedId = typeof canvasId === "string" ? canvasId.trim() : "";
  return normalizedId ? `#canvas/main/${encodeURIComponent(normalizedId)}` : "#canvas/main";
}

export function parseCanvasIdFromHash(hash: string): string {
  const path = String(hash || "").replace(/^#\/?/, "").split("?")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "canvas" || segments[1] !== "main" || !segments[2]) return "";
  try {
    return decodeURIComponent(segments[2]).trim();
  } catch {
    return "";
  }
}

export function resolveCanvasOpenTarget(
  availableIds: readonly string[],
  hash: string,
  pendingId?: string | null,
): string {
  const available = new Set(availableIds.filter(Boolean));
  const hashTarget = parseCanvasIdFromHash(hash);
  if (hashTarget && available.has(hashTarget)) return hashTarget;
  const fallbackTarget = typeof pendingId === "string" ? pendingId.trim() : "";
  if (fallbackTarget && available.has(fallbackTarget)) return fallbackTarget;
  return availableIds.find(Boolean) || "";
}

export function setPendingCanvasOpen(canvasId: string) {
  try {
    sessionStorage.setItem(PENDING_CANVAS_OPEN_KEY, canvasId);
  } catch {}
}

export function openCanvasById(canvasId: string) {
  setPendingCanvasOpen(canvasId);
  window.location.hash = canvasEditorHash(canvasId);
}

// Tab-local navigation memory only. Explicit canvas-home clears this value.
export const LAST_CANVAS_EDITOR_KEY = "luckyray:canvas-last-editor";
export function rememberCanvasEditor(path: string): void {
  if (!/^canvas\/main(?:\/|$)/.test(path)) return;
  try { sessionStorage.setItem(LAST_CANVAS_EDITOR_KEY, path); } catch {}
}
export function clearRememberedCanvasEditor(): void {
  try { sessionStorage.removeItem(LAST_CANVAS_EDITOR_KEY); } catch {}
}
export function rememberedCanvasRoute(): string {
  try {
    const path = sessionStorage.getItem(LAST_CANVAS_EDITOR_KEY) || "";
    return /^canvas\/main(?:\/|$)/.test(path) ? path : "canvas";
  } catch { return "canvas"; }
}
