/** Pure display helpers. Unknown timestamps stay unknown, never synthetic. */
export function activityDuration(start: number | undefined, end: number | undefined, english = false): string | undefined {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = (end - start) / 1000;
  if (seconds < 1) return english ? '<1s' : '不到1秒';
  if (seconds < 60) return english ? `${Math.floor(seconds)}s` : `${Math.floor(seconds)}秒`;
  const minutes = Math.floor(seconds / 60), remainder = Math.floor(seconds % 60);
  return english ? `${minutes}m${remainder ? ` ${remainder}s` : ''}` : `${minutes}分${remainder ? `${remainder}秒` : ''}`;
}
export function reasoningPreview(text: string, active = false): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 140) return clean;
  return active ? `…${clean.slice(-139)}` : `${clean.slice(0, 139)}…`;
}
