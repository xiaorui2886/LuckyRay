import {isPlainMarkdownCompletionAllowedAt} from './editor/wikiCompletion';
import {parseWikiAnchorQuery} from './editor/sameNoteAnchors';
import {resolveAssetEmbed} from './editor/noteAssetResolver';
import {parseWikiReferenceTarget,normalizeWikiLinkKey as normalizeNoteLinkKey} from '../../core/markdown/wikiTargets';
import type {LiveEditorTokenContext,LiveNote,LiveAsset as Asset,LiveTag as Tag,LiveNoteLink as NoteLink,LiveNoteEmbed as NoteEmbed} from './editor/types';
let noteMeasureCanvas:HTMLCanvasElement|null=null;
export type AutocompleteKind = "note" | "asset" | "tag" | "anchor";

export type AutocompleteItem = {
  id: string;
  label: string;
  meta?: string;
  snippet?: string;
  kind?: string;
  insertText?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  libraryPath?: string | null;
};

export type AutocompleteState = {
  kind: AutocompleteKind;
  query: string;
  start: number;
  end: number;
  x: number;
  y: number;
  items: AutocompleteItem[];
  selectedIndex: number;
};

export function isSourceSemanticTokenAllowedAt(content: string, from: number) {
  return isPlainMarkdownCompletionAllowedAt(content, Math.max(0, Math.min(from, content.length)));
}

export function findSourceEditorTokenAt(
  content: string,
  position: number,
  options: {
    assets: Asset[];
    currentNoteId?: string | null;
    noteEmbeds: NoteEmbed[];
    noteLinks: NoteLink[];
    notes: LiveNote[];
    tags: Tag[];
  },
): LiveEditorTokenContext | null {
  const pos = Math.max(0, Math.min(position, content.length));
  const wikiPattern = /(!?)[\uFEFF\u200B-\u200D\u2060]*(?:\\?\[){2}([^\]\n]+?)(?:\\?\]){2}/g;
  let match: RegExpExecArray | null;

  while ((match = wikiPattern.exec(content))) {
    const from = match.index;
    const to = from + match[0].length;
    if (pos < from || pos > to) continue;
    if (!isSourceSemanticTokenAllowedAt(content, from)) continue;

    if (match[1] === "!") {
      const embed = resolveAssetEmbed(match[2], options.noteEmbeds, options.assets);
      return {
        kind: "asset",
        from,
        to,
        label: embed.asset?.name || embed.display || embed.target,
        assetId: embed.asset?.id || null,
        missing: !embed.asset,
      };
    }

    const parsed = parseWikiReferenceTarget(match[2]);
    const sameNoteAnchor = !parsed.targetTitle && Boolean(parsed.subpath || parsed.blockId);
    const note = parsed.targetTitle
      ? options.notes.find((item) => normalizeNoteLinkKey(item.title.trim()) === normalizeNoteLinkKey(parsed.targetTitle)) || null
      : null;
    const link = parsed.targetTitle
      ? options.noteLinks.find((item) => normalizeNoteLinkKey(item.targetTitle) === normalizeNoteLinkKey(parsed.targetTitle)) || null
      : null;
    const noteId = sameNoteAnchor ? options.currentNoteId || null : note?.id || link?.toNoteId || null;
    return {
      kind: "note",
      from,
      to,
      label: parsed.display,
      noteId,
      createTitle: parsed.targetTitle || null,
      openOptions: {
        blockId: parsed.blockId,
        headingPath: parsed.blockId ? null : parsed.subpath || null,
      },
      missing: !noteId,
    };
  }

  const externalLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  while ((match = externalLinkPattern.exec(content))) {
    const from = match.index;
    const to = from + match[0].length;
    if (pos < from || pos > to) continue;
    if (!isSourceSemanticTokenAllowedAt(content, from)) continue;
    return {
      kind: "external",
      from,
      to,
      label: match[1] || match[2],
      href: match[2],
      missing: false,
    };
  }

  const tagPattern = /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]+)/g;
  while ((match = tagPattern.exec(content))) {
    const from = match.index + match[1].length;
    const to = from + match[2].length + 1;
    if (pos < from || pos > to) continue;
    if (!isSourceSemanticTokenAllowedAt(content, from)) continue;
    const tagName = match[2];
    const tag = options.tags.find((item) => normalizeNoteLinkKey(item.name) === normalizeNoteLinkKey(tagName)) || null;
    return {
      kind: "tag",
      from,
      to,
      label: tagName,
      tagId: tag?.id || null,
      missing: !tag,
    };
  }

  return null;
}

export function getMarkdownBodyStartLine(text: string) {
  const lines = (text || "").split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---") return 0;
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return closeIndex > 0 ? closeIndex + 1 : 0;
}

export function toggleMarkdownTaskAtBodyLine(text: string, bodyLine: number) {
  const lines = (text || "").split(/\r?\n/);
  const sourceLine = getMarkdownBodyStartLine(text) + bodyLine;
  const line = lines[sourceLine];
  if (line === undefined) return text;

  const match = /^(\s*[-*]\s+\[)([ xX])(\])/.exec(line);
  if (!match) return text;

  const nextMark = match[2].toLocaleLowerCase() === "x" ? " " : "x";
  lines[sourceLine] = `${match[1]}${nextMark}${match[3]}${line.slice(match[0].length)}`;
  return lines.join("\n");
}

export function detectAutocompleteTrigger(text: string, cursor: number): Pick<AutocompleteState, "kind" | "query" | "start" | "end"> | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  if (!isPlainMarkdownCompletionAllowedAt(text, safeCursor)) return null;
  const before = text.slice(0, safeCursor);
  const assetStart = before.lastIndexOf("![[");
  const noteTokenStart = before.lastIndexOf("[[");
  const isAssetToken = assetStart >= 0 && noteTokenStart === assetStart + 1;
  const wikiStart = isAssetToken ? assetStart : noteTokenStart;
  if (wikiStart >= 0) {
    const queryStart = isAssetToken ? wikiStart + 3 : wikiStart + 2;
    const query = before.slice(queryStart);
    if (!query.includes("]]") && !/[\r\n]/.test(query) && !query.includes("[")) {
      return {
        kind: isAssetToken ? "asset" : parseWikiAnchorQuery(query) ? "anchor" : "note",
        query,
        start: wikiStart,
        end: safeCursor,
      };
    }
  }

  const tagMatch = /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]*)$/.exec(before);
  if (tagMatch) {
    const query = tagMatch[2] || "";
    return {
      kind: "tag",
      query,
      start: safeCursor - query.length - 1,
      end: safeCursor,
    };
  }
  return null;
}

export function scoreAutocompleteLabel(label: string, query: string) {
  const text = label.toLocaleLowerCase();
  const q = query.trim().toLocaleLowerCase();
  if (!q) return 20;
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  const index = text.indexOf(q);
  return index >= 0 ? 10 + index : 1000;
}

export function wikiNoteSearchPart(query: string) {
  const index = query.search(/[|#^]/);
  return (index >= 0 ? query.slice(0, index) : query).trim();
}

export function wikiNoteSuffixPart(query: string) {
  const index = query.search(/[|#^]/);
  return index >= 0 ? query.slice(index) : "";
}

export function textWidthForTextarea(textarea: HTMLTextAreaElement, text: string) {
  if (!noteMeasureCanvas) noteMeasureCanvas = document.createElement("canvas");
  const context = noteMeasureCanvas.getContext("2d");
  if (!context) return text.length * 7;
  const style = window.getComputedStyle(textarea);
  context.font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return context.measureText(text.replace(/\t/g, "    ")).width;
}

export function autocompletePopupPosition(textarea: HTMLTextAreaElement, value: string, cursor: number, kind: AutocompleteKind) {
  const rect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const before = value.slice(0, Math.max(0, Math.min(cursor, value.length))).replace(/\r\n/g, "\n");
  const lines = before.split("\n");
  const lineIndex = Math.max(0, lines.length - 1);
  const currentLine = lines[lineIndex] || "";
  const fontSize = Number.parseFloat(style.fontSize) || 14;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.8;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const popupWidth = kind === "note" ? 500 : kind === "asset" ? 360 : kind === "anchor" ? 360 : 300;
  const x = rect.left + paddingLeft + textWidthForTextarea(textarea, currentLine) - textarea.scrollLeft;
  const y = rect.top + paddingTop + lineIndex * lineHeight - textarea.scrollTop + lineHeight + 6;
  return {
    x: Math.min(Math.max(12, x), Math.max(12, window.innerWidth - popupWidth - 12)),
    y: Math.min(Math.max(12, y), Math.max(12, window.innerHeight - 280)),
  };
}

export function createTextareaCaretMeasurer(textarea: HTMLTextAreaElement, value: string) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const span = document.createElement("span");
  const properties = [
    "boxSizing",
    "width",
    "borderLeftWidth",
    "borderRightWidth",
    "borderTopWidth",
    "borderBottomWidth",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "paddingBottom",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "textIndent",
    "wordBreak",
  ] as const;

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.left = "-99999px";
  mirror.style.top = "0";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.width = `${textarea.clientWidth}px`;
  properties.forEach((property) => {
    mirror.style[property] = style[property];
  });
  span.textContent = ".";
  document.body.appendChild(mirror);

  const measure = (position: number) => {
    const safePosition = Math.max(0, Math.min(position, value.length));
    mirror.textContent = value.slice(0, safePosition);
    span.textContent = value.slice(safePosition, safePosition + 1) || ".";
    mirror.appendChild(span);
    return { left: span.offsetLeft, top: span.offsetTop };
  };

  return {
    measure,
    dispose: () => mirror.remove(),
  };
}

export function sourceTextareaPositionFromPoint(textarea: HTMLTextAreaElement, clientX: number, clientY: number) {
  const value = textarea.value || "";
  if (!value) return 0;

  const rect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const fontSize = Number.parseFloat(style.fontSize) || 14;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.8;
  const localX = clientX - rect.left + textarea.scrollLeft;
  const localY = clientY - rect.top + textarea.scrollTop;
  const { measure, dispose } = createTextareaCaretMeasurer(textarea, value);

  try {
    let low = 0;
    let high = value.length;
    let lineProbe = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const point = measure(mid);
      if (point.top <= localY) {
        lineProbe = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const lineTop = measure(lineProbe).top;
    const tolerance = Math.max(2, lineHeight / 3);
    low = 0;
    high = lineProbe;
    let lineStart = lineProbe;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const top = measure(mid).top;
      if (top < lineTop - tolerance) {
        low = mid + 1;
      } else {
        lineStart = mid;
        high = mid - 1;
      }
    }

    low = lineProbe;
    high = value.length;
    let lineEnd = lineProbe;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const top = measure(mid).top;
      if (top <= lineTop + tolerance) {
        lineEnd = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    low = lineStart;
    high = lineEnd;
    let best = lineStart;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const left = measure(mid).left;
      if (left <= localX) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const next = Math.min(value.length, best + 1);
    if (next !== best) {
      const currentLeft = measure(best).left;
      const nextLeft = measure(next).left;
      if (Math.abs(nextLeft - localX) < Math.abs(currentLeft - localX)) return next;
    }
    return best;
  } finally {
    dispose();
  }
}

export type SourceListIndentChange = { from: number; to: number; insert: string };

export type SourceMarkdownListLine = {
  kind: "task" | "unordered" | "ordered";
  indent: string;
  contentStart: number;
  content: string;
  continuation: string;
  number?: number;
  delimiter?: "." | ")";
};

export function parseSourceMarkdownListLine(text: string): SourceMarkdownListLine | null {
  const task = /^(\s*)([-*])(\s+)\[([ xX])\](\s*)(.*)$/.exec(text);
  if (task) {
    const spacingAfterCheckbox = task[5] || " ";
    return {
      kind: "task",
      indent: task[1],
      contentStart: task[1].length + task[2].length + task[3].length + 3 + task[5].length,
      content: task[6] || "",
      continuation: `${task[1]}${task[2]}${task[3]}[ ]${spacingAfterCheckbox}`,
    };
  }

  const unordered = /^(\s*)([-*])(?:([ \t]+)(.*))?$/.exec(text);
  if (unordered) {
    const spacing = unordered[3] || " ";
    return {
      kind: "unordered",
      indent: unordered[1],
      contentStart: unordered[1].length + unordered[2].length + (unordered[3]?.length || 0),
      content: unordered[4] || "",
      continuation: `${unordered[1]}${unordered[2]}${spacing}`,
    };
  }

  const ordered = /^(\s*)(\d+)([.)])(?:([ \t]+)(.*))?$/.exec(text);
  if (ordered) {
    const nextNumber = Number.parseInt(ordered[2], 10) + 1;
    const spacing = ordered[4] || " ";
    return {
      kind: "ordered",
      indent: ordered[1],
      contentStart: ordered[1].length + ordered[2].length + ordered[3].length + (ordered[4]?.length || 0),
      content: ordered[5] || "",
      continuation: `${ordered[1]}${nextNumber}${ordered[3]}${spacing}`,
      number: Number.parseInt(ordered[2], 10),
      delimiter: ordered[3] as "." | ")",
    };
  }

  return null;
}

export function isSourceMarkdownListLine(text: string) {
  return parseSourceMarkdownListLine(text) !== null;
}

export function selectedSourceLineBounds(value: string, start: number, end: number) {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  const effectiveEnd = safeEnd > safeStart && value[safeEnd - 1] === "\n" ? safeEnd - 1 : safeEnd;
  const from = value.lastIndexOf("\n", Math.max(0, safeStart - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", effectiveEnd);
  const to = lineEndIndex === -1 ? value.length : lineEndIndex;
  return { from, to };
}

export function mapSourcePositionThroughChanges(position: number, changes: SourceListIndentChange[]) {
  let next = position;
  for (const change of changes) {
    const removed = change.to - change.from;
    const inserted = change.insert.length;
    const delta = inserted - removed;
    if (change.to <= next) {
      next += delta;
    } else if (change.from < next) {
      next = change.from + inserted;
    } else if (change.from === next && inserted > 0 && removed === 0) {
      next += inserted;
    }
  }
  return Math.max(0, next);
}

export function applySourceTextChanges(value: string, changes: SourceListIndentChange[]) {
  let nextValue = value;
  for (const change of [...changes].reverse()) {
    nextValue = `${nextValue.slice(0, change.from)}${change.insert}${nextValue.slice(change.to)}`;
  }
  return nextValue;
}

export function sourceLineAt(value: string, position: number) {
  const safePosition = Math.max(0, Math.min(position, value.length));
  const from = value.lastIndexOf("\n", Math.max(0, safePosition - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", safePosition);
  const to = lineEndIndex === -1 ? value.length : lineEndIndex;
  return { from, to, text: value.slice(from, to) };
}

export function sourceLineBefore(value: string, lineStart: number) {
  if (lineStart <= 0) return null;
  const to = lineStart - 1;
  const from = value.lastIndexOf("\n", Math.max(0, to - 1)) + 1;
  return { from, to, text: value.slice(from, to) };
}

export function sourceIndentWidth(value: string) {
  return Array.from(value).reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
}

export function renumberFollowingSourceOrderedItems(value: string, lineEnd: number, parsed: SourceMarkdownListLine, nextNumberOverride?: number) {
  if (parsed.kind !== "ordered" || typeof parsed.number !== "number") return [];
  const changes: SourceListIndentChange[] = [];
  const baseIndentWidth = sourceIndentWidth(parsed.indent);
  let nextNumber = nextNumberOverride ?? parsed.number + 2;
  let offset = lineEnd < value.length && value[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;

  while (offset <= value.length) {
    const nextBreak = value.indexOf("\n", offset);
    const to = nextBreak === -1 ? value.length : nextBreak;
    const text = value.slice(offset, to);
    if (text.trim()) {
      const ordered = /^(\s*)(\d+)([.)])(\s+)/.exec(text);
      const lineIndentWidth = sourceIndentWidth(ordered?.[1] || (/^\s*/.exec(text)?.[0] || ""));
      if (lineIndentWidth > baseIndentWidth) {
        if (nextBreak === -1) break;
        offset = to + 1;
        continue;
      }
      if (lineIndentWidth < baseIndentWidth || !ordered || ordered[1] !== parsed.indent || ordered[3] !== parsed.delimiter) break;
      if (lineIndentWidth === baseIndentWidth) {
        const currentNumber = Number.parseInt(ordered[2], 10);
        if (currentNumber !== nextNumber) {
          const from = offset + ordered[1].length;
          changes.push({ from, to: from + ordered[2].length, insert: String(nextNumber) });
        }
        nextNumber += 1;
      }
    }
    if (nextBreak === -1) break;
    offset = to + 1;
  }

  return changes;
}

export function findSourceOrderedRunStart(value: string, line: { from: number; to: number; text: string }, parsed: SourceMarkdownListLine) {
  const baseIndentWidth = sourceIndentWidth(parsed.indent);
  let startLine = line;
  let startParsed = parsed;
  let previous = sourceLineBefore(value, line.from);

  while (previous) {
    if (!previous.text.trim()) {
      previous = sourceLineBefore(value, previous.from);
      continue;
    }
    const previousParsed = parseSourceMarkdownListLine(previous.text);
    const previousIndent = previousParsed?.indent ?? (/^\s*/.exec(previous.text)?.[0] || "");
    const previousIndentWidth = sourceIndentWidth(previousIndent);
    if (previousIndentWidth > baseIndentWidth) {
      previous = sourceLineBefore(value, previous.from);
      continue;
    }
    if (
      previousIndentWidth < baseIndentWidth ||
      previousParsed?.kind !== "ordered" ||
      previousParsed.indent !== parsed.indent ||
      previousParsed.delimiter !== parsed.delimiter
    ) {
      break;
    }
    startLine = previous;
    startParsed = previousParsed;
    previous = sourceLineBefore(value, previous.from);
  }

  return { line: startLine, parsed: startParsed };
}

export function collectSourceOrderedRunRenumberChanges(value: string, candidatePositions: Set<number>, affectedLineStarts: Set<number>) {
  const changes: SourceListIndentChange[] = [];
  const visitedStarts = new Set<number>();

  for (const candidatePosition of candidatePositions) {
    if (candidatePosition < 0 || candidatePosition > value.length) continue;
    const candidateLine = sourceLineAt(value, candidatePosition);
    const candidate = parseSourceMarkdownListLine(candidateLine.text);
    if (candidate?.kind !== "ordered" || typeof candidate.number !== "number") continue;
    const runStart = findSourceOrderedRunStart(value, candidateLine, candidate);
    if (visitedStarts.has(runStart.line.from)) continue;
    visitedStarts.add(runStart.line.from);

    const baseIndentWidth = sourceIndentWidth(runStart.parsed.indent);
    let nextNumber = affectedLineStarts.has(runStart.line.from) ? 1 : runStart.parsed.number ?? 1;
    let offset = runStart.line.from;

    while (offset <= value.length) {
      const line = sourceLineAt(value, offset);
      if (line.text.trim()) {
        const parsed = parseSourceMarkdownListLine(line.text);
        const lineIndent = parsed?.indent ?? (/^\s*/.exec(line.text)?.[0] || "");
        const lineIndentWidth = sourceIndentWidth(lineIndent);
        if (lineIndentWidth > baseIndentWidth) {
          if (line.to >= value.length) break;
          offset = line.to + 1;
          continue;
        }
        if (
          lineIndentWidth < baseIndentWidth ||
          parsed?.kind !== "ordered" ||
          parsed.indent !== runStart.parsed.indent ||
          parsed.delimiter !== runStart.parsed.delimiter
        ) {
          break;
        }
        if (parsed.number !== nextNumber) {
          const from = line.from + parsed.indent.length;
          changes.push({ from, to: from + String(parsed.number).length, insert: String(nextNumber) });
        }
        nextNumber += 1;
      }
      if (line.to >= value.length) break;
      offset = line.to + 1;
    }
  }

  return changes;
}

export function applySourceListIndent(value: string, start: number, end: number, direction: "indent" | "outdent") {
  const bounds = selectedSourceLineBounds(value, start, end);
  const block = value.slice(bounds.from, bounds.to);
  const lines = block.split("\n");
  const changes: SourceListIndentChange[] = [];
  const affectedLineStarts: number[] = [];
  const candidateLineStarts: number[] = [];
  let offset = bounds.from;

  for (const line of lines) {
    if (isSourceMarkdownListLine(line)) {
      if (direction === "indent") {
        changes.push({ from: offset, to: offset, insert: "  " });
        affectedLineStarts.push(offset);
        candidateLineStarts.push(offset, offset + line.length + 1);
      } else if (value.startsWith("  ", offset)) {
        changes.push({ from: offset, to: offset + 2, insert: "" });
        affectedLineStarts.push(offset);
        candidateLineStarts.push(offset, offset + line.length + 1);
      } else if (value.startsWith("\t", offset)) {
        changes.push({ from: offset, to: offset + 1, insert: "" });
        affectedLineStarts.push(offset);
        candidateLineStarts.push(offset, offset + line.length + 1);
      }
    }
    offset += line.length + 1;
  }

  if (!changes.length) return null;
  const indentedValue = applySourceTextChanges(value, changes);
  const mappedAffectedStarts = new Set(affectedLineStarts.map((position) => mapSourcePositionThroughChanges(position, changes)));
  const mappedCandidateStarts = new Set(
    candidateLineStarts
      .filter((position) => position <= value.length)
      .map((position) => mapSourcePositionThroughChanges(position, changes)),
  );
  const renumberChanges = collectSourceOrderedRunRenumberChanges(indentedValue, mappedCandidateStarts, mappedAffectedStarts);
  const nextValue = renumberChanges.length ? applySourceTextChanges(indentedValue, renumberChanges) : indentedValue;
  const nextSelectionStart = mapSourcePositionThroughChanges(mapSourcePositionThroughChanges(start, changes), renumberChanges);
  const nextSelectionEnd = mapSourcePositionThroughChanges(mapSourcePositionThroughChanges(end, changes), renumberChanges);
  return {
    value: nextValue,
    selectionStart: Math.min(nextValue.length, nextSelectionStart),
    selectionEnd: Math.min(nextValue.length, nextSelectionEnd),
  };
}

export function applySourceListEnter(value: string, start: number, end: number) {
  if (start !== end) return null;
  const line = sourceLineAt(value, start);
  const parsed = parseSourceMarkdownListLine(line.text);
  if (!parsed) return null;

  if (!parsed.content.trim()) {
    const changes = [
      { from: line.from, to: line.from + parsed.contentStart, insert: "" },
      ...renumberFollowingSourceOrderedItems(value, line.to, parsed, parsed.number),
    ];
    const nextValue = applySourceTextChanges(value, changes);
    return { value: nextValue, selectionStart: line.from, selectionEnd: line.from };
  }

  const insert = `\n${parsed.continuation}`;
  const changes = [
    { from: start, to: end, insert },
    ...renumberFollowingSourceOrderedItems(value, line.to, parsed),
  ];
  const nextValue = applySourceTextChanges(value, changes);
  const selection = start + insert.length;
  return { value: nextValue, selectionStart: selection, selectionEnd: selection };
}

export function applySourceListBackspace(value: string, start: number, end: number) {
  if (start !== end) return null;
  const line = sourceLineAt(value, start);
  const parsed = parseSourceMarkdownListLine(line.text);
  if (!parsed) return null;

  const contentFrom = line.from + parsed.contentStart;
  if (start !== contentFrom) return null;

  const indentRemove = parsed.indent.startsWith("\t") ? 1 : parsed.indent.startsWith("  ") ? 2 : 0;
  const changes = indentRemove > 0
    ? [{ from: line.from, to: line.from + indentRemove, insert: "" }]
    : [
        { from: line.from, to: contentFrom, insert: "" },
        ...renumberFollowingSourceOrderedItems(value, line.to, parsed, parsed.number),
      ];
  const nextValue = applySourceTextChanges(value, changes);
  const selection = indentRemove > 0 ? start - indentRemove : line.from;
  return { value: nextValue, selectionStart: selection, selectionEnd: selection };
}
