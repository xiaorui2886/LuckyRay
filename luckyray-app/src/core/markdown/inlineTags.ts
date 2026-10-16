const INLINE_TAG_BOUNDARY_BEFORE = /(^|[\s([{（【《「『])/;
const INLINE_TAG_BOUNDARY_AFTER = /($|[\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』])/;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceInlineTagsInPlainText(value: string, oldName: string, newName: string) {
  if (!value) return value;
  const pattern = new RegExp(`(^|[\\s([{（【《「『])#${escapeRegExp(oldName)}(?=$|[\\s#\\[\\](){},.;:!?，。、；：！？（）【】《》「」『』])`, "g");
  return value.replace(pattern, (_match, prefix: string) => `${prefix}#${newName}`);
}

function removeInlineTagsInPlainText(value: string, name: string) {
  if (!value) return value;
  const pattern = new RegExp(`(^|[\\s([{（【《「『])#${escapeRegExp(name)}(?=$|[\\s#\\[\\](){},.;:!?，。、；：！？（）【】《》「」『』])`, "g");
  return value
    .replace(pattern, (_match, prefix: string) => prefix)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?，。、；：！？（）【】《》「」『』])/g, "$1");
}

function collectInlineTagsInPlainText(value: string, output: Set<string>) {
  if (!value) return;
  const pattern = /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const name = (match[2] || "").trim().replace(/^#/, "");
    if (name) output.add(name);
  }
}

function transformOutsideInlineCode(line: string, transform: (value: string) => string) {
  let result = "";
  let cursor = 0;
  const codePattern = /`+[^`]*`+/g;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(line)) !== null) {
    result += transform(line.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }

  result += transform(line.slice(cursor));
  return result;
}

function collectInlineTagsOutsideInlineCode(line: string, output: Set<string>) {
  transformOutsideInlineCode(line, (value) => {
    collectInlineTagsInPlainText(value, output);
    return value;
  });
}

function replaceInlineTagReferences(contentText: string, oldName: string, newName: string) {
  const lines = contentText.split("\n");
  let fenceMarker: string | null = null;

  return lines.map((line) => {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence[1];
      } else if (fenceMarker === fence[1]) {
        fenceMarker = null;
      }
      return line;
    }
    if (fenceMarker) return line;
    return transformOutsideInlineCode(line, (value) => replaceInlineTagsInPlainText(value, oldName, newName));
  }).join("\n");
}

function removeInlineTagReferences(contentText: string, name: string) {
  const lines = contentText.split("\n");
  let fenceMarker: string | null = null;

  return lines.map((line) => {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence[1];
      } else if (fenceMarker === fence[1]) {
        fenceMarker = null;
      }
      return line;
    }
    if (fenceMarker) return line;
    return transformOutsideInlineCode(line, (value) => removeInlineTagsInPlainText(value, name));
  }).join("\n");
}

function replaceFrontmatterTagValue(rawValue: string, oldName: string, newName: string) {
  if (!rawValue.trim()) return rawValue;
  const pattern = new RegExp(`(^|[\\s,\\[\"'])#?${escapeRegExp(oldName)}(?=$|[\\s,\\]\"'])`, "g");
  return rawValue.replace(pattern, (match, prefix: string) => {
    const hasHash = match.slice(prefix.length).startsWith("#");
    return `${prefix}${hasHash ? "#" : ""}${newName}`;
  });
}

function removeFrontmatterTagValue(rawValue: string, name: string) {
  if (!rawValue.trim()) return rawValue;
  const pattern = new RegExp(`(^|[\\s,\\[\"'])#?${escapeRegExp(name)}(?=$|[\\s,\\]\"'])`, "g");
  return rawValue
    .replace(pattern, (_match, prefix: string) => prefix)
    .replace(/\[\s*,\s*/g, "[")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\]/g, "]")
    .replace(/\[\s*\]/g, "[]")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*,\s*/, "")
    .replace(/\s*,\s*$/, "");
}

function replaceFrontmatterTagReferences(contentText: string, oldName: string, newName: string) {
  const normalized = contentText.replace(/^\uFEFF/, "");
  const firstBreak = normalized.indexOf("\n");
  if (!normalized.startsWith("---") || firstBreak < 0 || normalized.slice(0, firstBreak).trim() !== "---") {
    return contentText;
  }

  const closingMatch = /\n---\s*(?:\r?\n|$)/.exec(normalized.slice(firstBreak));
  if (!closingMatch) return contentText;

  const frontmatterStart = firstBreak + 1;
  const frontmatterEnd = firstBreak + closingMatch.index;
  const bodyStart = firstBreak + closingMatch.index + closingMatch[0].length;
  const yaml = normalized.slice(frontmatterStart, frontmatterEnd);
  const lines = yaml.split("\n");
  let inTagsList = false;

  const nextLines = lines.map((line) => {
    const keyMatch = /^(\s*)([A-Za-z0-9_-]+):(\s*)(.*)$/.exec(line);
    if (keyMatch) {
      const [, indent, key, gap, value] = keyMatch;
      const isTagKey = key.toLocaleLowerCase() === "tag" || key.toLocaleLowerCase() === "tags";
      inTagsList = isTagKey && !value.trim();
      if (!isTagKey) return line;
      return `${indent}${key}:${gap}${replaceFrontmatterTagValue(value, oldName, newName)}`;
    }

    if (inTagsList) {
      const listMatch = /^(\s*-\s+)(.*)$/.exec(line);
      if (listMatch) {
        return `${listMatch[1]}${replaceFrontmatterTagValue(listMatch[2], oldName, newName)}`;
      }
      if (line.trim()) inTagsList = false;
    }

    return line;
  });

  return `${normalized.slice(0, frontmatterStart)}${nextLines.join("\n")}${normalized.slice(frontmatterEnd, bodyStart)}${normalized.slice(bodyStart)}`;
}

function removeFrontmatterTagReferences(contentText: string, name: string) {
  const normalized = contentText.replace(/^\uFEFF/, "");
  const firstBreak = normalized.indexOf("\n");
  if (!normalized.startsWith("---") || firstBreak < 0 || normalized.slice(0, firstBreak).trim() !== "---") {
    return contentText;
  }

  const closingMatch = /\n---\s*(?:\r?\n|$)/.exec(normalized.slice(firstBreak));
  if (!closingMatch) return contentText;

  const frontmatterStart = firstBreak + 1;
  const frontmatterEnd = firstBreak + closingMatch.index;
  const bodyStart = firstBreak + closingMatch.index + closingMatch[0].length;
  const yaml = normalized.slice(frontmatterStart, frontmatterEnd);
  const lines = yaml.split("\n");
  let inTagsList = false;
  const nextLines: string[] = [];

  for (const line of lines) {
    const keyMatch = /^(\s*)([A-Za-z0-9_-]+):(\s*)(.*)$/.exec(line);
    if (keyMatch) {
      const [, indent, key, gap, value] = keyMatch;
      const isTagKey = key.toLocaleLowerCase() === "tag" || key.toLocaleLowerCase() === "tags";
      inTagsList = isTagKey && !value.trim();
      if (!isTagKey) {
        nextLines.push(line);
        continue;
      }
      nextLines.push(`${indent}${key}:${gap}${removeFrontmatterTagValue(value, name)}`);
      continue;
    }

    if (inTagsList) {
      const listMatch = /^(\s*-\s+)(.*)$/.exec(line);
      if (listMatch) {
        const nextValue = removeFrontmatterTagValue(listMatch[2], name);
        if (nextValue.trim()) nextLines.push(`${listMatch[1]}${nextValue}`);
        continue;
      }
      if (line.trim()) inTagsList = false;
    }

    nextLines.push(line);
  }

  return `${normalized.slice(0, frontmatterStart)}${nextLines.join("\n")}${normalized.slice(frontmatterEnd, bodyStart)}${normalized.slice(bodyStart)}`;
}

export function replaceMarkdownTagReferencesInText(contentText: string, oldName: string, newName: string) {
  const from = oldName.trim().replace(/^#/, "");
  const to = newName.trim().replace(/^#/, "");
  if (!contentText || !from || !to || from === to) return contentText;

  const withFrontmatter = replaceFrontmatterTagReferences(contentText, from, to);
  return replaceInlineTagReferences(withFrontmatter, from, to);
}

export function removeMarkdownTagReferencesInText(contentText: string, name: string) {
  const normalizedName = name.trim().replace(/^#/, "");
  if (!contentText || !normalizedName) return contentText;

  const withoutFrontmatter = removeFrontmatterTagReferences(contentText, normalizedName);
  return removeInlineTagReferences(withoutFrontmatter, normalizedName);
}

export function hasMarkdownTagReferencesInText(contentText: string, name: string) {
  const normalizedName = name.trim().replace(/^#/, "");
  if (!contentText || !normalizedName) return false;
  return removeMarkdownTagReferencesInText(contentText, normalizedName) !== contentText;
}

export function extractInlineMarkdownTagNamesInText(contentText: string) {
  if (!contentText) return [];
  const tags = new Set<string>();
  const lines = contentText.replace(/^\uFEFF/, "").split("\n");
  const frontmatterCloseIndex =
    lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  let fenceMarker: string | null = null;

  lines.forEach((line, index) => {
    if (frontmatterCloseIndex > 0 && index <= frontmatterCloseIndex) return;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence[1];
      } else if (fenceMarker === fence[1]) {
        fenceMarker = null;
      }
      return;
    }
    if (fenceMarker) return;
    collectInlineTagsOutsideInlineCode(line, tags);
  });

  return Array.from(tags);
}

export function looksLikeInlineTagBoundaryBefore(value: string) {
  return INLINE_TAG_BOUNDARY_BEFORE.test(value);
}

export function looksLikeInlineTagBoundaryAfter(value: string) {
  return INLINE_TAG_BOUNDARY_AFTER.test(value);
}
