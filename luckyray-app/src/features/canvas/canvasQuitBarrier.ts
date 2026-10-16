// An adapter to CanvasSpike's existing serialized writer, not another save
// queue or document cache. The window lifecycle owns timeout/IME/retry policy.
export type CanvasQuitState = {
  canvasId: string | null;
  loadEpoch: number;
  editing: number;
  saved: number;
  writing: boolean;
  blocked: boolean;
};

export async function flushCanvasBeforeQuit(
  read: () => CanvasQuitState,
  persist: () => Promise<void>,
): Promise<boolean> {
  const before = read();
  if (before.blocked) return false;
  if (before.editing !== before.saved || before.writing) {
    try { await persist(); } catch { return false; }
  }
  const after = read();
  return !after.blocked && !after.writing
    && after.canvasId === before.canvasId && after.loadEpoch === before.loadEpoch
    && after.editing === after.saved;
}
