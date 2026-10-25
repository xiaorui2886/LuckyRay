export type CanvasTextFormat = 'h1' | 'h2' | 'h3' | 'paragraph' | 'bold' | 'italic' | 'strike' | 'bullet' | 'number';
export type CanvasTextEdit = { from: number; to: number; insert: string; anchor: number; head: number };

/** Pure Markdown edits: preserve untouched content and return an exact selection. */
export function formatCanvasText(value: string, start: number, end: number, format: CanvasTextFormat): CanvasTextEdit {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.max(from, Math.min(Math.max(start, end), value.length));
  const marks = { bold: '**', italic: '*', strike: '~~' };
  if (format in marks) {
    const mark = marks[format as keyof typeof marks], selected = value.slice(from, to);
    if (from >= mark.length && value.slice(from - mark.length, from) === mark && value.slice(to, to + mark.length) === mark && (format !== 'italic' || (value[from - 2] !== '*' && value[to + 1] !== '*'))) {
      return { from: from - mark.length, to: to + mark.length, insert: selected, anchor: from - mark.length, head: to - mark.length };
    }
    return { from, to, insert: mark + selected + mark, anchor: from + mark.length, head: to + mark.length };
  }
  const lineStart = from === 0 ? 0 : value.lastIndexOf('\n', from - 1) + 1;
  const effectiveEnd = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const newline = value.indexOf('\n', effectiveEnd);
  const lineEnd = newline < 0 ? value.length : newline;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const heading = /^ {0,3}#{1,6}\s+/;
  const list = /^\s*(?:[-+*]|\d+[.)])\s+/;
  const prefix = format === 'h1' ? '# ' : format === 'h2' ? '## ' : format === 'h3' ? '### ' : '';
  const removeList = format === 'bullet' ? lines.every(line => /^\s*[-+*]\s/.test(line)) : format === 'number' && lines.every(line => /^\s*\d+[.)]\s/.test(line));
  const next = lines.map((line, index) => {
    if (format === 'bullet' || format === 'number') {
      const text = line.replace(list, '');
      return removeList ? text : (format === 'bullet' ? '- ' : `${index + 1}. `) + text;
    }
    return prefix + line.replace(heading, '');
  }).join('\n');
  return { from: lineStart, to: lineEnd, insert: next, anchor: lineStart, head: lineStart + next.length };
}

export type CanvasTextHeading = { text: string; level: number; from: number };
export function canvasTextOutline(value: string): CanvasTextHeading[] {
  const result: CanvasTextHeading[] = [];
  let offset = 0, fence = '';
  for (const line of value.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    } else if (!fence) {
      const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) result.push({ level: match[1].length, text: match[2], from: offset });
    }
    offset += line.length + 1;
  }
  return result;
}

/** Explicit insertion only; never overwrite or infer a document migration. */
export function canvasScriptTemplate(english = false): string {
  return english
    ? '# Story outline\n\n## Logline\n\n## Story summary\n\n## Story world\n\n## Sequence\n\n# Characters\n\n## Main character\n\n# Scene design\n\n## Scene 1\n\n'
    : '# 故事大纲\n\n## 一句话故事\n\n## 故事梗概\n\n## 故事背景\n\n## 情节脉络\n\n# 人物小传\n\n## 主要人物\n\n# 场景设计\n\n## 场景一\n\n';
}
