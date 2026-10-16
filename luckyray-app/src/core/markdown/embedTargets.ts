const INVISIBLE_EMBED_CHARS = /[\uFEFF\u200B-\u200D\u2060]/g;
const EMBED_SPACE_CHARS = /[\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/g;
const MARKDOWN_ESCAPED_TARGET_CHAR = /\\([\\`*_[\]{}()#+\-.!|>~])/g;

export function normalizeMarkdownEmbedTarget(value: string | null | undefined) {
  let normalized = (value || "")
    .replace(INVISIBLE_EMBED_CHARS, "")
    .replace(EMBED_SPACE_CHARS, " ")
    .trim();

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original target when it is not URI-encoded.
  }

  return normalized
    .replace(INVISIBLE_EMBED_CHARS, "")
    .replace(EMBED_SPACE_CHARS, " ")
    .replace(MARKDOWN_ESCAPED_TARGET_CHAR, "$1")
    .trim()
    .normalize("NFC");
}

export function normalizeMarkdownEmbedLookup(value: string | null | undefined) {
  return normalizeMarkdownEmbedTarget(value).toLocaleLowerCase();
}

export function splitMarkdownEmbedTarget(raw: string) {
  const [targetPart, ...aliasParts] = raw.split("|");
  const target = normalizeMarkdownEmbedTarget(targetPart);
  const alias = normalizeMarkdownEmbedTarget(aliasParts.join("|"));
  return { target, alias };
}

