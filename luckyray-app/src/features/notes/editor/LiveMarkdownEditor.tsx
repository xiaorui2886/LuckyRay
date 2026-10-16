import { autocompletion, closeCompletion, completionKeymap, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { materialBlockSelection } from "../../../core/markdown/materialBlockInsertion";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, codeFolding, foldedRanges, foldState, foldGutter, foldKeymap, unfoldEffect, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, getSearchQuery, SearchQuery, setSearchQuery, searchPanelOpen } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap, placeholder, type MouseSelectionStyle } from "@codemirror/view";
import { forwardRef, useContext, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, type MutableRefObject } from "react";
import { NoteFilenameContext, filenameForNote } from "./noteFilename";
import { resolveScopedShortcut } from "../../../app/shortcuts";
import { dismissAttachmentInteraction, liveMarkdownPreview, liveMarkdownTheme, moveAcrossAttachment, selectAdjacentAttachment, toggleTaskCheckboxAt, type LiveMarkdownOptions } from "./liveMarkdownExtensions";
import { extractClipboardImageSource, type ClipboardImageSource } from "./clipboardImages";
import { getDraggedMaterialAsset, hasDraggedMaterialAsset, type DraggedMaterialAsset } from "../../../core/services/assetDrag";
import { isMarkdownTableSeparatorLine } from "../../../core/services/noteRenderer";
import { getWikiAnchorCompletions, parseWikiAnchorQuery } from "./sameNoteAnchors";
import { createWikiCompletionSource, isMarkdownCompletionAllowedAt, renderLiveCompletionLeading } from "./wikiCompletion";
import type { LiveAsset, LiveEditorSelection, LiveEditorTokenContext, LiveNote, LiveNoteEmbed, LiveNoteLink, LiveNoteOpenOptions, LiveTag } from "./types";
import "./liveMarkdown.css";
import { capturePortableLiveEditor, captureNoteScroll, restorePortableLiveEditor, nextNotePresentationFrame, type PortableLiveEditorSnapshot } from "../noteViewPresentation";
import { RetainedEditorViews } from "./retainedEditorViews";
import { isNoteMargin, noteDisplayExtension, useNoteDisplayMenu } from "./noteDisplay";
import { addPreparedAttachment, preparedAttachments, preparedAttachmentHistory, prepareAttachmentInsertions, type PreparedAttachment } from "./preparedAttachment";

/** In-memory, view-scoped state only; never persisted with named layouts. */
export type LiveEditorSessionSnapshot = {
  documentId: string;
  state: EditorState;
  scrollTop: number;
  scrollLeft: number;
};

export type LiveMarkdownEditorHandle = {
  captureSession: () => LiveEditorSessionSnapshot | null;
  capturePortableSession: () => PortableLiveEditorSnapshot;
  restorePortableSession: (snapshot: PortableLiveEditorSnapshot) => Promise<void>;
  isComposing: () => boolean;
  getScrollElement: () => HTMLElement | null;
  renameDocument: (from: string, to: string) => void;
  focus: () => void;
  getValue: () => string;
  getVisibleLines: () => { from: number; to: number } | null;
  getSelection: () => LiveEditorSelection;
  getSelectionCoords: () => { x: number; y: number } | null;
  setSelection: (selection: LiveEditorSelection) => void;
  replaceRange: (text: string, range?: LiveEditorSelection, prepared?: PreparedAttachment | readonly PreparedAttachment[]) => void;
  startCompletion: () => void;
};

const authoritativeSync = Annotation.define<boolean>();

// Blank-space hit testing can resolve into the hidden end of a folded chapter.
// CM unfolds a range touched by a new selection, so clamp pointer selections
// before its fold field sees them. Explicit unfold effects remain untouched.
const preservePointerFolds = EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection || transaction.docChanged || !transaction.isUserEvent("select")) return transaction;
  const folds = foldedRanges(transaction.startState);
  const clamp = (pos: number) => {
    let visible = pos;
    folds.between(pos, pos, (from, to) => {
      if (pos > from && pos < to) visible = transaction.isUserEvent("select.pointer")
        || pos >= transaction.startState.selection.main.head ? to : from;
    });
    return visible;
  };
  const selection = EditorSelection.create(transaction.selection.ranges.map(range =>
    EditorSelection.range(clamp(range.anchor), clamp(range.head))), transaction.selection.mainIndex);
  return selection.eq(transaction.selection) ? transaction : [transaction, { selection, sequential: true }];
});

// Parent projections are recreated during typing. Only changed presentation
// fields should invalidate decorations; completion reads the latest full data.
function usePresentationRecords<T extends object>(records: T[], keys?: readonly (keyof T)[]) {
  const previous = useRef(records);
  if (previous.current.length !== records.length || records.some((record, index) => {
    const before = previous.current[index];
    const fields = keys || Object.keys(record) as (keyof T)[];
    return !before || (!keys && Object.keys(before).length !== fields.length)
      || fields.some(key => before[key] !== record[key]);
  })) previous.current = records;
  return previous.current;
}

/** Preserve unchanged text positions and history when a saved external edit
 * arrives. A save/index echo produces no transaction at all. */
function documentSyncChange(current: string, next: string) {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let to = current.length, nextTo = next.length;
  while (to > from && nextTo > from && current[to - 1] === next[nextTo - 1]) { to--; nextTo--; }
  return { from, to, insert: next.slice(from, nextTo) };
}

export type LiveEditorTableContext = {
  from: number;
  to: number;
  lineOffset: number;
  columnIndex: number;
  rowCount: number;
  columnCount: number;
};

export type LiveEditorShortcutCommand =
  | "bold"
  | "italic"
  | "link"
  | "external-link"
  | "toggle-preview"
  | "toggle-source"
  | "ai-write-menu";

type LiveMarkdownEditorProps = {
  value: string;
  disabled?: boolean;
  readOnly?: boolean;
  placeholderText?: string;
  assets: LiveAsset[];
  notes: LiveNote[];
  tags: LiveTag[];
  noteLinks: LiveNoteLink[];
  noteEmbeds: LiveNoteEmbed[];
  currentNoteId?: string | null;
  restoreSession?: LiveEditorSessionSnapshot | null;
  onSessionCapture?: (snapshot: LiveEditorSessionSnapshot) => void;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onSelectionChange?: (selection: LiveEditorSelection) => void;
  onContextMenu?: (event: MouseEvent, selection: LiveEditorSelection, token?: LiveEditorTokenContext | null, table?: LiveEditorTableContext | null) => void;
  onCommand?: (command: LiveEditorShortcutCommand) => void;
  onOpenAsset?: (assetId: string) => void;
  onOpenNote?: (noteId: string, options?: LiveNoteOpenOptions) => void;
  onCreateNote?: (title: string, options?: LiveNoteOpenOptions) => void;
  onOpenTag?: (tagId: string) => void;
  onCreateTag?: (name: string) => void;
  onInsertFiles?: (files: FileList | File[], selection: LiveEditorSelection) => void | Promise<void>;
  onInsertClipboardImage?: (source: ClipboardImageSource, selection: LiveEditorSelection) => void | Promise<void>;
  onInsertAssetReference?: (asset: DraggedMaterialAsset, selection: LiveEditorSelection) => void | Promise<void>;
};

function clampSelection(selection: LiveEditorSelection, length: number) {
  const start = Math.max(0, Math.min(selection.start, length));
  const end = Math.max(0, Math.min(selection.end, length));
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function updateListIndent(view: EditorView, direction: "indent" | "outdent") {
  const { doc, selection } = view.state;
  const main = selection.main;
  const startLine = doc.lineAt(main.from);
  const endLine = doc.lineAt(main.to);
  const changes: Array<{ from: number; to?: number; insert?: string }> = [];
  const affectedLineNumbers: number[] = [];

  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo += 1) {
    const line = doc.line(lineNo);
    if (!parseMarkdownListLine(line.text)) continue;
    if (direction === "indent") {
      changes.push({ from: line.from, insert: "  " });
      affectedLineNumbers.push(lineNo);
    } else if (line.text.startsWith("  ")) {
      changes.push({ from: line.from, to: line.from + 2, insert: "" });
      affectedLineNumbers.push(lineNo);
    } else if (line.text.startsWith("\t")) {
      changes.push({ from: line.from, to: line.from + 1, insert: "" });
      affectedLineNumbers.push(lineNo);
    }
  }

  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true });
  const renumberCandidates = new Set<number>();
  const affectedSet = new Set(affectedLineNumbers);
  for (const lineNo of affectedLineNumbers) {
    renumberCandidates.add(lineNo);
    if (lineNo + 1 <= view.state.doc.lines) renumberCandidates.add(lineNo + 1);
  }
  const renumberChanges = collectOrderedRunRenumberChanges(view, renumberCandidates, affectedSet);
  if (renumberChanges.length) view.dispatch({ changes: renumberChanges, scrollIntoView: true });
  return true;
}

type MarkdownListLine = {
  kind: "task" | "unordered" | "ordered";
  indent: string;
  contentStart: number;
  content: string;
  continuation: string;
  number?: number;
  delimiter?: "." | ")";
};

function parseMarkdownListLine(text: string): MarkdownListLine | null {
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

function indentWidth(value: string) {
  return Array.from(value).reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
}

function renumberFollowingOrderedItems(view: EditorView, lineNumber: number, parsed: MarkdownListLine, nextNumberOverride?: number) {
  if (parsed.kind !== "ordered" || typeof parsed.number !== "number") return [];
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const baseIndentWidth = indentWidth(parsed.indent);
  let nextNumber = nextNumberOverride ?? parsed.number + 2;

  for (let lineNo = lineNumber + 1; lineNo <= view.state.doc.lines; lineNo += 1) {
    const line = view.state.doc.line(lineNo);
    if (!line.text.trim()) continue;
    const ordered = /^(\s*)(\d+)([.)])(\s+)/.exec(line.text);
    const lineIndentWidth = indentWidth(ordered?.[1] || (/^\s*/.exec(line.text)?.[0] || ""));

    if (lineIndentWidth > baseIndentWidth) continue;
    if (lineIndentWidth < baseIndentWidth || !ordered || ordered[1] !== parsed.indent || ordered[3] !== parsed.delimiter) break;

    const currentNumber = Number.parseInt(ordered[2], 10);
    if (currentNumber !== nextNumber) {
      const from = line.from + ordered[1].length;
      changes.push({ from, to: from + ordered[2].length, insert: String(nextNumber) });
    }
    nextNumber += 1;
  }

  return changes;
}

function findOrderedRunStartLine(view: EditorView, lineNumber: number, parsed: MarkdownListLine) {
  const baseIndentWidth = indentWidth(parsed.indent);
  let startLineNumber = lineNumber;
  let startParsed = parsed;

  for (let lineNo = lineNumber - 1; lineNo >= 1; lineNo -= 1) {
    const line = view.state.doc.line(lineNo);
    if (!line.text.trim()) continue;
    const previous = parseMarkdownListLine(line.text);
    const previousIndent = previous?.indent ?? (/^\s*/.exec(line.text)?.[0] || "");
    const previousIndentWidth = indentWidth(previousIndent);
    if (previousIndentWidth > baseIndentWidth) continue;
    if (
      previousIndentWidth < baseIndentWidth ||
      previous?.kind !== "ordered" ||
      previous.indent !== parsed.indent ||
      previous.delimiter !== parsed.delimiter
    ) {
      break;
    }
    startLineNumber = lineNo;
    startParsed = previous;
  }

  return { lineNumber: startLineNumber, parsed: startParsed };
}

function collectOrderedRunRenumberChanges(view: EditorView, candidateLineNumbers: Set<number>, affectedLineNumbers: Set<number>) {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const visitedStarts = new Set<number>();

  for (const candidateLineNumber of candidateLineNumbers) {
    if (candidateLineNumber < 1 || candidateLineNumber > view.state.doc.lines) continue;
    const candidateLine = view.state.doc.line(candidateLineNumber);
    const candidate = parseMarkdownListLine(candidateLine.text);
    if (candidate?.kind !== "ordered" || typeof candidate.number !== "number") continue;
    const runStart = findOrderedRunStartLine(view, candidateLineNumber, candidate);
    if (visitedStarts.has(runStart.lineNumber)) continue;
    visitedStarts.add(runStart.lineNumber);

    const baseIndentWidth = indentWidth(runStart.parsed.indent);
    let nextNumber = affectedLineNumbers.has(runStart.lineNumber) ? 1 : runStart.parsed.number ?? 1;

    for (let lineNo = runStart.lineNumber; lineNo <= view.state.doc.lines; lineNo += 1) {
      const line = view.state.doc.line(lineNo);
      if (!line.text.trim()) continue;
      const parsed = parseMarkdownListLine(line.text);
      const lineIndent = parsed?.indent ?? (/^\s*/.exec(line.text)?.[0] || "");
      const lineIndentWidth = indentWidth(lineIndent);
      if (lineIndentWidth > baseIndentWidth) continue;
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
  }

  return changes;
}

function handleListEnter(view: EditorView) {
  const { doc, selection } = view.state;
  const main = selection.main;
  if (!main.empty) return false;

  const line = doc.lineAt(main.from);
  const parsed = parseMarkdownListLine(line.text);
  if (!parsed) return false;

  if (!parsed.content.trim()) {
    const contentFrom = line.from + parsed.contentStart;
    view.dispatch({
      changes: [
        { from: line.from, to: contentFrom, insert: "" },
        ...renumberFollowingOrderedItems(view, line.number, parsed, parsed.number),
      ],
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    return true;
  }

  const insert = `\n${parsed.continuation}`;
  const changes = [
    { from: main.from, to: main.to, insert },
    ...renumberFollowingOrderedItems(view, line.number, parsed),
  ];
  view.dispatch({
    changes,
    selection: { anchor: main.from + insert.length },
    scrollIntoView: true,
  });
  return true;
}

function handleListBackspace(view: EditorView) {
  const { doc, selection } = view.state;
  const main = selection.main;
  if (!main.empty) return false;

  const line = doc.lineAt(main.from);
  const parsed = parseMarkdownListLine(line.text);
  if (!parsed) return false;

  const contentFrom = line.from + parsed.contentStart;
  if (main.from !== contentFrom) return false;

  const indentRemove = parsed.indent.startsWith("\t") ? 1 : parsed.indent.startsWith("  ") ? 2 : 0;
  if (indentRemove > 0) {
    view.dispatch({
      changes: { from: line.from, to: line.from + indentRemove, insert: "" },
      selection: { anchor: main.from - indentRemove },
      scrollIntoView: true,
    });
    return true;
  }

  view.dispatch({
    changes: [
      { from: line.from, to: contentFrom, insert: "" },
      ...renumberFollowingOrderedItems(view, line.number, parsed, parsed.number),
    ],
    selection: { anchor: line.from },
    scrollIntoView: true,
  });
  return true;
}

type MarkdownTableRange = {
  from: number;
  to: number;
};

const LIVE_TABLE_SELECT_WHOLE_EVENT = "lr-live-table-select-whole";

function isMarkdownFenceLine(text: string) {
  return /^(```|~~~)/.test(text.trim());
}

function isLineInsideFencedCode(state: EditorState, lineNumber: number) {
  let fenceMarker: string | null = null;

  for (let cursor = 1; cursor < lineNumber; cursor += 1) {
    const match = /^(```|~~~)/.exec(state.doc.line(cursor).text.trim());
    if (!match) continue;
    if (!fenceMarker) fenceMarker = match[1];
    else if (fenceMarker === match[1]) fenceMarker = null;
  }

  return Boolean(fenceMarker);
}

function findMarkdownTableStartingAt(state: EditorState, lineNumber: number): MarkdownTableRange | null {
  const { doc } = state;
  if (lineNumber < 1 || lineNumber >= doc.lines) return null;
  if (isLineInsideFencedCode(state, lineNumber)) return null;

  const headerLine = doc.line(lineNumber);
  const separatorLine = doc.line(lineNumber + 1);
  if (!headerLine.text.trim().includes("|") || !isMarkdownTableSeparatorLine(separatorLine.text)) return null;

  let endLine = separatorLine;
  for (let cursor = lineNumber + 2; cursor <= doc.lines; cursor += 1) {
    const rowLine = doc.line(cursor);
    const rowText = rowLine.text.trim();
    if (!rowText || !rowText.includes("|") || isMarkdownFenceLine(rowText)) break;
    endLine = rowLine;
  }

  return { from: headerLine.from, to: endLine.to };
}

function findMarkdownTableEndingAtLine(state: EditorState, lineNumber: number): MarkdownTableRange | null {
  if (lineNumber < 2) return null;

  for (let cursor = lineNumber - 1; cursor >= 1; cursor -= 1) {
    const table = findMarkdownTableStartingAt(state, cursor);
    if (!table) continue;
    if (state.doc.lineAt(table.to).number === lineNumber) return table;
  }

  return null;
}

function firstContentPosition(line: { from: number; text: string }) {
  return line.from + (/\S/.exec(line.text)?.index ?? line.text.length);
}

function findTableAfterCaret(state: EditorState, position: number) {
  const line = state.doc.lineAt(position);
  const currentTable = findMarkdownTableStartingAt(state, line.number);
  if (currentTable && position <= firstContentPosition(line)) return currentTable;

  const offset = position - line.from;
  if (line.text.slice(offset).trim() === "" && line.number < state.doc.lines) {
    return findMarkdownTableStartingAt(state, line.number + 1);
  }

  return null;
}

function findTableBeforeCaret(state: EditorState, position: number) {
  const line = state.doc.lineAt(position);
  const currentTable = findMarkdownTableEndingAtLine(state, line.number);
  if (currentTable && position >= currentTable.to) return currentTable;

  const offset = position - line.from;
  if (line.text.slice(0, offset).trim() === "" && line.number > 1) {
    return findMarkdownTableEndingAtLine(state, line.number - 1);
  }

  return null;
}

function deleteMarkdownTableRange(view: EditorView, table: MarkdownTableRange) {
  let to = table.to;
  if (to < view.state.doc.length && view.state.doc.sliceString(to, to + 1) === "\n") to += 1;
  view.dispatch({
    changes: { from: table.from, to, insert: "" },
    selection: { anchor: table.from },
    scrollIntoView: true,
  });
  return true;
}

function tableWidgetForRange(view: EditorView, table: MarkdownTableRange) {
  return view.dom.querySelector<HTMLElement>(`.lr-live-table-block[data-lr-table-from="${table.from}"]`);
}

function selectAdjacentMarkdownTable(view: EditorView, table: MarkdownTableRange) {
  const root = tableWidgetForRange(view, table);
  if (!root) return false;
  root.dispatchEvent(new CustomEvent(LIVE_TABLE_SELECT_WHOLE_EVENT));
  return true;
}

function handleBackwardAdjacentMarkdownTable(view: EditorView) {
  const main = view.state.selection.main;
  if (!main.empty) return false;

  const table = findTableBeforeCaret(view.state, main.from);
  if (!table) return false;

  const root = tableWidgetForRange(view, table);
  if (root?.classList.contains("lr-live-table-whole-selected")) return deleteMarkdownTableRange(view, table);
  if (selectAdjacentMarkdownTable(view, table)) return true;
  return deleteMarkdownTableRange(view, table);
}

function deleteAdjacentMarkdownTable(view: EditorView, direction: "backward" | "forward") {
  if (direction === "backward") return handleBackwardAdjacentMarkdownTable(view);

  const main = view.state.selection.main;
  if (!main.empty) return false;

  const table = findTableAfterCaret(view.state, main.from);
  if (!table) return false;
  return deleteMarkdownTableRange(view, table);
}

function shouldStartMarkdownCompletion(state: EditorState) {
  const main = state.selection.main;
  if (!main.empty) return false;
  const pos = main.from;
  if (!isMarkdownCompletionAllowedAt(state, pos)) return false;
  const start = Math.max(0, pos - 160);
  const before = state.sliceDoc(start, pos);

  const assetStart = before.lastIndexOf("![[");
  const noteStart = before.lastIndexOf("[[");
  if (assetStart >= 0 && noteStart === assetStart + 1) {
    const query = before.slice(assetStart + 3);
    return !query.includes("]]") && !/[\r\n]/.test(query);
  }

  if (noteStart >= 0 && before[noteStart - 1] !== "!") {
    const query = before.slice(noteStart + 2);
    return !query.includes("]]") && !/[\r\n]/.test(query) && !query.includes("[");
  }

  return /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]*)$/.test(before);
}

function normalizeLookup(value: string) {
  return value.trim().toLocaleLowerCase();
}

function noteTitle(note: LiveNote) {
  return note.title?.trim() || "";
}

function parseSourceWikiTarget(raw: string) {
  const [targetPart] = raw.split("|");
  const target = targetPart.trim();
  const hashIndex = target.indexOf("#");
  const targetTitle = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).trim();
  const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : "";
  const blockId = subpath.startsWith("^") ? subpath.slice(1).trim() || null : null;
  return {
    targetTitle,
    openOptions: {
      blockId,
      headingPath: blockId ? null : subpath || null,
    },
  };
}

function sourceWikiLinkAtPosition(state: EditorState, pos: number) {
  const safePos = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(safePos);
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line.text)) !== null) {
    if (match.index > 0 && line.text[match.index - 1] === "!") continue;
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (safePos < from || safePos > to) continue;
    if (!isMarkdownCompletionAllowedAt(state, from)) continue;
    return { ...parseSourceWikiTarget(match[1]), from, to };
  }

  return null;
}

function wikiAnchorToken(state: EditorState) {
  const main = state.selection.main;
  if (!main.empty) return null;
  const pos = main.from;
  if (!isMarkdownCompletionAllowedAt(state, pos)) return null;
  const start = Math.max(0, pos - 160);
  const before = state.sliceDoc(start, pos);
  const noteStart = before.lastIndexOf("[[");
  if (noteStart < 0 || before[noteStart - 1] === "!") return null;
  const query = before.slice(noteStart + 2);
  if (!parseWikiAnchorQuery(query) || query.includes("]]") || /[\r\n\[]/.test(query)) return null;
  return {
    from: start + noteStart + 2,
    to: pos,
    query,
  };
}

function completeWikiAnchor(view: EditorView, notes: LiveNote[]) {
  if (view.composing) return false;
  const token = wikiAnchorToken(view.state);
  if (!token) return false;
  const parsed = parseWikiAnchorQuery(token.query);
  const targetNote = parsed?.noteTitle
    ? notes.find((note) => normalizeLookup(noteTitle(note)) === normalizeLookup(parsed.noteTitle || ""))
    : null;
  const anchorSource = parsed?.noteTitle ? targetNote?.contentText || "" : view.state.doc.toString();
  const [anchor] = getWikiAnchorCompletions(anchorSource, token.query);
  if (!anchor) return false;
  const insert = `${anchor.insertText}]]`;
  view.dispatch({
    changes: { from: token.from, to: token.to, insert },
    selection: { anchor: token.from + insert.length },
    scrollIntoView: true,
  });
  return true;
}

function runWhenNotComposing(view: EditorView, command: (editorView: EditorView) => boolean) {
  if (view.composing) return false;
  return command(view);
}

function letCompletionHandleKey(view: EditorView) {
  const status = completionStatus(view.state);
  return status === "active" || status === "pending";
}

function runShortcutCommand(commandRef: MutableRefObject<LiveMarkdownEditorProps["onCommand"]>, command: LiveEditorShortcutCommand) {
  const onCommand = commandRef.current;
  if (!onCommand) return false;
  onCommand(command);
  return true;
}

function tokenContextFromEventTarget(target: EventTarget | null): LiveEditorTokenContext | null {
  const element = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-lr-token-kind]") : null;
  if (!element) return null;
  const kind = element.dataset.lrTokenKind;
  if (kind !== "asset" && kind !== "note" && kind !== "tag" && kind !== "external") return null;
  const from = Number(element.dataset.lrTokenFrom);
  const to = Number(element.dataset.lrTokenTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) return null;
  return {
    kind,
    from,
    to,
    label: element.dataset.lrTokenLabel || "",
    href: element.dataset.lrTokenHref || null,
    assetId: element.dataset.lrTokenAssetId || null,
    noteId: element.dataset.lrTokenNoteId || null,
    tagId: element.dataset.lrTokenTagId || null,
    createTitle: element.dataset.lrTokenCreateTitle || null,
    openOptions: kind === "note" ? {
      blockId: element.dataset.lrTokenBlockId || null,
      headingPath: element.dataset.lrTokenHeadingPath || null,
    } : undefined,
    missing: element.dataset.lrTokenMissing === "1",
  };
}

function nearestTableCellFromPoint(table: HTMLElement, x: number, y: number) {
  const pointed = typeof table.ownerDocument.elementsFromPoint === "function"
    ? table.ownerDocument.elementsFromPoint(x, y)
    : [];
  for (const element of pointed) {
    if (!(element instanceof HTMLElement)) continue;
    const cell = element.closest<HTMLElement>("[data-lr-table-line-offset][data-lr-table-column]");
    if (cell && table.contains(cell)) return cell;
  }

  const focusedCell = table.querySelector<HTMLElement>(".lr-live-table-cell-editor:focus")?.closest<HTMLElement>("[data-lr-table-line-offset][data-lr-table-column]");
  if (focusedCell) return focusedCell;

  let nearestCell: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  table.querySelectorAll<HTMLElement>("[data-lr-table-line-offset][data-lr-table-column]").forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestCell = cell;
      nearestDistance = distance;
    }
  });
  return nearestCell;
}

function tableContextFromEvent(event: MouseEvent): LiveEditorTableContext | null {
  const element = event.target instanceof HTMLElement ? event.target : event.target instanceof Node ? event.target.parentElement : null;
  const table = element?.closest<HTMLElement>(".lr-live-table-block");
  const cell = table
    ? element?.closest<HTMLElement>("[data-lr-table-line-offset][data-lr-table-column]") || nearestTableCellFromPoint(table, event.clientX, event.clientY)
    : null;
  if (!cell || !table) return null;
  const from = Number(table.dataset.lrTableFrom);
  const to = Number(table.dataset.lrTableTo);
  const lineOffset = Number(cell.dataset.lrTableLineOffset);
  const columnIndex = Number(cell.dataset.lrTableColumn);
  const rowCount = Number(table.dataset.lrTableRows);
  const columnCount = Number(table.dataset.lrTableColumns);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(lineOffset) || !Number.isFinite(columnIndex) || !Number.isFinite(rowCount) || !Number.isFinite(columnCount)) return null;
  if (from < 0 || to < from || lineOffset < 0 || columnIndex < 0 || rowCount < 0 || columnCount < 1) return null;
  return { from, to, lineOffset, columnIndex, rowCount, columnCount };
}

type PreciseClickAnchor = {
  x: number;
  y: number;
  lineRange: { from: number; to: number } | null;
  nativePos: number | null;
};

const PRECISE_CLICK_DRAG_TOLERANCE = 4;
const CARET_COORD_MATCH_TOLERANCE = 18;

function elementFromEventTarget(target: EventTarget | null) {
  if (target instanceof HTMLElement) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isPlainEditorClickTarget(target: EventTarget | null) {
  const element = elementFromEventTarget(target);
  if (!element?.closest(".cm-content")) return false;
  return !element.closest([
    "[data-lr-token-kind]",
    "[data-lr-task-checkbox]",
    "[contenteditable='false']",
    "button",
    "input",
    "select",
    "textarea",
    "a",
    ".cm-tooltip",
    ".cm-panel",
  ].join(","));
}

function clickDistanceExceeded(click: PreciseClickAnchor, event: MouseEvent) {
  return Math.abs(event.clientX - click.x) > PRECISE_CLICK_DRAG_TOLERANCE
    || Math.abs(event.clientY - click.y) > PRECISE_CLICK_DRAG_TOLERANCE;
}

function nativeTextCaretPositionAt(view: EditorView, x: number, y: number) {
  const ownerDocument = view.dom.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = ownerDocument.caretPositionFromPoint?.(x, y);
  let node = position?.offsetNode || null;
  let offset = position?.offset ?? 0;
  if (!node) {
    const range = ownerDocument.caretRangeFromPoint?.(x, y) || null;
    node = range?.startContainer || null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || !view.dom.contains(node)) return null;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  if (!element?.closest(".cm-content") || element.closest("[contenteditable='false']")) return null;
  try {
    return view.posAtDOM(node, offset);
  } catch {
    return null;
  }
}

function lineElementFromPoint(view: EditorView, target: EventTarget | null, x: number, y: number) {
  const targetElement = elementFromEventTarget(target);
  const targetLine = targetElement?.closest<HTMLElement>(".cm-line") || null;
  if (targetLine && view.contentDOM.contains(targetLine)) return targetLine;

  const ownerDocument = view.dom.ownerDocument;
  const elements = typeof ownerDocument.elementsFromPoint === "function"
    ? ownerDocument.elementsFromPoint(x, y)
    : [];
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    const line = element.closest<HTMLElement>(".cm-line");
    if (line && view.contentDOM.contains(line)) return line;
  }
  return null;
}

function lineRangeFromElement(view: EditorView, lineElement: HTMLElement) {
  try {
    const startPos = view.posAtDOM(lineElement, 0);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(startPos, view.state.doc.length)));
    return { from: line.from, to: line.to };
  } catch {
    return null;
  }
}

function lineRangeFromClick(view: EditorView, target: EventTarget | null, x: number, y: number) {
  const lineElement = lineElementFromPoint(view, target, x, y);
  return lineElement ? lineRangeFromElement(view, lineElement) : null;
}

function nearestCaretPositionInRange(view: EditorView, from: number, to: number, x: number, y: number, fallbackPos?: number | null) {
  const safeFrom = Math.max(0, Math.min(from, view.state.doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, view.state.doc.length));
  if (safeFrom === safeTo) return safeFrom;

  let bestPos = typeof fallbackPos === "number" ? Math.max(safeFrom, Math.min(fallbackPos, safeTo)) : safeFrom;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let pos = safeFrom; pos <= safeTo; pos += 1) {
    const sides: Array<1 | -1> = pos === safeTo ? [-1, 1] : [1, -1];
    for (const side of sides) {
      const rect = view.coordsAtPos(pos, side);
      if (!rect) continue;
      const yPenalty = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const score = Math.abs(rect.left - x) + yPenalty * 8;
      if (score < bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
  }

  return bestPos;
}

function nearestLineCaretPositionAt(view: EditorView, x: number, y: number) {
  const rough = view.posAtCoords({ x, y });
  if (typeof rough !== "number") return null;
  const line = view.state.doc.lineAt(Math.max(0, Math.min(rough, view.state.doc.length)));
  return nearestCaretPositionInRange(view, line.from, line.to, x, y, rough);
}

function caretPositionMatchesClick(view: EditorView, pos: number, x: number, y: number) {
  const rect = view.coordsAtPos(pos);
  if (!rect) return false;
  const yClose = y >= rect.top - CARET_COORD_MATCH_TOLERANCE && y <= rect.bottom + CARET_COORD_MATCH_TOLERANCE;
  return yClose && Math.abs(rect.left - x) <= CARET_COORD_MATCH_TOLERANCE;
}

function assetTrailingBlankCaretPositionAt(view: EditorView, x: number, y: number) {
  const cards = Array.from(view.dom.querySelectorAll<HTMLElement>(".lr-live-asset-card[data-lr-token-from]"));
  const candidate = cards
    .map((card) => ({
      card,
      rect: card.getBoundingClientRect(),
      from: Number(card.dataset.lrTokenFrom),
      to: Number(card.dataset.lrTokenTo),
    }))
    .filter(({ rect, from, to }) => (
      Number.isFinite(from)
      && Number.isFinite(to)
      && x >= rect.right
      && y >= rect.top
      && y <= rect.bottom
    ))
    .sort((left, right) => right.rect.right - left.rect.right)[0];
  return candidate
    ? { before: candidate.to, to: candidate.to }
    : null;
}

function preciseCaretPositionAt(view: EditorView, x: number, y: number, hint?: { lineRange?: { from: number; to: number } | null; nativePos?: number | null }) {
  // A folded visual line spans several source lines. Blank clicks beneath it
  // belong after its placeholder, not to the nearest character on the heading
  // source line (the generic text hit tester below only knows that source line).
  const block = view.lineBlockAtHeight(y - view.documentTop);
  let foldedTail: number | undefined;
  foldedRanges(view.state).between(block.from, block.to, (from, to) => {
    if (to !== block.to) return;
    const end = view.coordsAtPos(to, 1);
    const start = view.coordsAtPos(from, -1);
    if (end && start && (y > Math.max(start.bottom, end.bottom)
      || (y >= Math.min(start.top, end.top) && x >= end.right))) foldedTail = to;
  });
  if (foldedTail !== undefined) return foldedTail;
  const nativePos = hint?.nativePos ?? nativeTextCaretPositionAt(view, x, y);
  const trailingAsset = assetTrailingBlankCaretPositionAt(view, x, y);
  // Preserve an actual trailing-text click. Only repair blank coordinates (or
  // replacement-internal coordinates) that CodeMirror maps at/inside the token.
  if (trailingAsset && (typeof nativePos !== "number" || nativePos <= trailingAsset.to)) {
    return trailingAsset.before;
  }
  const pos = typeof nativePos === "number" && caretPositionMatchesClick(view, nativePos, x, y)
    ? nativePos
    : hint?.lineRange
      ? nearestCaretPositionInRange(view, hint.lineRange.from, hint.lineRange.to, x, y, nativePos)
    : nearestLineCaretPositionAt(view, x, y);
  if (typeof pos !== "number") return;
  return Math.max(0, Math.min(pos, view.state.doc.length));
}

function preciseMouseSelectionStyle(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  const target = elementFromEventTarget(event.target);
  const card = target?.closest<HTMLElement>(".lr-live-asset-card[data-lr-token-from]");
  if (event.button !== 0 || event.detail !== 1 || target?.closest("button, video, .lr-live-asset-resize")) return null;
  if (!card && (event.shiftKey || !isPlainEditorClickTarget(event.target))) return null;
  const cardRange = card ? { from: Number(card.dataset.lrTokenFrom), to: Number(card.dataset.lrTokenTo) } : null;
  const start: PreciseClickAnchor = {
    x: event.clientX,
    y: event.clientY,
    lineRange: lineRangeFromClick(view, event.target, event.clientX, event.clientY),
    nativePos: nativeTextCaretPositionAt(view, event.clientX, event.clientY),
  };
  const initialStartPos = cardRange?.from ?? preciseCaretPositionAt(view, event.clientX, event.clientY, start);
  if (typeof initialStartPos !== "number") return null;
  let startPos = initialStartPos;
  let startSelection = view.state.selection;

  return {
    get: (curEvent, extend, multiple) => {
      const dragging = clickDistanceExceeded(start, curEvent);
      if (cardRange && !dragging) {
        const range = EditorSelection.range(cardRange.from, cardRange.to);
        if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to));
        return multiple ? startSelection.addRange(range) : EditorSelection.create([range]);
      }
      const endHint = dragging ? {
        lineRange: lineRangeFromClick(view, curEvent.target, curEvent.clientX, curEvent.clientY),
        nativePos: nativeTextCaretPositionAt(view, curEvent.clientX, curEvent.clientY),
      } : start;
      let endPos = dragging
        ? preciseCaretPositionAt(view, curEvent.clientX, curEvent.clientY, endHint) ?? startPos
        : startPos;
      // A pointer inside a rendered attachment selects that attachment, never
      // half its hidden Markdown (which would collapse it during the drag).
      if (dragging) {
        for (const media of view.dom.querySelectorAll<HTMLElement>(".lr-live-asset-card[data-lr-token-from]")) {
          const rect = media.getBoundingClientRect();
          if (curEvent.clientY < rect.top || curEvent.clientY > rect.bottom || curEvent.clientX < rect.left || curEvent.clientX > rect.right) continue;
          const from = Number(media.dataset.lrTokenFrom), to = Number(media.dataset.lrTokenTo);
          endPos = startPos >= to ? from : to;
          break;
        }
      }
      const anchor = cardRange && endPos < cardRange.from ? cardRange.to : startPos;
      const range = anchor === endPos ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, endPos);
      if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to, range.assoc));
      if (multiple) return startSelection.addRange(range);
      return EditorSelection.create([range]);
    },
    update: (update) => {
      if (!update.docChanged) return false;
      startPos = update.changes.mapPos(startPos);
      if (cardRange) {
        cardRange.from = update.changes.mapPos(cardRange.from);
        cardRange.to = update.changes.mapPos(cardRange.to);
      }
      startSelection = startSelection.map(update.changes);
      if (start.lineRange) {
        start.lineRange = {
          from: update.changes.mapPos(start.lineRange.from),
          to: update.changes.mapPos(start.lineRange.to),
        };
      }
      if (typeof start.nativePos === "number") start.nativePos = update.changes.mapPos(start.nativePos);
      return true;
    },
  };
}

export const LiveMarkdownEditor = forwardRef<LiveMarkdownEditorHandle, LiveMarkdownEditorProps>(function LiveMarkdownEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const viewExtensions = useRef(new WeakMap<EditorView, Extension>());
  const scrollPositions=useRef(new WeakMap<EditorView,{top:number;left:number}>());
  const retainedViews = useRef(new RetainedEditorViews());
  const pendingViewRename = useRef<{ from: string; to: string } | null>(null);
  const valueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const onFocusRef = useRef(props.onFocus);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const onContextMenuRef = useRef(props.onContextMenu);
  const onCommandRef = useRef(props.onCommand);
  const onInsertFilesRef = useRef(props.onInsertFiles);
  const onInsertClipboardImageRef = useRef(props.onInsertClipboardImage);
  const onInsertAssetReferenceRef = useRef(props.onInsertAssetReference);
  const onOpenNoteRef = useRef(props.onOpenNote);
  const onCreateNoteRef = useRef(props.onCreateNote);
  const notesRef = useRef(props.notes);
  const noteLinksRef = useRef(props.noteLinks);
  const currentNoteIdRef = useRef(props.currentNoteId);
  const onSessionCaptureRef = useRef(props.onSessionCapture);
  onSessionCaptureRef.current = props.onSessionCapture;
  const captureSession = (view: EditorView, documentId: string): LiveEditorSessionSnapshot => {
    const scroll=captureNoteScroll(view.scrollDOM,scrollPositions.current.get(view));
    return {documentId,state:view.state,scrollTop:scroll.top,scrollLeft:scroll.left};
  };
  const livePreviewCompartment = useMemo(() => new Compartment(), []);
  const completionCompartment = useMemo(() => new Compartment(), []);
  const editableCompartment = useMemo(() => new Compartment(), []);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  const displayCompartment = useMemo(() => new Compartment(), []);
  const display = useNoteDisplayMenu();
  const displayRef = useRef(display);
  displayRef.current = display;
  const displayTitle = filenameForNote(props.currentNoteId, props.notes.find(note => note.id === props.currentNoteId)?.title || "未命名笔记");
  const filenameActions = useContext(NoteFilenameContext);
  const readOnly = Boolean(props.readOnly || (props.currentNoteId && filenameActions?.busyId === props.currentNoteId));
  const filenameActionsRef = useRef(filenameActions);
  filenameActionsRef.current = filenameActions;
  const naming = Boolean(props.currentNoteId && filenameActions?.namingId === props.currentNoteId && !props.readOnly);
  const displayExtension = () => noteDisplayExtension(display.preferences, displayTitle, props.currentNoteId || "", () => props.readOnly ? null : filenameActionsRef.current, naming);

  onChangeRef.current = props.onChange;
  onFocusRef.current = props.onFocus;
  onSelectionChangeRef.current = props.onSelectionChange;
  onContextMenuRef.current = props.onContextMenu;
  onCommandRef.current = props.onCommand;
  onInsertFilesRef.current = props.onInsertFiles;
  onInsertClipboardImageRef.current = props.onInsertClipboardImage;
  onInsertAssetReferenceRef.current = props.onInsertAssetReference;
  onOpenNoteRef.current = props.onOpenNote;
  onCreateNoteRef.current = props.onCreateNote;
  notesRef.current = props.notes;
  noteLinksRef.current = props.noteLinks;
  currentNoteIdRef.current = props.currentNoteId;

  const latestProps = useRef(props);
  latestProps.current = props;
  const presentationAssets = usePresentationRecords(props.assets);
  const presentationNotes = usePresentationRecords(props.notes, ['id', 'title']);
  const presentationTags = usePresentationRecords(props.tags);
  const presentationLinks = usePresentationRecords(props.noteLinks);
  const presentationEmbeds = usePresentationRecords(props.noteEmbeds);
  const liveOptions: LiveMarkdownOptions = useMemo(() => ({
    assets: presentationAssets,
    notes: presentationNotes,
    tags: presentationTags,
    noteLinks: presentationLinks,
    noteEmbeds: presentationEmbeds,
    currentNoteId: props.currentNoteId,
    onOpenAsset: (id) => latestProps.current.onOpenAsset?.(id),
    onOpenNote: (id, options) => latestProps.current.onOpenNote?.(id, options),
    onCreateNote: (title, options) => latestProps.current.onCreateNote?.(title, options),
    onOpenTag: (id) => latestProps.current.onOpenTag?.(id),
    onCreateTag: (name) => latestProps.current.onCreateTag?.(name),
    onTokenContextMenu: (event, token) => {
      const main = viewRef.current?.state.selection.main;
      onContextMenuRef.current?.(
        event,
        main ? { start: Math.min(main.from, main.to), end: Math.max(main.from, main.to) } : { start: token.from, end: token.to },
        token,
      );
    },
  }), [presentationAssets, presentationNotes, presentationTags, presentationLinks, presentationEmbeds, props.currentNoteId]);
  const completionExtension = useMemo(() => autocompletion({
    override: [(context) => createWikiCompletionSource(latestProps.current)(context)],
    activateOnTyping: false,
    icons: false,
    addToOptions: [{ position: 20, render: renderLiveCompletionLeading }],
  }), []);

  useImperativeHandle(ref, () => ({
    captureSession: () => viewRef.current ? captureSession(viewRef.current, currentNoteIdRef.current || "empty") : null,
    capturePortableSession: () => {
      const view = viewRef.current;
      if (!view || view.composing) throw new Error("Note editor is not ready for capture");
      return capturePortableLiveEditor(view.state,captureNoteScroll(view.scrollDOM,scrollPositions.current.get(view)));
    },
    restorePortableSession: async snapshot => {
      const view = viewRef.current;
      const extensions = view && viewExtensions.current.get(view);
      if (!view || !extensions || view.composing) throw new Error("Note editor is not ready for restore");
      const currentState=view.state;
      const currentCompartments=[livePreviewCompartment,completionCompartment,editableCompartment,readOnlyCompartment,placeholderCompartment,displayCompartment]
        .map(compartment=>compartment.reconfigure(compartment.get(currentState)||[]));
      const state = restorePortableLiveEditor(snapshot, currentState.doc.toString(), [extensions,preparedAttachments.init(()=>[])])
        .update({effects:currentCompartments}).state;
      view.setState(state);scrollPositions.current.set(view,snapshot.scroll);
      if (snapshot.search.panelOpen && !openSearchPanel(view)) throw new Error("Search panel restore was not acknowledged");
      // Opening CM's panel may seed its query from the selected text.
      view.dispatch({effects:setSearchQuery.of(new SearchQuery(snapshot.search))});
      await nextNotePresentationFrame();
      if (viewRef.current !== view || view.state.doc.toString() !== snapshot.state.doc) throw new Error("Note changed while restoring editor state");
      view.scrollDOM.scrollTop = snapshot.scroll.top;
      view.scrollDOM.scrollLeft = snapshot.scroll.left;
      await nextNotePresentationFrame();
      if (viewRef.current !== view || !view.state.selection.eq(state.selection) || !getSearchQuery(view.state).eq(new SearchQuery(snapshot.search)) || searchPanelOpen(view.state)!==snapshot.search.panelOpen) throw new Error("Editor restore was not acknowledged");
    },
    isComposing: () => Boolean(viewRef.current?.composing),
    getScrollElement: () => viewRef.current?.scrollDOM || null,
    renameDocument: (from, to) => {
      retainedViews.current.rename(from, to);
      if (currentNoteIdRef.current === from) pendingViewRename.current = { from, to };
    },
    focus: () => viewRef.current?.focus(),
    getValue: () => viewRef.current?.state.doc.toString() ?? valueRef.current,
    getVisibleLines: () => {
      const view = viewRef.current;
      if (!view) return null;
      const rect = view.scrollDOM.getBoundingClientRect();
      const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
      const line = (y: number) => view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, y - view.documentTop)).from).number;
      return { from: line(top), to: line(Math.max(top, bottom)) };
    },
    getSelection: () => {
      const main = viewRef.current?.state.selection.main;
      return main ? { start: Math.min(main.from, main.to), end: Math.max(main.from, main.to) } : { start: valueRef.current.length, end: valueRef.current.length };
    },
    getSelectionCoords: () => {
      const view = viewRef.current;
      const head = view?.state.selection.main.head;
      if (!view || typeof head !== "number") return null;
      const rect = view.coordsAtPos(head);
      return rect ? { x: rect.left, y: rect.bottom + 6 } : null;
    },
    setSelection: (selection) => {
      const view = viewRef.current;
      if (!view) return;
      const safe = clampSelection(selection, view.state.doc.length);
      view.dispatch({ selection: EditorSelection.range(safe.start, safe.end), scrollIntoView: true });
      view.focus();
    },
    replaceRange: (text, range, prepared) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.selection.main;
      const safe = clampSelection(range || { start: current.from, end: current.to }, view.state.doc.length);
      const receipts = prepared ? Array.isArray(prepared) ? prepared : [prepared] : [];
      // Reuse existing separator newlines rather than typing on the token when
      // insertion didn't need to append its own suffix.
      const nextCursor = receipts.length
        ? materialBlockSelection(view.state.doc.toString(), text, safe).start
        : safe.start + text.length;
      const changes = view.state.changes({ from: safe.start, to: safe.end, insert: text });
      const snapshot = receipts.length ? view.scrollSnapshot().map(changes) : undefined;
      view.dispatch({
        changes,
        effects: [...prepareAttachmentInsertions(receipts, safe.start, text).map((item) => addPreparedAttachment.of(item)), ...(snapshot ? [snapshot] : [])],
        selection: { anchor: nextCursor },
        scrollIntoView: !receipts.length,
      });
      view.focus();
    },
    startCompletion: () => {
      const view = viewRef.current;
      if (view && !view.composing) startCompletion(view);
    },
  }), []);

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const key = props.currentNoteId || "empty";
    const detach = (view: EditorView) => {
      const rename = pendingViewRename.current;
      if (rename?.from === key && currentNoteIdRef.current === rename.to) {
        pendingViewRename.current = null;
        return;
      }
      onSessionCaptureRef.current?.(captureSession(view, key));
      retainedViews.current.detach(view);
      if (viewRef.current === view) viewRef.current = null;
    };
    if (viewRef.current) {
      const current = viewRef.current;
      return () => detach(current);
    }
    const reused = retainedViews.current.take(key);
    if (reused) {
      viewRef.current = reused;
      hostRef.current.appendChild(reused.dom);
      retainedViews.current.restoreScroll(reused);
      retainedViews.current.trim(key);
      reused.requestMeasure();
      return () => detach(reused);
    }

    const updateSelection = (view: EditorView) => {
      const main = view.state.selection.main;
      onSelectionChangeRef.current?.({ start: Math.min(main.from, main.to), end: Math.max(main.from, main.to) });
    };

    // Restore only document-owned fields into this instance's NEW extension
    // configuration. Reusing an old EditorState would keep its stale callbacks.
    const saved = props.restoreSession;
    const session = saved?.documentId === key && saved.state.doc.toString() === props.value ? saved : null;
    const extensions: Extension = [
          highlightSpecialChars(),
          history(),
          ...(session ? [historyField.init(() => session.state.field(historyField))] : []),
          preparedAttachments,
          ...(session ? [preparedAttachments.init(() => session.state.field(preparedAttachments))] : []),
          preparedAttachmentHistory,
          dropCursor(),
          bracketMatching(),
          search(),
          markdown(),
          codeFolding(),
          ...(session?.state.field(foldState, false) ? [foldState.init(() => session.state.field(foldState))] : []),
          preservePointerFolds,
          EditorView.atomicRanges.of(view => foldedRanges(view.state)),
          Prec.highest(keymap.of([{ key: "Enter", run: view => {
            const cursor = view.state.selection.main;
            if (!cursor.empty || view.composing) return false;
            let range: { from: number; to: number } | undefined;
            foldedRanges(view.state).between(cursor.head, cursor.head, (from, to) => {
              if (to === cursor.head && (!range || from < range.from)) range = { from, to };
            });
            if (!range) return false;
            view.dispatch({ effects: unfoldEffect.of(range), selection: { anchor: range.from }, scrollIntoView: true });
            return true;
          } }])),
          foldGutter({ markerDOM: open => {
            const button = document.createElement("button");
            button.type = "button";
            button.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="${open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            button.setAttribute("aria-label", open ? "折叠章节" : "展开章节");
            button.setAttribute("aria-expanded", String(open));
            return button;
          } }),
          keymap.of(foldKeymap),
          EditorView.updateListener.of(update => {
            // CM gutters default to decorative. Our fold markers are actual
            // keyboard-operable buttons and must be exposed to accessibility.
            update.view.dom.querySelector(".cm-gutters")?.removeAttribute("aria-hidden");
          }),
          displayCompartment.of(displayExtension()),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          Prec.highest(keymap.of([
            {
              key: "Backspace",
              run: (editorView) => runWhenNotComposing(editorView, (view) => selectAdjacentAttachment(view, "backward") || deleteAdjacentMarkdownTable(view, "backward") || handleListBackspace(view)),
            },
            {
              key: "Delete",
              run: (editorView) => runWhenNotComposing(editorView, (view) => selectAdjacentAttachment(view, "forward") || deleteAdjacentMarkdownTable(view, "forward")),
            },
            {
              key: "Escape",
              run: (editorView) => runWhenNotComposing(editorView, (view) => !completionStatus(view.state) && dismissAttachmentInteraction(view)),
            },
            {
              key: "Enter",
              run: (editorView) => runWhenNotComposing(editorView, (view) => {
                if (letCompletionHandleKey(view)) return false;
                return completeWikiAnchor(view, notesRef.current) || handleListEnter(view);
              }),
            },
            {
              key: "Tab",
              run: (editorView) => runWhenNotComposing(editorView, (view) => {
                if (letCompletionHandleKey(view)) return false;
                return completeWikiAnchor(view, notesRef.current) || updateListIndent(view, "indent");
              }),
              shift: (editorView) => runWhenNotComposing(editorView, (view) => {
                if (letCompletionHandleKey(view)) return false;
                return updateListIndent(view, "outdent");
              }),
            },
          ])),
          keymap.of([
            ...searchKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          drawSelection(),
          Prec.highest(keymap.of([
            { key: "ArrowRight", run: view => !view.composing && moveAcrossAttachment(view, true) },
            { key: "ArrowLeft", run: view => !view.composing && moveAcrossAttachment(view, false) },
            { key: "ArrowDown", run: view => {
              if (view.composing || letCompletionHandleKey(view)) return false;
              // EOF is a logical boundary, not a DOM coordinate lookup. In a
              // tall/refreshing media line, falling through to vertical hit
              // testing can remap the caret and scroll it elsewhere.
              const { ranges, main } = view.state.selection;
              if (ranges.length === 1 && main.empty && main.head === view.state.doc.length) return true;
              return moveAcrossAttachment(view, true);
            } },
            { key: "ArrowUp", run: view => !view.composing && !letCompletionHandleKey(view) && moveAcrossAttachment(view, false) },
          ])),
          EditorView.mouseSelectionStyle.of(preciseMouseSelectionStyle),
          liveMarkdownTheme,
          placeholderCompartment.of(placeholder(props.placeholderText || "")),
          EditorView.updateListener.of((update) => {
            if (viewRef.current !== update.view) return;
            if (update.docChanged) retainedViews.current.trim(currentNoteIdRef.current || 'empty');
            if (update.transactions.some((transaction) => transaction.annotation(authoritativeSync))) return;
            if (update.docChanged) {
              const next = update.state.doc.toString();
              valueRef.current = next;
              onChangeRef.current(next);
              if (!update.view.composing && shouldStartMarkdownCompletion(update.state)) {
                window.setTimeout(() => {
                  if (viewRef.current === update.view && !update.view.composing && shouldStartMarkdownCompletion(update.view.state)) {
                    startCompletion(update.view);
                  }
                }, 0);
              }
            }
            if (update.selectionSet || update.docChanged) updateSelection(update.view);
          }),
          EditorView.domEventHandlers({
            keydown: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              const command = resolveScopedShortcut(event, "knowledge", undefined, {
                ids: [
                  "knowledgeBold",
                  "knowledgeItalic",
                  "knowledgeLink",
                  "knowledgeExternalLink",
                  "knowledgePreview",
                  "knowledgeSource",
                  "knowledgeAiWrite",
                  "knowledgeAutocomplete",
                ],
              });
              if (!command) return false;
              event.preventDefault();
              event.stopPropagation();
              if (command === "knowledgeAutocomplete") startCompletion(editorView);
              if (command === "knowledgeBold") runShortcutCommand(onCommandRef, "bold");
              if (command === "knowledgeItalic") runShortcutCommand(onCommandRef, "italic");
              if (command === "knowledgeLink") runShortcutCommand(onCommandRef, "link");
              if (command === "knowledgeExternalLink") runShortcutCommand(onCommandRef, "external-link");
              if (command === "knowledgePreview") runShortcutCommand(onCommandRef, "toggle-preview");
              if (command === "knowledgeSource") runShortcutCommand(onCommandRef, "toggle-source");
              if (command === "knowledgeAiWrite") runShortcutCommand(onCommandRef, "ai-write-menu");
              return true;
            },
            focus: (_event, editorView) => {
              if (viewRef.current !== editorView) return true;
              onFocusRef.current?.();
              return false;
            },
            blur: (_event, editorView) => {
              if (viewRef.current === editorView && !editorView.composing) dismissAttachmentInteraction(editorView);
              return false;
            },
            compositionstart: (_event, editorView) => {
              closeCompletion(editorView);
              return false;
            },
            mousedown: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              if (event.button !== 0) return false;
              const target = event.target instanceof HTMLElement ? event.target : null;
              if (event.ctrlKey || event.metaKey) {
                const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
                const token = typeof pos === "number" ? sourceWikiLinkAtPosition(editorView.state, pos) : null;
                if (token) {
                  const sameNoteAnchor = !token.targetTitle && Boolean(token.openOptions.blockId || token.openOptions.headingPath);
                  const note = token.targetTitle
                    ? notesRef.current.find((item) => normalizeLookup(noteTitle(item)) === normalizeLookup(token.targetTitle)) || null
                    : null;
                  const link = token.targetTitle
                    ? noteLinksRef.current.find((item) => normalizeLookup(item.targetTitle) === normalizeLookup(token.targetTitle)) || null
                    : null;
                  const noteId = sameNoteAnchor ? currentNoteIdRef.current || null : note?.id || link?.toNoteId || null;
                  if (noteId) {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenNoteRef.current?.(noteId, token.openOptions);
                    return true;
                  }
                  if (token.targetTitle && onCreateNoteRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    onCreateNoteRef.current(token.targetTitle, token.openOptions);
                    return true;
                  }
                }
              }
              const taskBox = target?.closest("[data-lr-task-checkbox]") as HTMLElement | null;
              if (taskBox) {
                const taskFrom = Number(taskBox.dataset.lrTaskFrom);
                const pos = Number.isFinite(taskFrom) ? taskFrom : editorView.posAtCoords({ x: event.clientX, y: event.clientY });
                if (typeof pos !== "number") return false;
                const toggled = toggleTaskCheckboxAt(editorView, pos);
                if (toggled) {
                  event.preventDefault();
                  event.stopPropagation();
                }
                return toggled;
              }
              return false;
            },
            dragover: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              if (!hasDraggedMaterialAsset(event.dataTransfer) && !event.dataTransfer?.files?.length) return false;
              if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
              event.preventDefault();
              return true;
            },
            drop: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editorView.state.selection.main.from;
              editorView.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
              const asset = getDraggedMaterialAsset(event.dataTransfer);
              if (asset && onInsertAssetReferenceRef.current) {
                event.preventDefault();
                event.stopPropagation();
                void onInsertAssetReferenceRef.current(asset, { start: pos, end: pos });
                return true;
              }
              const files = event.dataTransfer?.files;
              if (!files?.length) return false;
              event.preventDefault();
              event.stopPropagation();
              void onInsertFilesRef.current?.(files, { start: pos, end: pos });
              return true;
            },
            paste: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              const files = event.clipboardData?.files;
              const main = editorView.state.selection.main;
              const selection = { start: Math.min(main.from, main.to), end: Math.max(main.from, main.to) };
              if (files?.length) {
                event.preventDefault();
                event.stopPropagation();
                void onInsertFilesRef.current?.(files, selection);
                return true;
              }
              const imageSource = extractClipboardImageSource(event.clipboardData || null);
              if (!imageSource || !onInsertClipboardImageRef.current) return false;
              event.preventDefault();
              event.stopPropagation();
              void onInsertClipboardImageRef.current(imageSource, selection);
              return true;
            },
            contextmenu: (event, editorView) => {
              if (viewRef.current !== editorView) return true;
              if (isNoteMargin(event, editorView.contentDOM)) {
                displayRef.current.open(event);
                return true;
              }
              const token = tokenContextFromEventTarget(event.target);
              const table = tableContextFromEvent(event);
              const previousMain = editorView.state.selection.main;
              const previousSelection = {
                start: Math.min(previousMain.from, previousMain.to),
                end: Math.max(previousMain.from, previousMain.to),
              };
              let menuSelection = previousSelection;
              const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
              const clickInsideSelection = previousSelection.start !== previousSelection.end
                && typeof pos === "number"
                && pos >= previousSelection.start
                && pos <= previousSelection.end;
              if (token) {
                menuSelection = { start: token.from, end: token.to };
              } else if (!table && typeof pos === "number" && !clickInsideSelection) {
                editorView.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
                menuSelection = { start: pos, end: pos };
              }
              onContextMenuRef.current?.(event, menuSelection, token, table);
              return true;
            },
          }),
          editableCompartment.of(EditorView.editable.of(!props.disabled)),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          livePreviewCompartment.of(liveMarkdownPreview(liveOptions)),
          completionCompartment.of(completionExtension),
    ];
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({doc: props.value, selection: session?.state.selection, extensions}),
    });
    viewExtensions.current.set(view, extensions);
    scrollPositions.current.set(view,{top:session?.scrollTop||0,left:session?.scrollLeft||0});
    view.scrollDOM.addEventListener('scroll',()=>{if(view.scrollDOM.clientHeight>0&&view.scrollDOM.clientWidth>0)scrollPositions.current.set(view,captureNoteScroll(view.scrollDOM));});
    viewRef.current = view;
    retainedViews.current.keep(key, view);
    if (session) {
      const query=getSearchQuery(session.state);
      if(searchPanelOpen(session.state))openSearchPanel(view);
      view.dispatch({effects:setSearchQuery.of(query)});
      view.scrollDOM.scrollTop = session.scrollTop;
      view.scrollDOM.scrollLeft = session.scrollLeft;
      view.requestMeasure({ read: () => null, write: () => {
        view.scrollDOM.scrollTop = session.scrollTop;
        view.scrollDOM.scrollLeft = session.scrollLeft;
      } });
    }
    updateSelection(view);
    return () => {
      detach(view);
    };
  }, [props.currentNoteId]);

  useEffect(() => () => retainedViews.current.destroy(), []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (props.value !== current) {
      valueRef.current = props.value;
      view.dispatch({
        changes: documentSyncChange(current, props.value),
        annotations: [authoritativeSync.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [props.value, props.currentNoteId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (props.disabled) {
      view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(false)) });
      return;
    }
    view.dispatch({
      effects: [
        view.scrollSnapshot(),
        livePreviewCompartment.reconfigure(liveMarkdownPreview(liveOptions)),
        placeholderCompartment.reconfigure(placeholder(props.placeholderText || "")),
        editableCompartment.reconfigure(EditorView.editable.of(!props.disabled)),
        readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      ],
    });
  }, [editableCompartment, liveOptions, livePreviewCompartment, placeholderCompartment, props.disabled, props.placeholderText, readOnly, readOnlyCompartment]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: [view.scrollSnapshot(), displayCompartment.reconfigure(displayExtension())] });
  }, [props.currentNoteId, display.preferences, displayTitle, displayCompartment, naming, props.readOnly]);

  return <><div className="lr-live-markdown-editor" ref={hostRef} onContextMenuCapture={event => {
    const content = viewRef.current?.contentDOM;
    if (content && isNoteMargin(event, content)) display.open(event);
  }} />{display.menu}</>;
});
