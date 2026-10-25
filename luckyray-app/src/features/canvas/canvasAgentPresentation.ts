/** Pure display helpers. Unknown timestamps stay unknown, never synthetic. */
export function activityDuration(start: number | undefined, end: number | undefined, english = false): string | undefined {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = (end - start) / 1000;
  if (seconds < 1) return english ? '<1s' : '不到1秒';
  if (seconds < 60) return english ? `${Math.floor(seconds)}s` : `${Math.floor(seconds)}秒`;
  const minutes = Math.floor(seconds / 60), remainder = Math.floor(seconds % 60);
  return english ? `${minutes}m${remainder ? ` ${remainder}s` : ''}` : `${minutes}分${remainder ? `${remainder}秒` : ''}`;
}
/** DSH ui-chat 0.2.1-rc.2 ReasoningRow: advance only when a paragraph's first line completes. MIT, DeepSeek. */
export function reasoningPreview(text: string, active = false): string {
  const firstLine = (value: string) => { const newline = value.indexOf('\n'); return newline === -1 ? value : value.slice(0, newline); };
  if (!active) return firstLine(text).replace(/\*\*/g, '');
  let summary = '', paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n');
    const newline = text.indexOf('\n', paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== '') summary = candidate;
    }
    if (nextParagraph === null) return summary.replace(/\*\*/g, '');
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}
