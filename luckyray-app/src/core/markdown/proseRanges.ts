export function isInsideInlineCodeAt(lineText: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, lineText.length));
  let codeFence = "";
  let codeStart = -1;

  for (let index = 0; index < lineText.length; index += 1) {
    if (lineText[index] !== "`") continue;
    let cursor = index;
    while (cursor < lineText.length && lineText[cursor] === "`") cursor += 1;
    const run = lineText.slice(index, cursor);
    if (!codeFence) {
      codeFence = run;
      codeStart = index;
    } else if (run === codeFence) {
      if (safeOffset > codeStart && safeOffset <= cursor) return true;
      codeFence = "";
      codeStart = -1;
    }
    index = cursor - 1;
  }

  return Boolean(codeFence && safeOffset > codeStart);
}

export function isPlainMarkdownProseAt(text: string, cursor: number) {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const normalized = text.replace(/^\uFEFF/, "");
  const pieces = normalized.split(/(\r?\n)/);
  let offset = 0;
  let lineNumber = 1;
  let currentLine = "";
  let currentLineStart = 0;

  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index] || "";
    const separator = pieces[index + 1] || "";
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    if (safeCursor <= lineEnd || (!separator && index >= pieces.length - 2)) {
      currentLine = line;
      currentLineStart = lineStart;
      break;
    }
    offset = lineEnd + separator.length;
    lineNumber += 1;
  }

  if (pieces.length === 1 && safeCursor === 0) {
    currentLine = pieces[0] || "";
    currentLineStart = 0;
  }

  const firstLine = pieces[0] || "";
  if (firstLine.trim() === "---") {
    let closeLine = -1;
    for (let index = 2, number = 2; index < pieces.length; index += 2, number += 1) {
      if ((pieces[index] || "").trim() === "---") {
        closeLine = number;
        break;
      }
    }
    if (closeLine > 0 && lineNumber <= closeLine) return false;
  }

  let fenceMarker: string | null = null;
  for (let index = 0, number = 1; index < pieces.length && number <= lineNumber; index += 2, number += 1) {
    const line = pieces[index] || "";
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (number === lineNumber) return false;
      if (!fenceMarker) {
        fenceMarker = fence[1];
      } else if (fenceMarker === fence[1]) {
        fenceMarker = null;
      }
      continue;
    }
    if (number === lineNumber) break;
  }

  if (fenceMarker) return false;
  return !isInsideInlineCodeAt(currentLine, safeCursor - currentLineStart);
}
