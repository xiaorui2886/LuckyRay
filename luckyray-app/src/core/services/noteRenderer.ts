import { splitMarkdownEmbedTarget } from "../markdown/embedTargets";
import { standardMarkdownReferences, isStandaloneVideoReference } from "../markdown/realVaultEmbeds";

export type NoteInlineToken =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "emphasis"; value: string }
  | { type: "code"; value: string }
  | { type: "strike"; value: string }
  | { type: "asset"; target: string; display: string; width: number | null; height?: number | null; markdown?: boolean }
  | { type: "wiki"; target: string; title: string; subpath: string; blockId: string | null; alias: string; display: string }
  | { type: "url"; label: string; href: string }
  | { type: "tag"; name: string; display: string };

export type TableAlignment = "left" | "center" | "right" | null;
export type TextAlignment = "left" | "center" | "right";

export type NoteFrontmatterProperty = {
  key: string;
  values: string[];
};

export type NoteFrontmatter = {
  properties: NoteFrontmatterProperty[];
  bodyText: string;
};

export type NotePreviewBlock =
  | { type: "space"; key: string }
  | { type: "hr"; key: string; blockId: string | null }
  | { type: "code"; key: string; content: string; language: string }
  | { type: "asset-card"; key: string; target: string; display: string; width: number | null; height?: number | null; blockId: string | null }
  | { type: "heading"; key: string; level: number; tokens: NoteInlineToken[]; headingKey: string; blockId: string | null }
  | { type: "task"; key: string; line: number; checked: boolean; tokens: NoteInlineToken[]; blockId: string | null }
  | { type: "list"; key: string; ordered: boolean; marker: string; tokens: NoteInlineToken[]; blockId: string | null }
  | { type: "quote"; key: string; tokens: NoteInlineToken[]; blockId: string | null }
  | { type: "align"; key: string; alignment: TextAlignment; lines: NoteInlineToken[][]; blockId: string | null }
  | { type: "callout"; key: string; kind: string; title: string; lines: NoteInlineToken[][]; folded: boolean; blockId: string | null }
  | { type: "table"; key: string; source: string; headers: NoteInlineToken[][]; rows: NoteInlineToken[][][]; alignments: TableAlignment[]; blockId: string | null }
  | { type: "paragraph"; key: string; tokens: NoteInlineToken[]; blockId: string | null };

export function noteInlinePlainText(tokens: NoteInlineToken[]) {
  return tokens.map((token) => {
    if (token.type === "text" || token.type === "strong" || token.type === "emphasis" || token.type === "code" || token.type === "strike") {
      return token.value;
    }
    if (token.type === "tag") return token.display;
    if (token.type === "url") return token.label;
    return token.display;
  }).join("");
}

export function normalizeNoteHeadingPath(value: string | null | undefined) {
  return (value || "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function normalizeFrontmatterValue(value: string) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function parseFrontmatterValues(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(normalizeFrontmatterValue).filter(Boolean);
  }
  if (trimmed.includes(",") && !/^https?:\/\//i.test(trimmed)) {
    return trimmed.split(",").map(normalizeFrontmatterValue).filter(Boolean);
  }
  return [normalizeFrontmatterValue(trimmed)].filter(Boolean);
}

export function parseNoteFrontmatter(text: string): NoteFrontmatter {
  const normalized = text.replace(/^\uFEFF/, "");
  const firstBreak = normalized.indexOf("\n");
  if (!normalized.startsWith("---") || firstBreak < 0 || normalized.slice(0, firstBreak).trim() !== "---") {
    return { properties: [], bodyText: text };
  }

  const closingMatch = /\n---\s*(?:\r?\n|$)/.exec(normalized.slice(firstBreak));
  if (!closingMatch) return { properties: [], bodyText: text };

  const frontmatterStart = firstBreak + 1;
  const frontmatterEnd = firstBreak + closingMatch.index;
  const bodyStart = firstBreak + closingMatch.index + closingMatch[0].length;
  const yaml = normalized.slice(frontmatterStart, frontmatterEnd).replace(/\r/g, "");
  const propertyMap = new Map<string, string[]>();
  let currentKey: string | null = null;

  yaml.split("\n").forEach((line) => {
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const values = parseFrontmatterValues(keyMatch[2]);
      propertyMap.set(currentKey, [...(propertyMap.get(currentKey) || []), ...values]);
      return;
    }

    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (currentKey && listMatch) {
      propertyMap.set(currentKey, [...(propertyMap.get(currentKey) || []), ...parseFrontmatterValues(listMatch[1])]);
    }
  });

  return {
    properties: Array.from(propertyMap.entries()).map(([key, values]) => ({ key, values: Array.from(new Set(values)) })),
    bodyText: normalized.slice(bodyStart),
  };
}

export function extractNoteFrontmatterMetadata(text: string) {
  const { properties } = parseNoteFrontmatter(text);
  const read = (keys: string[]) => properties
    .filter((property) => keys.includes(property.key.toLocaleLowerCase()))
    .flatMap((property) => property.values)
    .map((value) => value.replace(/^#/, "").trim())
    .filter(Boolean);
  return {
    tags: Array.from(new Set(read(["tag", "tags"]))),
    aliases: Array.from(new Set(read(["alias", "aliases"]))),
  };
}

export function splitWikiTarget(raw: string) {
  const [targetPart, ...aliasParts] = raw.split("|");
  const target = targetPart.trim();
  const alias = aliasParts.join("|").trim();
  const hashIndex = target.indexOf("#");
  const title = hashIndex >= 0 ? target.slice(0, hashIndex).trim() : target;
  const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : "";
  const blockId = subpath.startsWith("^") ? subpath.slice(1).trim() || null : null;
  return {
    target,
    title,
    subpath,
    blockId,
    alias,
    display: alias || target || (blockId ? `^${blockId}` : raw.trim()),
  };
}

function parseAssetEmbedTarget(raw: string) {
  const parsed = splitMarkdownEmbedTarget(raw);
  const widthMatch = /^(\d{2,4})(?:x\d{2,4})?$/.exec(parsed.alias);
  const width = widthMatch ? Number(widthMatch[1]) : null;
  return {
    target: parsed.target,
    display: width ? parsed.target : parsed.alias || parsed.target,
    width,
  };
}

function pushInlineText(tokens: NoteInlineToken[], value: string) {
  if (!value) return;

  const pattern = /(`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|(^|[^*])\*([^*\n]+)\*|(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]+))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    const raw = match[1];
    if (match.index > last) {
      tokens.push({ type: "text", value: value.slice(last, match.index) });
    }

    if (match[2] !== undefined) {
      tokens.push({ type: "code", value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: "strong", value: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: "strike", value: match[4] });
    } else if (match[6] !== undefined) {
      const prefix = match[5] || "";
      if (prefix) tokens.push({ type: "text", value: prefix });
      tokens.push({ type: "emphasis", value: match[6] || "" });
    } else {
      const prefix = match[7] || "";
      const name = match[8] || "";
      if (prefix) tokens.push({ type: "text", value: prefix });
      tokens.push({ type: "tag", name, display: `#${name}` });
    }

    last = match.index + raw.length;
  }

  if (last < value.length) {
    tokens.push({ type: "text", value: value.slice(last) });
  }
}

function getInlineCodeRanges(value: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const inlineCode = /`+[^`\n]*`+/g;
  let match: RegExpExecArray | null;
  while ((match = inlineCode.exec(value)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function inlineRangeIntersects(start: number, end: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => start < range.end && end > range.start);
}

export function parseNoteInline(value: string): NoteInlineToken[] {
  const references = standardMarkdownReferences(value);
  if (references.length) {
    const output: NoteInlineToken[] = [];
    let end = 0;
    for (const reference of references) {
      output.push(...parseLegacyNoteInline(value.slice(end, reference.from)));
      if ((reference.embedded && reference.local) || isStandaloneVideoReference(value, reference)) output.push({ type: "asset", target: reference.target, display: reference.label || reference.target, width: reference.width, height: reference.height, markdown: true });
      else output.push({ type: "url", label: reference.label || reference.target, href: reference.target });
      end = reference.to;
    }
    output.push(...parseLegacyNoteInline(value.slice(end)));
    return output;
  }
  return parseLegacyNoteInline(value);
}

function parseLegacyNoteInline(value: string): NoteInlineToken[] {
  const tokens: NoteInlineToken[] = [];
  const inlineCodeRanges = getInlineCodeRanges(value);
  const pattern = /(!?[\uFEFF\u200B-\u200D\u2060]*(?:\\?\[){2}([^\]]+?)(?:\\?\]){2}|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (inlineRangeIntersects(match.index, match.index + match[0].length, inlineCodeRanges)) continue;
    if (match.index > last) pushInlineText(tokens, value.slice(last, match.index));
    const raw = match[1];
    if (raw.startsWith("!")) {
      const asset = parseAssetEmbedTarget((match[2] || "").trim());
      tokens.push({ type: "asset", target: asset.target, display: asset.display, width: asset.width });
    } else if (match[2]) {
      tokens.push({ type: "wiki", ...splitWikiTarget(match[2]) });
    } else {
      tokens.push({ type: "url", label: match[3], href: match[4] });
    }
    last = match.index + raw.length;
  }
  if (last < value.length) pushInlineText(tokens, value.slice(last));
  return tokens;
}

function extractTrailingBlockId(line: string) {
  const match = /^(.*?)(?:\s+\^([A-Za-z0-9_-]+))\s*$/.exec(line);
  if (!match) return { content: line, blockId: null as string | null };
  return { content: match[1], blockId: match[2] };
}

function isEscapedPipe(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function trimOuterTablePipes(line: string) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !isEscapedPipe(value, value.length - 1)) value = value.slice(0, -1);
  return value;
}

export function parseMarkdownTableCells(line: string) {
  const value = trimOuterTablePipes(line);
  const cells: string[] = [];
  let current = "";
  let codeFence = "";
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "`") {
      let cursor = index;
      while (cursor < value.length && value[cursor] === "`") cursor += 1;
      const run = value.slice(index, cursor);
      if (!codeFence) {
        codeFence = run;
      } else if (run === codeFence) {
        codeFence = "";
      }
      current += run;
      index = cursor - 1;
      continue;
    }

    if (!codeFence) {
      if (char === "[" && !isEscapedPipe(value, index)) bracketDepth += 1;
      else if (char === "]" && bracketDepth > 0 && !isEscapedPipe(value, index)) bracketDepth -= 1;
      else if (char === "(" && bracketDepth === 0 && !isEscapedPipe(value, index) && (parenDepth > 0 || value[index - 1] === "]")) parenDepth += 1;
      else if (char === ")" && parenDepth > 0 && !isEscapedPipe(value, index)) parenDepth -= 1;
    }

    if (char === "|" && !codeFence && bracketDepth === 0 && parenDepth === 0 && !isEscapedPipe(value, index)) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);

  return cells.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

export function isMarkdownTableSeparatorLine(line: string | undefined) {
  if (!line) return false;
  const cells = parseMarkdownTableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function parseMarkdownTableAlignments(line: string): TableAlignment[] {
  return parseMarkdownTableCells(line).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    if (cell.startsWith(":")) return "left";
    return null;
  });
}

export function isMarkdownHorizontalRule(line: string | undefined) {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line || "");
}

export function parseNotePreviewBlocks(text: string): NotePreviewBlock[] {
  const { bodyText } = parseNoteFrontmatter(text);
  const lines = bodyText.split(/\r?\n/);
  const blocks: NotePreviewBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || "";
    const trimmedLine = line.trim();

    const fence = /^(```|~~~)\s*([\w-]+)?/.exec(trimmedLine);
    if (fence) {
      const codeLines: string[] = [];
      const marker = fence[1];
      const language = fence[2] || "";
      index += 1;
      while (index < lines.length && !(lines[index] || "").trim().startsWith(marker)) {
        codeLines.push(lines[index] || "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", key: `code-${index}`, content: codeLines.join("\n"), language });
      continue;
    }

    if (!trimmedLine) {
      blocks.push({ type: "space", key: `space-${index}` });
      index += 1;
      continue;
    }

    const { content, blockId } = extractTrailingBlockId(line);
    const trimmed = content.trim();

    const align = /^<div\s+align=["']?(left|center|right)["']?>\s*$/i.exec(trimmed);
    if (align) {
      const alignment = align[1].toLocaleLowerCase() as TextAlignment;
      const body: NoteInlineToken[][] = [];
      index += 1;
      while (index < lines.length && !/^<\/div>\s*$/i.test((lines[index] || "").trim())) {
        body.push(parseNoteInline(lines[index] || ""));
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "align", key: `align-${index}`, alignment, lines: body.length ? body : [[]], blockId });
      continue;
    }

    if (isMarkdownHorizontalRule(content)) {
      blocks.push({ type: "hr", key: `hr-${index}`, blockId });
      index += 1;
      continue;
    }

    const tableNext = lines[index + 1];
    if (trimmed.includes("|") && isMarkdownTableSeparatorLine(tableNext)) {
      const sourceLines = [line, tableNext || ""];
      const headers = parseMarkdownTableCells(content).map(parseNoteInline);
      const alignments = parseMarkdownTableAlignments(tableNext || "");
      const rows: NoteInlineToken[][][] = [];
      index += 2;
      while (index < lines.length) {
        const row = lines[index] || "";
        const rowTrimmed = row.trim();
        if (!rowTrimmed || !rowTrimmed.includes("|") || /^```/.test(rowTrimmed)) break;
        sourceLines.push(row);
        rows.push(parseMarkdownTableCells(extractTrailingBlockId(row).content).map(parseNoteInline));
        index += 1;
      }
      blocks.push({ type: "table", key: `table-${index}`, source: sourceLines.join("\n"), headers, rows, alignments, blockId });
      continue;
    }

    const callout = /^>\s*\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)$/.exec(trimmed);
    if (callout) {
      const kind = callout[1].toLocaleLowerCase();
      const folded = callout[2] === "-";
      const title = callout[3].trim() || callout[1];
      const body: NoteInlineToken[][] = [];
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index] || "")) {
        body.push(parseNoteInline((lines[index] || "").replace(/^>\s?/, "")));
        index += 1;
      }
      blocks.push({ type: "callout", key: `callout-${index}`, kind, title, lines: body, folded, blockId });
      continue;
    }

    const embedOnly = /^![\uFEFF\u200B-\u200D\u2060]*(?:\\?\[){2}([^\]]+?)(?:\\?\]){2}\s*$/.exec(trimmed);
    if (embedOnly) {
      const asset = parseAssetEmbedTarget(embedOnly[1].trim());
      blocks.push({ type: "asset-card", key: `embed-${index}`, target: asset.target, display: asset.display, width: asset.width, blockId });
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(content);
    if (heading) {
      const tokens = parseNoteInline(heading[2]);
      blocks.push({
        type: "heading",
        key: `h-${index}`,
        level: Math.min(heading[1].length, 4),
        tokens,
        headingKey: normalizeNoteHeadingPath(noteInlinePlainText(tokens)),
        blockId,
      });
      index += 1;
      continue;
    }

    const task = /^\s*[-*]\s+\[([ xX])\](?:\s+(.*))?$/.exec(content);
    if (task) {
      blocks.push({ type: "task", key: `task-${index}`, line: index, checked: task[1].toLocaleLowerCase() === "x", tokens: parseNoteInline(task[2] || ""), blockId });
      index += 1;
      continue;
    }

    const orderedList = /^\s*(\d+[.)])(?:\s+(.*))?$/.exec(content);
    if (orderedList) {
      blocks.push({ type: "list", key: `ol-${index}`, ordered: true, marker: orderedList[1], tokens: parseNoteInline(orderedList[2] || ""), blockId });
      index += 1;
      continue;
    }

    const list = /^\s*[-*](?:\s+(.*))?$/.exec(content);
    if (list) {
      blocks.push({ type: "list", key: `li-${index}`, ordered: false, marker: "-", tokens: parseNoteInline(list[1] || ""), blockId });
      index += 1;
      continue;
    }

    const quote = /^>\s?(.+)$/.exec(content);
    if (quote) {
      blocks.push({ type: "quote", key: `q-${index}`, tokens: parseNoteInline(quote[1]), blockId });
      index += 1;
      continue;
    }

    blocks.push({ type: "paragraph", key: `p-${index}`, tokens: parseNoteInline(content), blockId });
    index += 1;
  }

  return blocks;
}
