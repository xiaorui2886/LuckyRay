/**
 * Reconciles in-flight user drafts with markdown link rewrites performed during note moves.
 *
 * Uses CommonMark AST parsing to accurately target valid markdown links, images,
 * and link reference definitions while strictly preserving:
 * - Fenced and indented code blocks
 * - Inline code spans
 * - Escaped characters
 * - Network URLs (http, https, mailto, etc.) and anchor fragments
 */
import { fromMarkdown } from "mdast-util-from-markdown";

// Keep the existing Windows reconciliation until its own release changes it.
// The macOS adapter opts in to the stricter handling for its native move path.
export type MoveLinkPolicy = "legacy" | "macos";

/**
 * Extracts POSIX directory part of a relative path (empty string for root).
 */
export function toPosixDir(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

/**
 * Unescapes Markdown backslash escapes and decodes HTML/numeric character entities in a URL.
 */
export function unescapeMarkdownUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  return rawUrl
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>:="&/])/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&amp;/gi, "&");
}

/**
 * Determines whether a link target is non-relative (remote, anchor, absolute, or custom scheme).
 * Accurately classifies external URLs even when containing backslash escapes, character entities, or protocol-relative prefixes.
 */
export function isNonRelativeTarget(target: string): boolean {
  if (!target) return true;
  const trimmed = target.trim();
  if (trimmed.startsWith("#")) return true;
  const unescaped = unescapeMarkdownUrl(trimmed);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(unescaped)) return true; // http:, https:, data:, file:, real-vault:, mailto:, ftp:, etc.
  if (unescaped.startsWith("//")) return true; // Protocol-relative //cdn.example.com
  if (unescaped.startsWith("/") || unescaped.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(unescaped)) return true; // Windows drive C:\
  return false;
}

/**
 * Rebases a local relative target from oldDir to newDir within a vault.
 */
export function rebaseRelativeTarget(oldDir: string, newDir: string, target: string, policy: MoveLinkPolicy = "legacy"): string {
  if (oldDir === newDir || isNonRelativeTarget(target)) {
    return target;
  }

  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const hashPart = hashIndex >= 0 ? target.slice(hashIndex) : "";

  const queryIndex = pathPart.indexOf("?");
  const cleanPath = queryIndex >= 0 ? pathPart.slice(0, queryIndex) : pathPart;
  const queryPart = queryIndex >= 0 ? pathPart.slice(queryIndex) : "";

  // Resolve cleanPath relative to oldDir
  const oldSegments = oldDir ? oldDir.split("/").filter(Boolean) : [];
  const targetSegments = cleanPath.split("/").filter(Boolean);

  const resolved: string[] = [...oldSegments];
  for (const seg of targetSegments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (resolved.length > 0 && (policy === "legacy" || resolved[resolved.length - 1] !== "..")) resolved.pop();
      else if (policy === "macos") resolved.push(".."); // Keep targets outside the vault outside it.
    } else {
      resolved.push(seg);
    }
  }

  // Compute relative path from newDir to resolved
  const newSegments = newDir ? newDir.split("/").filter(Boolean) : [];
  let commonLen = 0;
  while (
    commonLen < newSegments.length &&
    commonLen < resolved.length &&
    newSegments[commonLen] === resolved[commonLen]
  ) {
    commonLen++;
  }

  const upCount = newSegments.length - commonLen;
  const upParts: string[] = Array(upCount).fill("..");
  const downParts: string[] = resolved.slice(commonLen);
  const rebasedParts = [...upParts, ...downParts];
  const rebasedPath = rebasedParts.join("/") || ".";

  return `${rebasedPath}${queryPart}${hashPart}`;
}

/**
 * Checks whether the character at index in str is escaped by an odd number of leading backslashes.
 */
function isEscapedAt(str: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && str[i] === "\\"; i--) {
    count++;
  }
  return count % 2 === 1;
}

/**
 * Locates the exact character destination span within a node's raw source slice.
 * Uses backtick-aware label scanning to accurately skip inline code spans (e.g. `\]\(a.png)` inside labels).
 */
function locateDestinationSpan(raw: string, type: string, _expectedUrl?: string): { start: number; end: number } | null {
  function findClosingBracket(): number {
    let bracketDepth = 0;
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "\\") {
        i += 2;
        continue;
      }
      if (raw[i] === "`") {
        let b = 0;
        while (i + b < raw.length && raw[i + b] === "`") b++;
        const closeIdx = raw.indexOf("`".repeat(b), i + b);
        if (closeIdx !== -1) {
          i = closeIdx + b;
          continue;
        }
      }
      if (raw[i] === "[") {
        bracketDepth++;
      } else if (raw[i] === "]") {
        bracketDepth--;
        if (bracketDepth === 0) {
          return i;
        }
      }
      i++;
    }
    return -1;
  }

  if (type === "definition") {
    const closeBracket = findClosingBracket();
    if (closeBracket === -1) return null;
    const colonIdx = raw.indexOf(":", closeBracket);
    if (colonIdx === -1) return null;
    let cursor = colonIdx + 1;
    while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
    if (cursor >= raw.length) return null;
    if (raw[cursor] === "<") {
      const start = cursor + 1;
      const end = raw.indexOf(">", start);
      if (end === -1) return null;
      return { start, end };
    }
    const start = cursor;
    let end = cursor;
    while (end < raw.length && !/\s/.test(raw[end])) end++;
    return { start, end };
  } else if (type === "image" || type === "link") {
    const closeBracket = findClosingBracket();
    if (closeBracket === -1) return null;
    const openParen = raw.indexOf("(", closeBracket);
    if (openParen === -1) return null;
    let cursor = openParen + 1;
    while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
    if (cursor >= raw.length) return null;
    if (raw[cursor] === "<") {
      const start = cursor + 1;
      const end = raw.indexOf(">", start);
      if (end === -1) return null;
      return { start, end };
    }
    const start = cursor;
    let end = cursor;
    let parenDepth = 0;
    while (end < raw.length) {
      if (raw[end] === "\\") {
        end += 2;
        continue;
      }
      if (raw[end] === "(") {
        parenDepth++;
        end++;
        continue;
      }
      if (raw[end] === ")") {
        if (parenDepth > 0) {
          parenDepth--;
          end++;
          continue;
        }
        break;
      }
      if (/\s/.test(raw[end])) break;
      end++;
    }
    return { start, end };
  }
  return null;
}

interface PatchSpan {
  start: number;
  end: number;
  replacement: string;
}

// Match a closed leading metadata block. An unclosed opening rule is still
// ordinary Markdown, so it must not suppress subsequent links.
function leadingMetadataEnd(content: string): number {
  const opening = /^(?:\uFEFF)?(---|\+\+\+)[ \t]*\r?\n/.exec(content);
  if (!opening) return 0;
  const closing = opening[1] === "---" ? /^---[ \t]*(?:\r?\n|$)/gm : /^\+\+\+[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(content);
  return match ? match.index + match[0].length : 0;
}

/**
 * Rebases all relative markdown links, images and reference definitions from oldRelativePath to newRelativePath.
 * Guarantees code blocks, inline code, escaped characters, and external URLs are untouched.
 */
export function rebaseMarkdownContent(
  oldRelativePath: string,
  newRelativePath: string,
  content: string,
  rewrites: Map<string, string> = new Map(),
  policy: MoveLinkPolicy = "legacy"
): string {
  const oldDir = toPosixDir(oldRelativePath);
  const newDir = toPosixDir(newRelativePath);
  if (oldDir === newDir) {
    return content;
  }

  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(content);
  } catch {
    return content;
  }

  const patches: PatchSpan[] = [];
  const excludedRanges: Array<{ start: number; end: number }> = [];
  const astNodeRanges: Array<{ start: number; end: number }> = [];
  const metadataEnd = policy === "macos" ? leadingMetadataEnd(content) : 0;
  if (metadataEnd) excludedRanges.push({ start: 0, end: metadataEnd });

  function walk(node: any) {
    if (node.type === "code" || node.type === "inlineCode" || (policy === "macos" && node.type === "html")) {
      if (node.position?.start?.offset !== undefined && node.position?.end?.offset !== undefined) {
        excludedRanges.push({ start: node.position.start.offset, end: node.position.end.offset });
      }
      return;
    }
    if (node.type === "image" || node.type === "link" || node.type === "definition") {
      if (node.position?.start?.offset !== undefined && node.position?.end?.offset !== undefined) {
        astNodeRanges.push({ start: node.position.start.offset, end: node.position.end.offset });
        // Use parsed AST URL to classify whether this node points to an external or non-relative target.
        // If the parsed node.url is non-relative/external, leave it completely untouched, preserving original text and range.
        const parsedUrl = typeof node.url === "string" ? node.url : "";
        if (!isNonRelativeTarget(parsedUrl)) {
          const raw = content.slice(node.position.start.offset, node.position.end.offset);
          const span = locateDestinationSpan(raw, node.type, parsedUrl);
          if (span) {
            const absStart = node.position.start.offset + span.start;
            const absEnd = node.position.start.offset + span.end;
            const target = content.slice(absStart, absEnd);
            if (absStart >= metadataEnd && !isNonRelativeTarget(target)) {
              if (rewrites.has(target)) {
                patches.push({ start: absStart, end: absEnd, replacement: rewrites.get(target)! });
              } else if (rewrites.has(parsedUrl)) {
                patches.push({ start: absStart, end: absEnd, replacement: rewrites.get(parsedUrl)! });
              } else {
                const rebased = rebaseRelativeTarget(oldDir, newDir, target, policy);
                if (rebased !== target) {
                  patches.push({ start: absStart, end: absEnd, replacement: rebased });
                }
              }
            }
          }
        }
      }
    }
    if (node.children) {
      node.children.forEach(walk);
    }
  }
  walk(tree);

  // Scan wiki links outside opaque regions and standard AST link ranges.
  const wikiRegex = /(!?\[\[)([^\|\]\r\n]+)(\|?[^\]\r\n]*\]\])/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRegex.exec(content)) !== null) {
    const matchStart = m.index;
    if (isEscapedAt(content, matchStart)) continue;
    const matchEnd = matchStart + m[0].length;
    const inExcluded = excludedRanges.some(c => matchStart >= c.start && matchEnd <= c.end);
    const inAstNode = astNodeRanges.some(r => matchStart >= r.start && matchEnd <= r.end);
    if (!inExcluded && !inAstNode) {
      const target = m[2].trim();
      if (!isNonRelativeTarget(target) && (target.startsWith("./") || target.startsWith("../"))) {
        const targetStart = matchStart + m[1].length + (m[2].length - m[2].trimStart().length);
        const targetEnd = targetStart + target.length;
        if (rewrites.has(target)) {
          patches.push({ start: targetStart, end: targetEnd, replacement: rewrites.get(target)! });
        } else {
          const rebased = rebaseRelativeTarget(oldDir, newDir, target, policy);
          if (rebased !== target) {
            patches.push({ start: targetStart, end: targetEnd, replacement: rebased });
          }
        }
      }
    }
  }

  // De-overlap candidate patches to guarantee no double rewriting or overlapping replacements
  patches.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: PatchSpan[] = [];
  let lastEnd = 0;
  for (const patch of patches) {
    if (patch.start >= lastEnd) {
      nonOverlapping.push(patch);
      lastEnd = patch.end;
    }
  }

  // Sort descending by start offset and apply disjoint replacements from right to left
  nonOverlapping.sort((a, b) => b.start - a.start);
  let result = content;
  for (const patch of nonOverlapping) {
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  return result;
}

/**
 * Extracts markdown destination rewrites between two content versions of the same document.
 */
export function extractMarkdownLinkRewrites(beforeContent: string, movedContent: string): Map<string, string> {
  const rewrites = new Map<string, string>();
  try {
    const beforeUrls: string[] = [];
    const movedUrls: string[] = [];
    const walkCollect = (node: any, urls: string[]) => {
      if (node.type === "code" || node.type === "inlineCode") return;
      if (node.type === "image" || node.type === "link" || node.type === "definition") {
        if (node.url) urls.push(node.url);
      }
      if (node.children) node.children.forEach((c: any) => walkCollect(c, urls));
    };
    walkCollect(fromMarkdown(beforeContent), beforeUrls);
    walkCollect(fromMarkdown(movedContent), movedUrls);

    if (beforeUrls.length === movedUrls.length) {
      for (let i = 0; i < beforeUrls.length; i++) {
        if (beforeUrls[i] !== movedUrls[i]) {
          rewrites.set(beforeUrls[i], movedUrls[i]);
        }
      }
    }
  } catch {
    // Fallback if AST parse fails
  }
  return rewrites;
}

/**
 * Reconciles an in-flight user draft with the moved file content and updated relative links.
 *
 * @param oldRelativePath The note's relative path before moving (e.g. "Synthetic.md")
 * @param newRelativePath The note's relative path after moving (e.g. "Moved/Synthetic.md")
 * @param beforeContent The note's saved content before moving
 * @param movedContent The note's content after backend move (with rewritten links)
 * @param draftContent The user's in-flight draft typed during the move
 * @returns Reconciled draft preserving all user inputs while adapting relative links
 */
export function reconcileMovedNoteContent(
  oldRelativePath: string,
  newRelativePath: string,
  beforeContent: string,
  movedContent: string,
  draftContent: string,
  policy: MoveLinkPolicy = "legacy"
): string {
  // If no typing occurred during move, use the moved content directly
  if (draftContent === beforeContent) {
    return movedContent;
  }

  const oldDir = toPosixDir(oldRelativePath);
  const newDir = toPosixDir(newRelativePath);

  // If moved within the same directory, relative links are unchanged
  if (oldDir === newDir) {
    return draftContent;
  }

  // 1. Extract known 1-to-1 rewrites from the backend move operation
  const rewrites = extractMarkdownLinkRewrites(beforeContent, movedContent);

  // 2. Rebase links, images, definitions in the draft without touching code blocks/inline code/escapes
  return rebaseMarkdownContent(oldRelativePath, newRelativePath, draftContent, rewrites, policy);
}
