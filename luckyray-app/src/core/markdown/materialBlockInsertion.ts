/** Surround an inserted material block without consuming surrounding note text. */
export function materialBlockInsertion(content: string, markdown: string, selection: { start: number; end: number }): string {
  const start = Math.max(0, Math.min(selection.start, content.length));
  const end = Math.max(start, Math.min(selection.end, content.length));
  const before = content.slice(0, start);
  const after = content.slice(end);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const leading = (before.match(/(?:\r?\n)*$/)?.[0].match(/\n/g) || []).length;
  const trailing = (after.match(/^(?:\r?\n)*/)?.[0].match(/\n/g) || []).length;
  // A media token needs its own line, not an extra empty paragraph. Leave the
  // caret on the immediately following line, also at EOF. Never trim blank
  // lines the author already supplied.
  return `${before ? newline.repeat(Math.max(0, 1 - leading)) : ""}${markdown}${newline.repeat(Math.max(0, 1 - trailing))}`;
}

/** Keep the caret outside media when its separator already exists in the note. */
export function materialBlockSelection(content: string, replacement: string, selection: { start: number; end: number }) {
  const existingBreaks = /\n$/.test(replacement) ? 0
    : content.slice(selection.end).match(/^\r?\n/)?.[0].length || 0;
  const cursor = selection.start + replacement.length + existingBreaks;
  return { start: cursor, end: cursor };
}
