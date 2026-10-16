import { WidgetType, type EditorView } from "@codemirror/view";
import { isMarkdownTableSeparatorLine, parseMarkdownTableAlignments, parseMarkdownTableCells } from "../../../core/services/noteRenderer";

function setWholeBlockSelection(view: EditorView, from: number, to: number) {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

function isEscapedPipe(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function escapeMarkdownTableCell(value: string) {
  const normalized = value.replace(/\r?\n/g, " ").replace(/\u00a0/g, " ").trim();
  let escaped = "";
  let codeFence = "";
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (char === "`") {
      let cursor = index;
      while (cursor < normalized.length && normalized[cursor] === "`") cursor += 1;
      const run = normalized.slice(index, cursor);
      codeFence = codeFence ? (run === codeFence ? "" : codeFence) : run;
      escaped += run;
      index = cursor - 1;
      continue;
    }

    if (!codeFence) {
      if (char === "[" && !isEscapedPipe(normalized, index)) bracketDepth += 1;
      else if (char === "]" && bracketDepth > 0 && !isEscapedPipe(normalized, index)) bracketDepth -= 1;
      else if (char === "(" && bracketDepth === 0 && !isEscapedPipe(normalized, index) && (parenDepth > 0 || normalized[index - 1] === "]")) parenDepth += 1;
      else if (char === ")" && parenDepth > 0 && !isEscapedPipe(normalized, index)) parenDepth -= 1;
    }

    if (char === "|" && !codeFence && bracketDepth === 0 && parenDepth === 0 && !isEscapedPipe(normalized, index)) {
      escaped += "\\|";
    } else {
      escaped += char;
    }
  }

  return escaped;
}

function splitTrailingBlockId(lineText: string) {
  const match = /\s+\^[A-Za-z0-9_-]+\s*$/.exec(lineText);
  if (!match) return { content: lineText, suffix: "" };
  return {
    content: lineText.slice(0, match.index),
    suffix: match[0].trimEnd(),
  };
}

function updateTableCellSource(view: EditorView, block: LiveTableBlock, lineOffset: number, columnIndex: number, value: string) {
  const startLine = view.state.doc.lineAt(block.from);
  const lineNumber = Math.max(1, Math.min(view.state.doc.lines, startLine.number + lineOffset));
  const line = view.state.doc.line(lineNumber);
  const { content, suffix } = splitTrailingBlockId(line.text);
  const cells = parseMarkdownTableCells(content);
  const columnCount = Math.max(block.headers.length, cells.length, columnIndex + 1);
  const nextCells = Array.from({ length: columnCount }, (_, index) => {
    const nextValue = index === columnIndex ? value : (cells[index] || "");
    return escapeMarkdownTableCell(nextValue);
  });
  const nextLine = `| ${nextCells.join(" | ")} |${suffix ? ` ${suffix}` : ""}`;
  if (nextLine === line.text) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: nextLine },
    scrollIntoView: true,
  });
}

function focusTableCell(view: EditorView, tableFrom: number, lineOffset: number, columnIndex: number, select = false) {
  window.setTimeout(() => {
    const root = view.dom.querySelector<HTMLElement>(`.lr-live-table-block[data-lr-table-from="${tableFrom}"]`);
    const cell = root?.querySelector<HTMLElement>(`[data-lr-table-line-offset="${lineOffset}"][data-lr-table-column="${columnIndex}"]`);
    const editor = cell?.querySelector<HTMLTextAreaElement>(".lr-live-table-cell-editor");
    if (!editor) return;
    editor.focus();
    if (select) {
      editor.select();
    } else {
      const cursor = editor.value.length;
      editor.setSelectionRange(cursor, cursor);
    }
  }, 0);
}

async function writeTableClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }
}

function tableCellWidthCh(value: string) {
  const visualWidth = Array.from(value || "").reduce((total, char) => total + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 2 : 1), 0);
  return Math.max(4, Math.min(160, visualWidth + 1));
}

function resizeTableCellEditor(editor: HTMLTextAreaElement) {
  editor.style.width = `${tableCellWidthCh(editor.value)}ch`;
  editor.style.minWidth = "4ch";
  editor.style.height = "auto";
  editor.style.height = `${Math.max(20, editor.scrollHeight)}px`;
}

type TableSelectionRange =
  | { mode: "row"; start: number; end: number }
  | { mode: "column"; start: number; end: number }
  | { mode: "cell"; startRow: number; endRow: number; startColumn: number; endColumn: number }
  | { mode: "table" };

type TableDragSelection =
  | { mode: "row"; start: number }
  | { mode: "column"; start: number }
  | { mode: "cell"; startRow: number; startColumn: number };

const CELL_DRAG_THRESHOLD_PX = 5;
const LIVE_TABLE_SELECT_WHOLE_EVENT = "lr-live-table-select-whole";

type EditableTableFromView = {
  from: number;
  to: number;
  headers: string[];
  alignments: LiveTableAlignment[];
  rows: string[][];
  suffix: string;
  columnCount: number;
};

function tableRow(cells: string[], suffix = "") {
  return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |${suffix ? ` ${suffix}` : ""}`;
}

function tableSeparator(alignments: LiveTableAlignment[], columnCount: number) {
  return `| ${Array.from({ length: columnCount }, (_, index) => {
    const alignment = alignments[index];
    if (alignment === "center") return ":---:";
    if (alignment === "right") return "---:";
    if (alignment === "left") return ":---";
    return "---";
  }).join(" | ")} |`;
}

function serializeTableSource(table: EditableTableFromView) {
  const rows = table.rows.length ? table.rows : [Array.from({ length: table.columnCount }, () => "")];
  return [
    tableRow(table.headers),
    tableSeparator(table.alignments, table.columnCount),
    ...rows.map((row, index) => tableRow(row, index === rows.length - 1 ? table.suffix : "")),
  ].join("\n");
}

function currentTableFromView(view: EditorView, block: LiveTableBlock): EditableTableFromView | null {
  const headerLine = view.state.doc.lineAt(block.from);
  if (headerLine.number >= view.state.doc.lines) return null;
  const separatorLine = view.state.doc.line(headerLine.number + 1);
  if (!headerLine.text.includes("|") || !isMarkdownTableSeparatorLine(separatorLine.text)) return null;

  const rows: string[][] = [];
  let endLine = separatorLine;
  let lineNumber = headerLine.number + 2;
  while (lineNumber <= view.state.doc.lines) {
    const rowLine = view.state.doc.line(lineNumber);
    const trimmed = rowLine.text.trim();
    if (!trimmed || !trimmed.includes("|") || /^(```|~~~)/.test(trimmed)) break;
    const { content } = splitTrailingBlockId(rowLine.text);
    rows.push(parseMarkdownTableCells(content));
    endLine = rowLine;
    lineNumber += 1;
  }

  const { content: lastContent, suffix } = splitTrailingBlockId(endLine.text);
  const headers = parseMarkdownTableCells(headerLine.text);
  const alignments = parseMarkdownTableAlignments(separatorLine.text) as LiveTableAlignment[];
  if (endLine.number > separatorLine.number && rows.length) rows[rows.length - 1] = parseMarkdownTableCells(lastContent);
  const columnCount = Math.max(1, headers.length, alignments.length, ...rows.map((row) => row.length));
  return {
    from: headerLine.from,
    to: endLine.to,
    headers: Array.from({ length: columnCount }, (_, index) => headers[index] || ""),
    alignments: Array.from({ length: columnCount }, (_, index) => alignments[index] || null),
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || "")),
    suffix,
    columnCount,
  };
}

function parseTsvClipboard(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  const rows = normalized.split("\n").map((row) => row.split("\t"));
  if (rows.length === 1 && rows[0].length === 1) return null;
  return rows;
}

function firstClipboardTableCell(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[0]?.split("\t")[0] || "";
}

function expandCells<T>(cells: T[], length: number, fallback: T) {
  return Array.from({ length }, (_, index) => cells[index] ?? fallback);
}

function pasteTsvIntoTable(view: EditorView, block: LiveTableBlock, lineOffset: number, columnIndex: number, text: string) {
  const matrix = parseTsvClipboard(text);
  if (!matrix?.length) return false;
  const table = currentTableFromView(view, block);
  if (!table) return false;

  const width = Math.max(1, ...matrix.map((row) => row.length));
  const pasteColumnIndex = width > 1 && width <= table.columnCount
    ? Math.min(columnIndex, Math.max(0, table.columnCount - width))
    : columnIndex;
  const columnCount = Math.max(table.columnCount, pasteColumnIndex + width);
  const headers = expandCells(table.headers, columnCount, "");
  const alignments = expandCells<LiveTableAlignment>(table.alignments, columnCount, null);
  const rows = table.rows.map((row) => expandCells(row, columnCount, ""));
  const ensureRow = (rowIndex: number) => {
    while (rows.length <= rowIndex) rows.push(Array.from({ length: columnCount }, () => ""));
    rows[rowIndex] = expandCells(rows[rowIndex], columnCount, "");
    return rows[rowIndex];
  };
  const writeCells = (cells: string[], values: string[]) => {
    values.forEach((value, index) => {
      cells[pasteColumnIndex + index] = value.replace(/\r?\n/g, " ");
    });
  };

  if (lineOffset === 0) {
    writeCells(headers, matrix[0]);
    matrix.slice(1).forEach((values, index) => writeCells(ensureRow(index), values));
  } else {
    const startRowIndex = Math.max(0, lineOffset - 2);
    matrix.forEach((values, index) => writeCells(ensureRow(startRowIndex + index), values));
  }

  replaceCurrentTableSource(view, { ...table, columnCount, headers, alignments, rows });
  const lastValues = matrix[matrix.length - 1] || [""];
  const nextLineOffset = lineOffset === 0
    ? (matrix.length === 1 ? 0 : matrix.length)
    : lineOffset + matrix.length - 1;
  const nextColumnIndex = Math.min(columnCount - 1, pasteColumnIndex + Math.max(0, lastValues.length - 1));
  focusTableCell(view, table.from, nextLineOffset, nextColumnIndex, true);
  return true;
}

function replaceCurrentTableSource(view: EditorView, table: EditableTableFromView) {
  const source = serializeTableSource(table);
  view.dispatch({
    changes: { from: table.from, to: table.to, insert: source },
    selection: { anchor: table.from + source.length },
    scrollIntoView: true,
  });
}

function deleteCurrentTableSource(view: EditorView, block: LiveTableBlock) {
  const table = currentTableFromView(view, block);
  const from = table?.from ?? block.from;
  let to = table?.to ?? block.to;
  if (to < view.state.doc.length && view.state.doc.sliceString(to, to + 1) === "\n") to += 1;
  view.dispatch({
    changes: { from, to, insert: "" },
    selection: { anchor: from },
    scrollIntoView: true,
  });
  view.focus();
}
function addTableRowAtEnd(view: EditorView, block: LiveTableBlock) {
  const table = currentTableFromView(view, block);
  if (!table) return;
  replaceCurrentTableSource(view, {
    ...table,
    rows: [...table.rows, Array.from({ length: table.columnCount }, () => "")],
  });
}

function addTableColumnAtEnd(view: EditorView, block: LiveTableBlock) {
  const table = currentTableFromView(view, block);
  if (!table) return;
  replaceCurrentTableSource(view, {
    ...table,
    columnCount: table.columnCount + 1,
    headers: [...table.headers, ""],
    alignments: [...table.alignments, null],
    rows: table.rows.map((row) => [...row, ""]),
  });
}

export type LiveCodeBlock = {
  language: string;
  content: string;
  from: number;
  to: number;
};

export class CodeBlockWidget extends WidgetType {
  constructor(private readonly block: LiveCodeBlock) {
    super();
  }

  eq(other: CodeBlockWidget) {
    return (
      other.block.language === this.block.language
      && other.block.content === this.block.content
      && other.block.from === this.block.from
      && other.block.to === this.block.to
    );
  }

  toDOM(view: EditorView) {
    const root = document.createElement("section");
    root.className = "lr-live-code-block";
    root.contentEditable = "false";
    root.title = "点击编辑代码块源码";

    const header = document.createElement("div");
    header.className = "lr-live-code-header";
    const label = document.createElement("span");
    label.textContent = this.block.language || "code";
    const lineCount = document.createElement("small");
    lineCount.textContent = `${this.block.content ? this.block.content.split(/\r?\n/).length : 0} 行`;
    const meta = document.createElement("span");
    meta.className = "lr-live-code-meta";
    meta.append(label, lineCount);
    const copy = document.createElement("button");
    copy.className = "lr-live-code-copy";
    copy.type = "button";
    copy.textContent = "复制";
    copy.title = "复制代码";
    copy.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    copy.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.block.content || "");
        copy.textContent = "已复制";
        window.setTimeout(() => { copy.textContent = "复制"; }, 1100);
      } catch {
        copy.textContent = "失败";
        window.setTimeout(() => { copy.textContent = "复制"; }, 1400);
      }
    };
    header.append(meta, copy);

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = this.block.content || "";
    pre.appendChild(code);
    root.append(header, pre);

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setWholeBlockSelection(view, this.block.from, this.block.to);
    };

    return root;
  }

  ignoreEvent() {
    return false;
  }
}

export type LiveCalloutBlock = {
  kind: string;
  title: string;
  body: string[];
  folded: boolean;
  from: number;
  to: number;
};

export type LiveTableAlignment = "left" | "center" | "right" | null;

export type LiveTableBlock = {
  headers: string[];
  rows: string[][];
  alignments: LiveTableAlignment[];
  from: number;
  to: number;
};

export class CalloutBlockWidget extends WidgetType {
  constructor(private readonly block: LiveCalloutBlock) {
    super();
  }

  eq(other: CalloutBlockWidget) {
    return (
      other.block.kind === this.block.kind
      && other.block.title === this.block.title
      && other.block.body.join("\n") === this.block.body.join("\n")
      && other.block.folded === this.block.folded
      && other.block.from === this.block.from
      && other.block.to === this.block.to
    );
  }

  toDOM(view: EditorView) {
    const root = document.createElement("section");
    root.className = `lr-live-callout kind-${this.block.kind}${this.block.folded ? " folded" : ""}`;
    root.contentEditable = "false";
    root.title = "点击编辑 callout 源码";

    const header = document.createElement("div");
    header.className = "lr-live-callout-header";
    const marker = document.createElement("span");
    marker.className = "lr-live-callout-marker";
    marker.textContent = calloutMarker(this.block.kind);
    const fold = document.createElement("span");
    fold.className = "lr-live-callout-fold";
    fold.textContent = this.block.folded ? ">" : "v";
    const title = document.createElement("span");
    title.className = "lr-live-callout-title-text";
    title.textContent = this.block.title || this.block.kind;
    header.append(marker, fold, title);
    root.appendChild(header);

    if (this.block.body.length && !this.block.folded) {
      const body = document.createElement("div");
      body.className = "lr-live-callout-body";
      this.block.body.forEach((line) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = line || "\u00a0";
        body.appendChild(paragraph);
      });
      root.appendChild(body);
    }

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setWholeBlockSelection(view, this.block.from, this.block.to);
    };

    return root;
  }

  ignoreEvent() {
    return false;
  }
}

function calloutMarker(kind: string) {
  const normalized = kind.toLocaleLowerCase();
  if (normalized === "warning" || normalized === "attention" || normalized === "caution") return "!";
  if (normalized === "danger" || normalized === "error" || normalized === "failure") return "x";
  if (normalized === "tip" || normalized === "hint" || normalized === "important") return "*";
  if (normalized === "question" || normalized === "help" || normalized === "faq") return "?";
  if (normalized === "success" || normalized === "check" || normalized === "done") return "✓";
  return "i";
}

function tableCellEditor(view: EditorView, block: LiveTableBlock, value: string, lineOffset: number, columnIndex: number, cellIndex: number, onFocus?: () => void, onPointerDown?: (event: MouseEvent, editor: HTMLTextAreaElement) => void) {
  const editor = document.createElement("textarea");
  editor.className = "lr-live-table-cell-editor";
  editor.spellcheck = true;
  editor.rows = 1;
  editor.wrap = "off";
  editor.value = value;
  editor.dataset.lrCellIndex = String(cellIndex);
  editor.setAttribute("aria-label", "表格单元格");
  editor.onmousedown = (event) => {
    if (event.button === 0) onPointerDown?.(event, editor);
    event.stopPropagation();
  };
  editor.onmouseup = (event) => {
    event.stopPropagation();
  };
  editor.onclick = (event) => {
    event.stopPropagation();
  };
  editor.ondblclick = (event) => {
    event.stopPropagation();
  };
  editor.oncontextmenu = () => {
    updateTableCellSource(view, block, lineOffset, columnIndex, editor.value);
  };
  editor.onfocus = () => {
    onFocus?.();
    resizeTableCellEditor(editor);
  };
  editor.oninput = () => {
    resizeTableCellEditor(editor);
  };
  editor.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      updateTableCellSource(view, block, lineOffset, columnIndex, editor.value);
      editor.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      editor.value = value;
      resizeTableCellEditor(editor);
      editor.blur();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const cells = Array.from((editor.closest("table") || document).querySelectorAll<HTMLTextAreaElement>(".lr-live-table-cell-editor"));
      const currentIndex = cells.indexOf(editor);
      const nextIndex = event.shiftKey ? currentIndex - 1 : currentIndex + 1;
      updateTableCellSource(view, block, lineOffset, columnIndex, editor.value);
      if (!event.shiftKey && currentIndex === cells.length - 1) {
        window.setTimeout(() => {
          addTableRowAtEnd(view, block);
          focusTableCell(view, block.from, block.rows.length + 2, 0, true);
        }, 0);
        return;
      }
      if (nextIndex < 0) {
        focusTableCell(view, block.from, lineOffset, columnIndex);
        return;
      }
      window.setTimeout(() => {
        const root = view.dom.querySelector<HTMLElement>(`.lr-live-table-block[data-lr-table-from="${block.from}"]`);
        const nextCells = Array.from((root || view.dom).querySelectorAll<HTMLTextAreaElement>(".lr-live-table-cell-editor"));
        const nextCell = nextCells[nextIndex];
        if (!nextCell) {
          focusTableCell(view, block.from, lineOffset, columnIndex);
          return;
        }
        nextCell.focus();
        nextCell.select();
      }, 0);
    }
  };
  editor.onpaste = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (pasteTsvIntoTable(view, block, lineOffset, columnIndex, text)) {
      editor.value = firstClipboardTableCell(text);
      resizeTableCellEditor(editor);
      return;
    }
    const insert = text.replace(/\r?\n/g, " ");
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    editor.value = `${editor.value.slice(0, start)}${insert}${editor.value.slice(end)}`;
    const cursor = start + insert.length;
    editor.setSelectionRange(cursor, cursor);
    resizeTableCellEditor(editor);
  };
  editor.onblur = () => {
    updateTableCellSource(view, block, lineOffset, columnIndex, editor.value);
  };
  resizeTableCellEditor(editor);
  window.setTimeout(() => resizeTableCellEditor(editor), 0);
  return editor;
}

export class TableBlockWidget extends WidgetType {
  constructor(private readonly block: LiveTableBlock) {
    super();
  }

  eq(other: TableBlockWidget) {
    return (
      other.block.headers.join("\n") === this.block.headers.join("\n")
      && other.block.rows.map((row) => row.join("\u0000")).join("\n") === this.block.rows.map((row) => row.join("\u0000")).join("\n")
      && other.block.alignments.join(",") === this.block.alignments.join(",")
      && other.block.from === this.block.from
      && other.block.to === this.block.to
    );
  }

  toDOM(view: EditorView) {
    const root = document.createElement("section");
    root.className = "lr-live-table-block";
    root.contentEditable = "false";
    root.tabIndex = -1;
    root.title = "点击单元格编辑";
    root.dataset.lrTableFrom = String(this.block.from);
    root.dataset.lrTableTo = String(this.block.to);
    root.dataset.lrTableRows = String(this.block.rows.length);
    root.dataset.lrTableColumns = String(this.block.headers.length);
    const columnCount = this.block.headers.length;
    const rowLineOffsets = [0, ...this.block.rows.map((_, index) => index + 2)];
    const lastLineOffset = rowLineOffsets[rowLineOffsets.length - 1] ?? 0;
    let selectedRange: TableSelectionRange | null = null;
    let dragSelection: TableDragSelection | null = null;

    const tableCellText = (cell: Element) => cell.querySelector<HTMLTextAreaElement>(".lr-live-table-cell-editor")?.value || "";
    const rowOffsetsInRange = (start: number, end: number) => {
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      return rowLineOffsets.filter((lineOffset) => lineOffset >= from && lineOffset <= to);
    };
    const columnsInRange = (start: number, end: number) => {
      const from = Math.max(0, Math.min(start, end));
      const to = Math.min(columnCount - 1, Math.max(start, end));
      return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
    };
    const markCells = (rows: number[], columns: number[]) => {
      const rowSet = new Set(rows);
      const columnSet = new Set(columns);
      root.querySelectorAll<HTMLElement>("[data-lr-table-line-offset][data-lr-table-column]").forEach((cell) => {
        const lineOffset = Number(cell.dataset.lrTableLineOffset);
        const column = Number(cell.dataset.lrTableColumn);
        if (rowSet.has(lineOffset) && columnSet.has(column)) cell.classList.add("lr-live-table-selected");
      });
    };
    const clearSelection = () => {
      root.classList.remove("lr-live-table-whole-selected");
      root.querySelectorAll(".lr-live-table-selected").forEach((element) => element.classList.remove("lr-live-table-selected"));
      root.querySelectorAll(".lr-live-table-handle-selected").forEach((element) => element.classList.remove("lr-live-table-handle-selected"));
      selectedRange = null;
    };
    const selectRows = (start: number, end: number) => {
      clearSelection();
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      selectedRange = { mode: "row", start: from, end: to };
      markCells(rowOffsetsInRange(from, to), columnsInRange(0, columnCount - 1));
      root.querySelectorAll<HTMLElement>("[data-lr-table-row-handle]").forEach((handle) => {
        const lineOffset = Number(handle.dataset.lrTableRowHandle);
        if (lineOffset >= from && lineOffset <= to) handle.classList.add("lr-live-table-handle-selected");
      });
    };
    const selectColumns = (start: number, end: number) => {
      clearSelection();
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      selectedRange = { mode: "column", start: from, end: to };
      markCells(rowLineOffsets, columnsInRange(from, to));
      root.querySelectorAll<HTMLElement>("[data-lr-table-column-handle]").forEach((handle) => {
        const column = Number(handle.dataset.lrTableColumnHandle);
        if (column >= from && column <= to) handle.classList.add("lr-live-table-handle-selected");
      });
    };
    const selectCellRange = (startRow: number, startColumn: number, endRow: number, endColumn: number) => {
      clearSelection();
      selectedRange = { mode: "cell", startRow, endRow, startColumn, endColumn };
      markCells(rowOffsetsInRange(startRow, endRow), columnsInRange(startColumn, endColumn));
    };
    const selectWholeTable = (event?: MouseEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      root.focus();
      clearSelection();
      selectedRange = { mode: "table" };
      root.classList.add("lr-live-table-whole-selected");
      markCells(rowLineOffsets, columnsInRange(0, columnCount - 1));
      root.querySelectorAll(".lr-live-table-select-handle").forEach((handle) => handle.classList.add("lr-live-table-handle-selected"));
    };
    root.addEventListener(LIVE_TABLE_SELECT_WHOLE_EVENT, (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectWholeTable();
    });

    const rowsForSelection = (range: TableSelectionRange) => {
      if (range.mode === "table" || range.mode === "column") return rowLineOffsets;
      if (range.mode === "row") return rowOffsetsInRange(range.start, range.end);
      return rowOffsetsInRange(range.startRow, range.endRow);
    };
    const columnsForSelection = (range: TableSelectionRange) => {
      if (range.mode === "table" || range.mode === "row") return columnsInRange(0, columnCount - 1);
      if (range.mode === "column") return columnsInRange(range.start, range.end);
      return columnsInRange(range.startColumn, range.endColumn);
    };
    const selectedText = () => {
      const range = selectedRange;
      if (!range) return "";
      const columns = columnsForSelection(range);
      return rowsForSelection(range).map((lineOffset) => columns.map((column) => {
        const cell = root.querySelector<HTMLElement>(`[data-lr-table-line-offset="${lineOffset}"][data-lr-table-column="${column}"]`);
        return cell ? tableCellText(cell) : "";
      }).join("\t")).join("\n");
    };
    const isWholeTableSelection = (range: TableSelectionRange) => {
      if (range.mode === "table") return true;
      const rows = rowsForSelection(range);
      const columns = columnsForSelection(range);
      return rows.length === rowLineOffsets.length
        && columns.length === columnCount
        && rows[0] === 0
        && rows[rows.length - 1] === lastLineOffset
        && columns[0] === 0
        && columns[columns.length - 1] === columnCount - 1;
    };
    const clearSelectedCells = () => {
      const range = selectedRange;
      if (!range) return false;
      if (isWholeTableSelection(range)) {
        deleteCurrentTableSource(view, this.block);
        return true;
      }
      const tableFromView = currentTableFromView(view, this.block);
      if (!tableFromView) return false;
      const headers = [...tableFromView.headers];
      const rows = tableFromView.rows.map((row) => [...row]);
      const columns = columnsForSelection(range);
      rowsForSelection(range).forEach((lineOffset) => {
        columns.forEach((column) => {
          if (lineOffset === 0) headers[column] = "";
          else if (rows[lineOffset - 2]) rows[lineOffset - 2][column] = "";
        });
      });
      replaceCurrentTableSource(view, { ...tableFromView, headers, rows });
      return true;
    };
    const copySelected = async () => {
      const text = selectedText();
      if (!text) return false;
      return writeTableClipboardText(text);
    };
    const finishDragSelection = () => {
      dragSelection = null;
      window.removeEventListener("mouseup", finishDragSelection, true);
    };
    const startDragSelection = (event: MouseEvent, mode: "row" | "column", index: number) => {
      event.preventDefault();
      event.stopPropagation();
      root.focus();
      dragSelection = { mode, start: index };
      if (mode === "row") selectRows(index, index);
      else selectColumns(index, index);
      window.addEventListener("mouseup", finishDragSelection, true);
    };
    const cellAtPoint = (x: number, y: number) => {
      const element = root.ownerDocument.elementFromPoint(x, y);
      const cell = element instanceof HTMLElement ? element.closest<HTMLTableCellElement>("th,td") : null;
      return cell && root.contains(cell) ? cell : null;
    };
    const focusCellEditor = (cell: HTMLTableCellElement) => {
      const editor = cell.querySelector<HTMLTextAreaElement>(".lr-live-table-cell-editor");
      if (!editor) return false;
      clearSelection();
      editor.focus();
      const cursor = editor.value.length;
      editor.setSelectionRange(cursor, cursor);
      return true;
    };
    const beginPotentialCellSelection = (event: MouseEvent, cell: HTMLTableCellElement, lineOffset: number, column: number) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      let didStartSelection = false;
      const updateSelectionAt = (clientX: number, clientY: number) => {
        const targetCell = cellAtPoint(clientX, clientY) || cell;
        const targetRow = Number(targetCell.dataset.lrTableLineOffset);
        const targetColumn = Number(targetCell.dataset.lrTableColumn);
        selectCellRange(lineOffset, column, Number.isFinite(targetRow) ? targetRow : lineOffset, Number.isFinite(targetColumn) ? targetColumn : column);
      };
      const stopTracking = () => {
        window.removeEventListener("mousemove", handleMove, true);
        window.removeEventListener("mouseup", handleUp, true);
      };
      const handleMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!didStartSelection && Math.hypot(dx, dy) < CELL_DRAG_THRESHOLD_PX) return;
        moveEvent.preventDefault();
        moveEvent.stopPropagation();
        if (!didStartSelection) {
          root.focus();
          dragSelection = { mode: "cell", startRow: lineOffset, startColumn: column };
          didStartSelection = true;
        }
        updateSelectionAt(moveEvent.clientX, moveEvent.clientY);
      };
      const handleUp = (upEvent: MouseEvent) => {
        upEvent.preventDefault();
        upEvent.stopPropagation();
        stopTracking();
        if (!didStartSelection) {
          dragSelection = null;
          focusCellEditor(cell);
          return;
        }
        updateSelectionAt(upEvent.clientX, upEvent.clientY);
        finishDragSelection();
      };
      window.addEventListener("mousemove", handleMove, true);
      window.addEventListener("mouseup", handleUp, true);
    };
    const beginPotentialTextCellSelection = (event: MouseEvent, editor: HTMLTextAreaElement, cell: HTMLTableCellElement, lineOffset: number, column: number) => {
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      let didStartSelection = false;
      const updateSelectionAt = (clientX: number, clientY: number) => {
        const targetCell = cellAtPoint(clientX, clientY) || cell;
        const targetRow = Number(targetCell.dataset.lrTableLineOffset);
        const targetColumn = Number(targetCell.dataset.lrTableColumn);
        selectCellRange(lineOffset, column, Number.isFinite(targetRow) ? targetRow : lineOffset, Number.isFinite(targetColumn) ? targetColumn : column);
      };
      const stopTracking = () => {
        window.removeEventListener("mousemove", handleMove, true);
        window.removeEventListener("mouseup", handleUp, true);
      };
      const handleMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!didStartSelection && Math.hypot(dx, dy) < CELL_DRAG_THRESHOLD_PX) return;
        moveEvent.preventDefault();
        moveEvent.stopPropagation();
        if (!didStartSelection) {
          editor.setSelectionRange(editor.value.length, editor.value.length);
          editor.blur();
          root.focus();
          dragSelection = { mode: "cell", startRow: lineOffset, startColumn: column };
          didStartSelection = true;
        }
        root.ownerDocument.getSelection()?.removeAllRanges();
        updateSelectionAt(moveEvent.clientX, moveEvent.clientY);
      };
      const handleUp = (upEvent: MouseEvent) => {
        stopTracking();
        if (!didStartSelection) return;
        upEvent.preventDefault();
        upEvent.stopPropagation();
        updateSelectionAt(upEvent.clientX, upEvent.clientY);
        finishDragSelection();
      };
      window.addEventListener("mousemove", handleMove, true);
      window.addEventListener("mouseup", handleUp, true);
    };
    const activateCell = (cell: HTMLTableCellElement) => {
      const lineOffset = Number(cell.dataset.lrTableLineOffset);
      const column = Number(cell.dataset.lrTableColumn);
      cell.onmouseenter = () => {
        if (dragSelection?.mode === "row") selectRows(dragSelection.start, lineOffset);
        if (dragSelection?.mode === "column") selectColumns(dragSelection.start, column);
        if (dragSelection?.mode === "cell") selectCellRange(dragSelection.startRow, dragSelection.startColumn, lineOffset, column);
      };
      cell.onmousedown = (event) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest(".lr-live-table-cell-editor,.lr-live-table-select-handle,.lr-live-table-edge-add")) return;
        beginPotentialCellSelection(event, cell, lineOffset, column);
      };
    };
    root.addEventListener("copy", (event) => {
      const text = selectedText();
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
    });
    root.onkeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "c") {
        event.preventDefault();
        void copySelected();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedRange) {
        event.preventDefault();
        event.stopPropagation();
        clearSelectedCells();
        return;
      }
      if (event.key === "Escape") clearSelection();
    };

    const cornerHandle = document.createElement("button");
    cornerHandle.type = "button";
    cornerHandle.className = "lr-live-table-select-handle lr-live-table-corner-handle";
    cornerHandle.title = "选择整张表";
    cornerHandle.setAttribute("aria-label", "选择整张表");
    cornerHandle.onmousedown = selectWholeTable;
    cornerHandle.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const tableScroll = document.createElement("div");
    tableScroll.className = "lr-live-table-scroll";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    this.block.headers.forEach((cell, index) => {
      const th = document.createElement("th");
      th.dataset.lrTableLineOffset = "0";
      th.dataset.lrTableColumn = String(index);
      const columnHandle = document.createElement("button");
      columnHandle.type = "button";
      columnHandle.className = "lr-live-table-select-handle lr-live-table-column-handle";
      columnHandle.title = "选择列";
      columnHandle.dataset.lrTableColumnHandle = String(index);
      columnHandle.setAttribute("aria-label", "选择列");
      columnHandle.onmousedown = (event) => startDragSelection(event, "column", index);
      columnHandle.onmouseenter = () => {
        if (dragSelection?.mode === "column") selectColumns(dragSelection.start, index);
      };
      const editor = tableCellEditor(view, this.block, cell, 0, index, index, clearSelection, (event, editorElement) => beginPotentialTextCellSelection(event, editorElement, th, 0, index));
      th.append(columnHandle, editor);
      activateCell(th);
      applyAlignment(th, this.block.alignments[index]);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    this.block.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      for (let index = 0; index < columnCount; index += 1) {
        const td = document.createElement("td");
        td.dataset.lrTableLineOffset = String(rowIndex + 2);
        td.dataset.lrTableColumn = String(index);
        if (index === 0) {
          const rowHandle = document.createElement("button");
          rowHandle.type = "button";
          rowHandle.className = "lr-live-table-select-handle lr-live-table-row-handle";
          rowHandle.title = "选择行";
          rowHandle.dataset.lrTableRowHandle = String(rowIndex + 2);
          rowHandle.setAttribute("aria-label", "选择行");
          rowHandle.onmousedown = (event) => startDragSelection(event, "row", rowIndex + 2);
          rowHandle.onmouseenter = () => {
            if (dragSelection?.mode === "row") selectRows(dragSelection.start, rowIndex + 2);
          };
          td.appendChild(rowHandle);
        }
        const editor = tableCellEditor(view, this.block, row[index] || "", rowIndex + 2, index, this.block.headers.length + rowIndex * columnCount + index, clearSelection, (event, editorElement) => beginPotentialTextCellSelection(event, editorElement, td, rowIndex + 2, index));
        td.appendChild(editor);
        activateCell(td);
        applyAlignment(td, this.block.alignments[index]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableScroll.appendChild(table);

    const addColumnButton = document.createElement("button");
    addColumnButton.type = "button";
    addColumnButton.className = "lr-live-table-edge-add lr-live-table-add-column";
    addColumnButton.textContent = "+";
    addColumnButton.title = "在右侧新增列";
    addColumnButton.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.querySelector<HTMLTextAreaElement>(".lr-live-table-cell-editor:focus")?.blur();
      window.setTimeout(() => addTableColumnAtEnd(view, this.block), 0);
    };
    addColumnButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const addRowButton = document.createElement("button");
    addRowButton.type = "button";
    addRowButton.className = "lr-live-table-edge-add lr-live-table-add-row";
    addRowButton.textContent = "+";
    addRowButton.title = "在下方新增行";
    addRowButton.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.querySelector<HTMLTextAreaElement>(".lr-live-table-cell-editor:focus")?.blur();
      window.setTimeout(() => addTableRowAtEnd(view, this.block), 0);
    };
    addRowButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    root.append(cornerHandle, tableScroll, addColumnButton, addRowButton);
    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".lr-live-table-cell-editor")) return;
      if (target?.closest(".lr-live-table-select-handle,.lr-live-table-edge-add")) return;
      selectWholeTable(event);
    };
    root.onmouseup = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    root.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    root.ondblclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    return root;
  }

  ignoreEvent(event: Event) {
    return event.type !== "contextmenu";
  }
}

function applyAlignment(cell: HTMLTableCellElement, alignment: LiveTableAlignment) {
  if (alignment) cell.style.textAlign = alignment;
}
