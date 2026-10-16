export type EditorCommand =
  | "link"
  | "external-link"
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "paragraph"
  | "blockquote"
  | "bulleted-list"
  | "numbered-list"
  | "task-list"
  | "align-left"
  | "align-center"
  | "align-right"
  | "horizontal-rule"
  | "table"
  | "callout"
  | "code-block"
  | "insert-asset"
  | "wiki-link"
  | "cut"
  | "copy"
  | "paste"
  | "paste-text"
  | "select-all";

export type AiWriteAction = "rewrite" | "shorten" | "summary" | "translate" | "expand" | "continue" | "title";

export type EditorRange = {
  start: number;
  end: number;
};

export type EditorCommandInput = {
  content: string;
  selectionStart: number;
  selectionEnd: number;
  clipboard?: Pick<Clipboard, "readText" | "writeText">;
};

export type EditorCommandResult = {
  content: string;
  selection: EditorRange;
  changed: boolean;
  status?: string;
};

export type AiWriteDraft = {
  action: AiWriteAction;
  prompt: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  replacement?: {
    range: EditorRange;
    prefix?: string;
    suffix?: string;
  };
  title?: boolean;
};

export type AiWriteBuildResult =
  | { ok: true; draft: AiWriteDraft }
  | { ok: false; status: string };

function clampOffset(value: number, contentLength: number) {
  if (!Number.isFinite(value)) return contentLength;
  return Math.max(0, Math.min(contentLength, value));
}

export function normalizeEditorRange(content: string, range: EditorRange): EditorRange {
  const start = clampOffset(range.start, content.length);
  const end = clampOffset(range.end, content.length);
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

export function replaceEditorContent(content: string, nextText: string, range: EditorRange): EditorCommandResult {
  const normalized = normalizeEditorRange(content, range);
  const nextContent = `${content.slice(0, normalized.start)}${nextText}${content.slice(normalized.end)}`;
  const cursor = normalized.start + nextText.length;
  return {
    content: nextContent,
    selection: { start: cursor, end: cursor },
    changed: nextContent !== content,
  };
}

function replaceEditorContentWithSelection(content: string, nextText: string, range: EditorRange, selection: EditorRange): EditorCommandResult {
  const normalized = normalizeEditorRange(content, range);
  const nextContent = `${content.slice(0, normalized.start)}${nextText}${content.slice(normalized.end)}`;
  return {
    content: nextContent,
    selection: {
      start: normalized.start + selection.start,
      end: normalized.start + selection.end,
    },
    changed: nextContent !== content,
  };
}

function selectedText(content: string, range: EditorRange) {
  return content.slice(range.start, range.end);
}

function sliceAround(content: string, center: number, beforeLength: number, afterLength: number) {
  const start = Math.max(0, center - beforeLength);
  const end = Math.min(content.length, center + afterLength);
  return {
    before: content.slice(start, center).trim(),
    after: content.slice(center, end).trim(),
  };
}

function tailText(content: string, length: number) {
  return content.slice(Math.max(0, content.length - length)).trim();
}

function compactForPrompt(text: string, maxLength: number) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength * 0.55)).trim()}\n...\n${value.slice(value.length - Math.floor(maxLength * 0.45)).trim()}`;
}

export function buildAiWriteDraft(action: AiWriteAction, input: { content: string; selectionStart: number; selectionEnd: number }): AiWriteBuildResult {
  const range = normalizeEditorRange(input.content, { start: input.selectionStart, end: input.selectionEnd });
  const selected = selectedText(input.content, range);
  const needsSelection = action === "rewrite" || action === "translate" || action === "expand";
  if (needsSelection && !selected.trim()) {
    return { ok: false, status: "请先选中一段文字" };
  }
  const source = selected.trim() || input.content.trim();
  if (!source) {
    return { ok: false, status: "当前笔记没有可处理的内容" };
  }
  const aroundSelection = sliceAround(input.content, range.start, 1200, 900);
  const beforeCursor = tailText(input.content.slice(0, range.start), 3200);
  const afterCursor = input.content.slice(range.start, Math.min(input.content.length, range.start + 800)).trim();
  const prompts: Record<AiWriteAction, string> = {
    rewrite: `请改写下面这段笔记，保持原意，语言更清晰自然。只返回改写后的正文，不要解释、不要 JSON、不要代码块：\n\n${selected}`,
    shorten: `请精简下面这段笔记，保留核心事实和必要格式。只返回精简后的正文，不要解释、不要 JSON、不要代码块：\n\n${selected}`,
    summary: `请总结下面这段内容，输出 3-5 条精炼要点。只返回可直接写入笔记的 Markdown 正文：\n\n${compactForPrompt(source, 6000)}`,
    translate: `请把下面这段内容翻译成中文，保留专有名词。只返回译文，不要解释、不要 JSON、不要代码块：\n\n${selected}`,
    expand: `请扩写“选区文本”，补充必要上下文和结构，让它更完整但不要偏离原意。只返回扩写后的完整正文，不要解释、不要 JSON、不要代码块。\n\n【选区文本】\n${selected}\n\n【前文参考】\n${aroundSelection.before || "（无）"}\n\n【后文参考】\n${aroundSelection.after || "（无）"}`,
    continue: `请从“光标位置”继续往下写，保持前文语气和主题一致。只返回要插入的续写正文，不要重复前文、不要解释、不要 JSON、不要代码块。\n\n【光标前文】\n${beforeCursor || "（无）"}\n\n【光标后文参考】\n${afterCursor || "（无）"}`,
    title: `请给下面这篇笔记生成一个简洁标题，只输出标题，不要引号：\n\n${compactForPrompt(input.content, 6000)}`,
  };
  const draft: AiWriteDraft = {
    action,
    prompt: prompts[action],
    systemPrompt: "你是 LuckyRay 笔记编辑助手。回答必须适合直接写回笔记，不要解释操作过程。",
    temperature: 0.45,
    maxTokens: action === "title" ? 80 : 900,
  };
  if (action === "title") {
    draft.title = true;
  } else if (action === "summary") {
    draft.replacement = { range: { start: range.end, end: range.end }, prefix: "\n\n## AI 摘要\n", suffix: "\n" };
  } else if (action === "continue") {
    draft.replacement = { range: { start: range.start, end: range.start }, prefix: "\n\n" };
  } else {
    draft.replacement = { range };
  }
  return { ok: true, draft };
}

export function cleanAiWriteResponse(raw: string): string {
  let text = String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fence = text.match(/^```(?:markdown|md|text|json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  const fromJson = extractAiTextFromJson(text);
  if (fromJson) text = fromJson;
  text = text
    .replace(/^(?:结果|正文|改写结果|扩写结果|续写内容|翻译结果|总结|标题)\s*[:：]\s*/i, "")
    .replace(/^以下是(?:改写|扩写|续写|翻译|总结)?(?:后的)?(?:内容|正文)?\s*[:：]?\s*/i, "")
    .trim();
  return text;
}

function extractAiTextFromJson(text: string): string | null {
  if (!/^\s*[\[{]/.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return findTextInJson(parsed)?.trim() || null;
  } catch {
    return null;
  }
}

function findTextInJson(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTextInJson(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const preferred = ["content", "text", "result", "output", "answer", "markdown", "rewrite", "summary", "translation", "expanded", "continuation", "title"];
  for (const key of preferred) {
    const found = findTextInJson(record[key]);
    if (found) return found;
  }
  return null;
}

export function applyAiWriteResponse(draft: AiWriteDraft, raw: string): { title?: string; replacement?: { text: string; range: EditorRange } } {
  const text = cleanAiWriteResponse(raw);
  if (!text) throw new Error("AI 没有返回可写入内容");
  if (draft.title) {
    return { title: text.replace(/^#+\s*/, "").slice(0, 80) };
  }
  if (!draft.replacement) throw new Error("AI 写回目标不存在");
  return {
    replacement: {
      range: draft.replacement.range,
      text: `${draft.replacement.prefix || ""}${text}${draft.replacement.suffix || ""}`,
    },
  };
}

function lineRange(content: string, range: EditorRange) {
  const lineStart = content.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
  const nextBreak = content.indexOf("\n", range.end);
  const lineEnd = nextBreak === -1 ? content.length : nextBreak;
  return { start: lineStart, end: lineEnd, text: content.slice(lineStart, lineEnd) };
}

const ALIGN_OPEN_LINE_RE = /^\s*<div\s+align=["']?(left|center|right)["']?>\s*$/i;
const ALIGN_CLOSE_LINE_RE = /^\s*<\/div>\s*$/i;

type EditorLineRange = {
  start: number;
  end: number;
  text: string;
  breakText: string;
};

function splitEditorLines(content: string): EditorLineRange[] {
  const lines: EditorLineRange[] = [];
  let start = 0;
  while (start <= content.length) {
    const nextBreak = content.indexOf("\n", start);
    const hasBreak = nextBreak !== -1;
    const end = hasBreak ? nextBreak : content.length;
    lines.push({
      start,
      end,
      text: content.slice(start, end),
      breakText: hasBreak ? "\n" : "",
    });
    if (!hasBreak) break;
    start = nextBreak + 1;
  }
  return lines;
}

function trimWhitespaceRange(content: string, range: EditorRange): EditorRange {
  let start = range.start;
  let end = range.end;
  while (start < end && /\s/.test(content[start] || "")) start += 1;
  while (end > start && /\s/.test(content[end - 1] || "")) end -= 1;
  return { start, end };
}

function findContainingAlignBlockRange(content: string, range: EditorRange): EditorRange | null {
  const normalized = trimWhitespaceRange(content, normalizeEditorRange(content, range));
  if (normalized.start >= normalized.end) return null;

  const lines = splitEditorLines(content);
  const stack: EditorLineRange[] = [];
  const blocks: EditorRange[] = [];

  for (const line of lines) {
    if (ALIGN_OPEN_LINE_RE.test(line.text)) {
      stack.push(line);
      continue;
    }
    if (ALIGN_CLOSE_LINE_RE.test(line.text) && stack.length) {
      const openLine = stack.pop()!;
      blocks.push({ start: openLine.start, end: line.end });
    }
  }

  return blocks
    .filter((block) => block.start <= normalized.start && block.end >= normalized.end)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] || null;
}

function unwrapMarkdownAlignBlocks(value: string) {
  const lines = splitEditorLines(value);
  const openStack: number[] = [];
  const remove = new Set<number>();

  lines.forEach((line, index) => {
    if (ALIGN_OPEN_LINE_RE.test(line.text)) {
      openStack.push(index);
      return;
    }
    if (ALIGN_CLOSE_LINE_RE.test(line.text) && openStack.length) {
      remove.add(openStack.pop()!);
      remove.add(index);
    }
  });

  if (!remove.size) return value;

  return lines
    .filter((_, index) => !remove.has(index))
    .map((line) => `${line.text}${line.breakText}`)
    .join("")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

type MarkdownBlockStyle =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "blockquote"
  | "bulleted-list"
  | "numbered-list"
  | "task-list";

function stripMarkdownBlockMarker(value: string) {
  const indentMatch = /^(\s*)(.*)$/.exec(value);
  const indent = indentMatch?.[1] || "";
  let body = indentMatch?.[2] || "";
  body = body
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+\[[ xX]\]\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "");
  return { indent, body };
}

function applyMarkdownBlockStyle(content: string, range: EditorRange, style: MarkdownBlockStyle) {
  const line = lineRange(content, range);
  let orderedNumber = 1;
  const nextText = line.text.split(/\r?\n/).map((value) => {
    const { indent, body } = stripMarkdownBlockMarker(value);
    if (style === "paragraph") return body ? `${indent}${body}` : "";
    if (style === "heading1") return `${indent}# ${body}`;
    if (style === "heading2") return `${indent}## ${body}`;
    if (style === "heading3") return `${indent}### ${body}`;
    if (style === "heading4") return `${indent}#### ${body}`;
    if (style === "heading5") return `${indent}##### ${body}`;
    if (style === "heading6") return `${indent}###### ${body}`;
    if (style === "blockquote") return `${indent}> ${body}`;
    if (style === "bulleted-list") return `${indent}- ${body}`;
    if (style === "task-list") return `${indent}- [ ] ${body}`;
    const prefix = `${orderedNumber}. `;
    orderedNumber += 1;
    return `${indent}${prefix}${body}`;
  }).join("\n");
  return replaceEditorContent(content, nextText, { start: line.start, end: line.end });
}

function applyMarkdownAlignment(content: string, range: EditorRange, alignment: "left" | "center" | "right") {
  const selected = selectedText(content, range);
  const baseRange = selected ? normalizeEditorRange(content, range) : lineRange(content, range);
  const targetRange = findContainingAlignBlockRange(content, baseRange) || baseRange;
  const targetText = unwrapMarkdownAlignBlocks(content.slice(targetRange.start, targetRange.end));
  const prefix = `<div align="${alignment}">\n`;
  const suffix = "\n</div>";
  return replaceEditorContentWithSelection(content, `${prefix}${targetText}${suffix}`, targetRange, {
    start: prefix.length,
    end: prefix.length + targetText.length,
  });
}

function isIsolatedInlineMarker(value: string, start: number, marker: string) {
  if (!marker) return false;
  if (value.slice(start, start + marker.length) !== marker) return false;
  const repeatedChar = marker.length === 1 ? marker : "";
  if (!repeatedChar) return true;
  return value[start - 1] !== repeatedChar && value[start + marker.length] !== repeatedChar;
}

function countRepeatedBefore(value: string, index: number, char: string) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === char; cursor -= 1) count += 1;
  return count;
}

function countRepeatedAfter(value: string, index: number, char: string) {
  let count = 0;
  for (let cursor = index; cursor < value.length && value[cursor] === char; cursor += 1) count += 1;
  return count;
}

function toggleAsteriskMark(content: string, range: EditorRange, markerLength: 1 | 2, fallback: string) {
  const selected = selectedText(content, range);
  const marker = markerLength === 1 ? "*" : "**";

  if (!selected) {
    const inserted = `${marker}${fallback}${marker}`;
    const nextContent = `${content.slice(0, range.start)}${inserted}${content.slice(range.end)}`;
    const innerStart = range.start + marker.length;
    return {
      content: nextContent,
      selection: { start: innerStart, end: innerStart + fallback.length },
      changed: nextContent !== content,
    };
  }

  const selectedPrefixRun = countRepeatedAfter(selected, 0, "*");
  const selectedSuffixRun = countRepeatedBefore(selected, selected.length, "*");
  const selectedHasMark = markerLength === 1
    ? selectedPrefixRun % 2 === 1 && selectedSuffixRun % 2 === 1
    : selectedPrefixRun >= 2 && selectedSuffixRun >= 2;
  if (selectedHasMark && selected.length >= markerLength * 2) {
    const inner = selected.slice(markerLength, selected.length - markerLength);
    const nextContent = `${content.slice(0, range.start)}${inner}${content.slice(range.end)}`;
    return {
      content: nextContent,
      selection: { start: range.start, end: range.start + inner.length },
      changed: nextContent !== content,
    };
  }

  const beforeRun = countRepeatedBefore(content, range.start, "*");
  const afterRun = countRepeatedAfter(content, range.end, "*");
  const hasOuterMark = markerLength === 1
    ? beforeRun % 2 === 1 && afterRun % 2 === 1
    : beforeRun >= 2 && afterRun >= 2;
  if (hasOuterMark) {
    const outerPrefixStart = range.start - markerLength;
    const nextContent = `${content.slice(0, outerPrefixStart)}${selected}${content.slice(range.end + markerLength)}`;
    return {
      content: nextContent,
      selection: { start: outerPrefixStart, end: outerPrefixStart + selected.length },
      changed: nextContent !== content,
    };
  }

  const wrapped = `${marker}${selected}${marker}`;
  const nextContent = `${content.slice(0, range.start)}${wrapped}${content.slice(range.end)}`;
  return {
    content: nextContent,
    selection: { start: range.start + marker.length, end: range.start + marker.length + selected.length },
    changed: nextContent !== content,
  };
}

function toggleInlineMark(content: string, range: EditorRange, prefix: string, suffix = prefix, fallback = "文本") {
  if (prefix === suffix && (prefix === "*" || prefix === "**")) {
    return toggleAsteriskMark(content, range, prefix.length as 1 | 2, fallback);
  }

  const selected = selectedText(content, range);
  if (!selected) {
    const inserted = `${prefix}${fallback}${suffix}`;
    const nextContent = `${content.slice(0, range.start)}${inserted}${content.slice(range.end)}`;
    const innerStart = range.start + prefix.length;
    return {
      content: nextContent,
      selection: { start: innerStart, end: innerStart + fallback.length },
      changed: nextContent !== content,
    };
  }

  const selectedHasOwnPrefix = isIsolatedInlineMarker(selected, 0, prefix);
  const selectedSuffixStart = selected.length - suffix.length;
  const selectedHasOwnSuffix = selectedSuffixStart >= prefix.length && isIsolatedInlineMarker(selected, selectedSuffixStart, suffix);
  if (selectedHasOwnPrefix && selectedHasOwnSuffix) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    const nextContent = `${content.slice(0, range.start)}${inner}${content.slice(range.end)}`;
    return {
      content: nextContent,
      selection: { start: range.start, end: range.start + inner.length },
      changed: nextContent !== content,
    };
  }

  const outerPrefixStart = range.start - prefix.length;
  const hasOuterPrefix = outerPrefixStart >= 0 && isIsolatedInlineMarker(content, outerPrefixStart, prefix);
  const hasOuterSuffix = isIsolatedInlineMarker(content, range.end, suffix);
  if (hasOuterPrefix && hasOuterSuffix) {
    const nextContent = `${content.slice(0, outerPrefixStart)}${selected}${content.slice(range.end + suffix.length)}`;
    return {
      content: nextContent,
      selection: { start: outerPrefixStart, end: range.end - prefix.length },
      changed: nextContent !== content,
    };
  }

  const wrapped = `${prefix}${selected}${suffix}`;
  const nextContent = `${content.slice(0, range.start)}${wrapped}${content.slice(range.end)}`;
  return {
    content: nextContent,
    selection: { start: range.start + prefix.length, end: range.start + prefix.length + selected.length },
    changed: nextContent !== content,
  };
}

async function writeClipboard(clipboard: EditorCommandInput["clipboard"], text: string) {
  if (!clipboard?.writeText) throw new Error("当前环境不支持剪贴板写入");
  await clipboard.writeText(text);
}

async function readClipboard(clipboard: EditorCommandInput["clipboard"]) {
  if (!clipboard?.readText) throw new Error("当前环境不支持剪贴板读取");
  return clipboard.readText();
}

export async function applyEditorCommand(command: EditorCommand, input: EditorCommandInput): Promise<EditorCommandResult> {
  const content = input.content;
  const range = normalizeEditorRange(content, { start: input.selectionStart, end: input.selectionEnd });
  const selected = selectedText(content, range);
  const selectedOr = (fallback: string) => selected || fallback;

  switch (command) {
    case "link":
    case "wiki-link":
      return replaceEditorContent(content, `[[${selectedOr("笔记标题")}]]`, range);
    case "external-link":
      return replaceEditorContent(content, `[${selectedOr("链接标题")}](https://)`, range);
    case "bold":
      return toggleInlineMark(content, range, "**", "**");
    case "italic":
      return toggleInlineMark(content, range, "*", "*");
    case "strikethrough":
      return toggleInlineMark(content, range, "~~", "~~");
    case "code":
      return toggleInlineMark(content, range, "`", "`", "code");
    case "heading1":
      return applyMarkdownBlockStyle(content, range, "heading1");
    case "heading2":
      return applyMarkdownBlockStyle(content, range, "heading2");
    case "heading3":
      return applyMarkdownBlockStyle(content, range, "heading3");
    case "heading4":
    case "heading5":
    case "heading6":
      return applyMarkdownBlockStyle(content, range, command);
    case "paragraph":
      return applyMarkdownBlockStyle(content, range, "paragraph");
    case "blockquote":
      return applyMarkdownBlockStyle(content, range, "blockquote");
    case "bulleted-list":
      return applyMarkdownBlockStyle(content, range, "bulleted-list");
    case "numbered-list":
      return applyMarkdownBlockStyle(content, range, "numbered-list");
    case "task-list":
      return applyMarkdownBlockStyle(content, range, "task-list");
    case "align-left":
      return applyMarkdownAlignment(content, range, "left");
    case "align-center":
      return applyMarkdownAlignment(content, range, "center");
    case "align-right":
      return applyMarkdownAlignment(content, range, "right");
    case "horizontal-rule":
      return replaceEditorContent(content, "\n\n---\n\n", { start: range.end, end: range.end });
    case "table": {
      const snippet = "\n\n|  |  |\n| --- | --- |\n|  |  |\n\n";
      const cursor = snippet.indexOf("|  |") + 2;
      return replaceEditorContentWithSelection(content, snippet, { start: range.end, end: range.end }, {
        start: cursor,
        end: cursor,
      });
    }
    case "callout": {
      const bodyText = selectedOr("提示内容");
      const snippet = `\n\n> [!note] 提示\n> ${bodyText}\n\n`;
      const bodyStart = snippet.indexOf(bodyText);
      return replaceEditorContentWithSelection(content, snippet, range, {
        start: bodyStart,
        end: bodyStart + bodyText.length,
      });
    }
    case "code-block": {
      const codeText = selectedOr("// code block");
      const snippet = `\n\n\`\`\`\n${codeText}\n\`\`\`\n\n`;
      const codeStart = snippet.indexOf(codeText);
      return replaceEditorContentWithSelection(content, snippet, range, {
        start: codeStart,
        end: codeStart + codeText.length,
      });
    }
    case "insert-asset":
      return replaceEditorContent(content, `![[${selectedOr("素材名称")}]]`, range);
    case "cut":
      if (!selected) return { content, selection: range, changed: false };
      await writeClipboard(input.clipboard, selected);
      return replaceEditorContent(content, "", range);
    case "copy":
      await writeClipboard(input.clipboard, selected || content);
      return { content, selection: range, changed: false, status: "已复制" };
    case "paste":
    case "paste-text": {
      const text = await readClipboard(input.clipboard);
      return text ? replaceEditorContent(content, text, range) : { content, selection: range, changed: false };
    }
    case "select-all":
      return { content, selection: { start: 0, end: content.length }, changed: false };
  }
}
