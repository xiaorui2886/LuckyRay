import {isMarkdownTableSeparatorLine,parseMarkdownTableAlignments,parseMarkdownTableCells,type TableAlignment} from '../../../core/services/noteRenderer';
import type {LiveEditorTableContext} from './LiveMarkdownEditor';
import type {TableEditorCommand} from './EditorContextMenu';

type EditableTableShape = {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  suffix: string;
  columnCount: number;
};

function isEscapedMarkdownPipe(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function escapeEditorTableCell(value: string) {
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
      if (char === "[" && !isEscapedMarkdownPipe(normalized, index)) bracketDepth += 1;
      else if (char === "]" && bracketDepth > 0 && !isEscapedMarkdownPipe(normalized, index)) bracketDepth -= 1;
      else if (char === "(" && bracketDepth === 0 && !isEscapedMarkdownPipe(normalized, index) && (parenDepth > 0 || normalized[index - 1] === "]")) parenDepth += 1;
      else if (char === ")" && parenDepth > 0 && !isEscapedMarkdownPipe(normalized, index)) parenDepth -= 1;
    }

    if (char === "|" && !codeFence && bracketDepth === 0 && parenDepth === 0 && !isEscapedMarkdownPipe(normalized, index)) {
      escaped += "\\|";
    } else {
      escaped += char;
    }
  }

  return escaped;
}

function splitEditorTableBlockId(lineText: string) {
  const match = /\s+\^[A-Za-z0-9_-]+\s*$/.exec(lineText);
  if (!match) return { content: lineText, suffix: "" };
  return {
    content: lineText.slice(0, match.index),
    suffix: match[0].trimEnd(),
  };
}

function textLineAt(content: string, position: number) {
  const safePosition = Math.max(0, Math.min(position, content.length));
  const from = content.lastIndexOf("\n", Math.max(0, safePosition - 1)) + 1;
  const breakIndex = content.indexOf("\n", safePosition);
  const lineBreak = breakIndex < 0 ? content.length : breakIndex;
  const to = lineBreak > from && content[lineBreak - 1] === "\r" ? lineBreak - 1 : lineBreak;
  return { from, to, text: content.slice(from, to), next: breakIndex < 0 ? content.length : breakIndex + 1 };
}

export function resolveEditableTableRange(content: string, context: LiveEditorTableContext) {
  const header = textLineAt(content, context.from);
  const separator = textLineAt(content, header.next);
  if (!header.text.includes("|") || !isMarkdownTableSeparatorLine(separator.text)) return null;
  let end = separator.to;
  let cursor = separator.next;

  while (cursor < content.length) {
    const row = textLineAt(content, cursor);
    const trimmed = row.text.trim();
    if (!trimmed || !trimmed.includes("|") || /^(```|~~~)/.test(trimmed)) break;
    end = row.to;
    if (row.next <= cursor) break;
    cursor = row.next;
  }

  return { from: header.from, to: end };
}

export function parseEditableTableSource(source: string): EditableTableShape | null {
  const lines = source.split(/\r?\n/);
  if (lines.length < 2 || !isMarkdownTableSeparatorLine(lines[1])) return null;
  const lastLineIndex = lines.length - 1;
  const lastLine = splitEditorTableBlockId(lines[lastLineIndex] || "");
  const sourceLines = lines.map((line, index) => (index === lastLineIndex ? lastLine.content : line));
  const headers = parseMarkdownTableCells(sourceLines[0] || "");
  const alignments = parseMarkdownTableAlignments(sourceLines[1] || "");
  const rows = sourceLines.slice(2).map(parseMarkdownTableCells);
  const columnCount = Math.max(1, headers.length, alignments.length, ...rows.map((row) => row.length));
  return {
    headers: Array.from({ length: columnCount }, (_, index) => headers[index] || ""),
    alignments: Array.from({ length: columnCount }, (_, index) => alignments[index] || null),
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || "")),
    suffix: lastLine.suffix,
    columnCount,
  };
}

function serializeEditorTableRow(cells: string[], suffix = "") {
  return `| ${cells.map(escapeEditorTableCell).join(" | ")} |${suffix ? ` ${suffix}` : ""}`;
}

function serializeEditorTableSeparator(alignments: TableAlignment[], columnCount: number) {
  return `| ${Array.from({ length: columnCount }, (_, index) => {
    const alignment = alignments[index];
    if (alignment === "center") return ":---:";
    if (alignment === "right") return "---:";
    if (alignment === "left") return ":---";
    return "---";
  }).join(" | ")} |`;
}

export function serializeEditableTableSource(table: EditableTableShape) {
  const rows = table.rows.length ? table.rows : [Array.from({ length: table.columnCount }, () => "")];
  return [
    serializeEditorTableRow(table.headers),
    serializeEditorTableSeparator(table.alignments, table.columnCount),
    ...rows.map((row, index) => serializeEditorTableRow(row, index === rows.length - 1 ? table.suffix : "")),
  ].join("\n");
}

export function copyEditorTableRowText(table: EditableTableShape, context: LiveEditorTableContext) {
  const rowIndex = context.lineOffset - 2;
  const row = rowIndex >= 0 && rowIndex < table.rows.length ? table.rows[rowIndex] : table.headers;
  return row.join("\t");
}

export function copyEditorTableColumnText(table: EditableTableShape, context: LiveEditorTableContext) {
  const columnIndex = Math.max(0, Math.min(context.columnIndex, table.columnCount - 1));
  return [table.headers[columnIndex] || "", ...table.rows.map((row) => row[columnIndex] || "")].join("\n");
}

export function applyEditableTableCommand(table: EditableTableShape, context: LiveEditorTableContext, command: TableEditorCommand): EditableTableShape {
  const columnIndex = Math.max(0, Math.min(context.columnIndex, table.columnCount - 1));
  const rowIndex = context.lineOffset - 2;
  const insertRow = Array.from({ length: table.columnCount }, () => "");
  if (command === "row-above") {
    const insertAt = Math.max(0, rowIndex < 0 ? 0 : rowIndex);
    return { ...table, rows: [...table.rows.slice(0, insertAt), insertRow, ...table.rows.slice(insertAt)] };
  }
  if (command === "row-below") {
    const insertAt = Math.max(0, rowIndex < 0 ? 0 : rowIndex + 1);
    return { ...table, rows: [...table.rows.slice(0, insertAt), insertRow, ...table.rows.slice(insertAt)] };
  }
  if (command === "row-move-up") {
    if (rowIndex <= 0 || rowIndex >= table.rows.length) return table;
    const rows = [...table.rows];
    [rows[rowIndex - 1], rows[rowIndex]] = [rows[rowIndex], rows[rowIndex - 1]];
    return { ...table, rows };
  }
  if (command === "row-move-down") {
    if (rowIndex < 0 || rowIndex >= table.rows.length - 1) return table;
    const rows = [...table.rows];
    [rows[rowIndex], rows[rowIndex + 1]] = [rows[rowIndex + 1], rows[rowIndex]];
    return { ...table, rows };
  }
  if (command === "row-delete") {
    if (rowIndex < 0 || rowIndex >= table.rows.length) return table;
    const rows = table.rows.filter((_, index) => index !== rowIndex);
    return { ...table, rows: rows.length ? rows : [insertRow] };
  }
  if (command === "column-left" || command === "column-right") {
    const insertAt = Math.max(0, Math.min(table.columnCount, columnIndex + (command === "column-right" ? 1 : 0)));
    const insertCell = (cells: string[]) => [...cells.slice(0, insertAt), "", ...cells.slice(insertAt)];
    return {
      ...table,
      columnCount: table.columnCount + 1,
      headers: insertCell(table.headers),
      alignments: [...table.alignments.slice(0, insertAt), null, ...table.alignments.slice(insertAt)],
      rows: table.rows.map(insertCell),
    };
  }
  if (command === "column-move-left" || command === "column-move-right") {
    const targetIndex = command === "column-move-left" ? columnIndex - 1 : columnIndex + 1;
    if (targetIndex < 0 || targetIndex >= table.columnCount) return table;
    const swap = <T,>(cells: T[]) => {
      const next = [...cells];
      [next[targetIndex], next[columnIndex]] = [next[columnIndex], next[targetIndex]];
      return next;
    };
    return {
      ...table,
      headers: swap(table.headers),
      alignments: swap(table.alignments),
      rows: table.rows.map(swap),
    };
  }
  if (command === "column-align-left" || command === "column-align-center" || command === "column-align-right") {
    const alignments = [...table.alignments];
    alignments[columnIndex] = command === "column-align-left" ? "left" : command === "column-align-center" ? "center" : "right";
    return { ...table, alignments };
  }
  if (command === "column-delete") {
    if (table.columnCount <= 1) return table;
    const removeCell = <T,>(cells: T[]) => cells.filter((_, index) => index !== columnIndex);
    return {
      ...table,
      columnCount: table.columnCount - 1,
      headers: removeCell(table.headers),
      alignments: removeCell(table.alignments),
      rows: table.rows.map(removeCell),
    };
  }
  if (command === "sort-asc" || command === "sort-desc") {
    const multiplier = command === "sort-asc" ? 1 : -1;
    return {
      ...table,
      rows: [...table.rows].sort((left, right) => multiplier * (left[columnIndex] || "").localeCompare(right[columnIndex] || "", undefined, { numeric: true, sensitivity: "base" })),
    };
  }
  return table;
}
