export type SameNoteAnchor = {
  kind: "heading" | "block";
  label: string;
  insertText: string;
  detail: string;
  searchText: string;
  line: number;
  from: number;
  to: number;
};

function normalizeLookup(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function scoreAnchor(anchor: SameNoteAnchor, query: string) {
  const text = normalizeLookup(anchor.searchText);
  const q = normalizeLookup(query);
  if (!q) return 20;
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  const index = text.indexOf(q);
  return index >= 0 ? 10 + index : 1000;
}

function splitLinesWithOffsets(text: string) {
  const pieces = text.split(/(\r?\n)/);
  const lines: Array<{ text: string; from: number; to: number; number: number }> = [];
  let offset = 0;
  let number = 1;

  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index] || "";
    const separator = pieces[index + 1] || "";
    if (index === pieces.length - 1 && !line && !separator) break;
    lines.push({ text: line, from: offset, to: offset + line.length, number });
    offset += line.length + separator.length;
    number += 1;
  }

  return lines;
}

function withoutTrailingBlockId(line: string) {
  const match = /^(.*?)(\s+\^([A-Za-z0-9_-]+))\s*$/.exec(line);
  if (!match) return { content: line, blockId: null as string | null, blockStart: null as number | null, blockEnd: null as number | null };
  const blockToken = `^${match[3]}`;
  const blockStart = match[1].length + match[2].indexOf(blockToken);
  return {
    content: match[1],
    blockId: match[3],
    blockStart,
    blockEnd: blockStart + blockToken.length,
  };
}

function normalizeHeadingPath(value: string | null | undefined) {
  return (value || "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function pushUnique(items: SameNoteAnchor[], seen: Set<string>, item: SameNoteAnchor) {
  const key = `${item.kind}:${normalizeLookup(item.insertText)}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

export function sameNoteAnchorSearchQuery(query: string) {
  return query.replace(/^#\^?/, "").replace(/\|.*$/, "").trim();
}

export function parseWikiAnchorQuery(query: string) {
  const aliasIndex = query.indexOf("|");
  const beforeAlias = aliasIndex >= 0 ? query.slice(0, aliasIndex) : query;
  const hashIndex = beforeAlias.indexOf("#");
  if (hashIndex < 0) return null;
  const noteTitle = beforeAlias.slice(0, hashIndex).trim();
  const anchorQuery = beforeAlias.slice(hashIndex).trim();
  if (!/^#\^?[^\]\n]*$/.test(anchorQuery)) return null;
  return {
    noteTitle: noteTitle || null,
    anchorQuery,
    aliasSuffix: aliasIndex >= 0 ? query.slice(aliasIndex) : "",
  };
}

export function collectSameNoteAnchors(text: string): SameNoteAnchor[] {
  const anchors: SameNoteAnchor[] = [];
  const seen = new Set<string>();
  const lines = splitLinesWithOffsets(text);
  let codeFenceMarker: string | null = null;
  let inFrontmatter = lines[0]?.text.replace(/^\uFEFF/, "").trim() === "---";

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (inFrontmatter) {
      if (line.number > 1 && trimmed === "---") inFrontmatter = false;
      continue;
    }

    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      if (!codeFenceMarker) {
        codeFenceMarker = fence[1];
      } else if (codeFenceMarker === fence[1]) {
        codeFenceMarker = null;
      }
      continue;
    }
    if (codeFenceMarker) continue;

    const { content, blockId, blockStart, blockEnd } = withoutTrailingBlockId(line.text);
    const heading = /^(#{1,6})\s+(.+)$/.exec(content.trim());
    if (heading) {
      const label = heading[2].trim();
      if (label) {
        pushUnique(anchors, seen, {
          kind: "heading",
          label,
          insertText: `#${label}`,
          detail: `H${Math.min(heading[1].length, 6)}`,
          searchText: label,
          line: line.number,
          from: line.from,
          to: line.to,
        });
      }
    }

    if (blockId && blockStart !== null && blockEnd !== null) {
      pushUnique(anchors, seen, {
        kind: "block",
        label: `^${blockId}`,
        insertText: `#^${blockId}`,
        detail: "块引用",
        searchText: blockId,
        line: line.number,
        from: line.from + blockStart,
        to: line.from + blockEnd,
      });
    }
  }

  return anchors;
}

export function getSameNoteAnchorCompletions(text: string, query: string) {
  const blockOnly = query.startsWith("#^");
  const search = sameNoteAnchorSearchQuery(query);
  return collectSameNoteAnchors(text)
    .filter((item) => !blockOnly || item.kind === "block")
    .map((item) => ({ item, score: scoreAnchor(item, search) }))
    .filter((entry) => entry.score < 1000)
    .sort((a, b) => a.score - b.score || a.item.line - b.item.line || a.item.label.localeCompare(b.item.label, "zh-CN"))
    .slice(0, 20)
    .map((entry) => entry.item);
}

export function getWikiAnchorCompletions(text: string, query: string) {
  const parsed = parseWikiAnchorQuery(query);
  if (!parsed) return [];
  return getSameNoteAnchorCompletions(text, parsed.anchorQuery)
    .map((anchor) => ({
      ...anchor,
      insertText: `${parsed.noteTitle || ""}${anchor.insertText}${parsed.aliasSuffix || ""}`,
    }));
}

export function findSameNoteAnchorRange(text: string, options: { blockId?: string | null; headingPath?: string | null }) {
  const anchors = collectSameNoteAnchors(text);
  if (options.blockId) {
    const normalized = normalizeLookup(options.blockId);
    return anchors.find((anchor) => anchor.kind === "block" && normalizeLookup(anchor.searchText) === normalized) || null;
  }

  if (options.headingPath) {
    const normalized = normalizeHeadingPath(options.headingPath);
    return anchors.find((anchor) => anchor.kind === "heading" && normalizeHeadingPath(anchor.searchText) === normalized) || null;
  }

  return null;
}
