import type { ReferenceEntry } from "./referencePlan";

export type ReferenceFocus = { label: string; x: number; y: number };

export type ReferenceMentionPart =
  | { type: "text"; text: string }
  | { type: "reference"; key: string; raw: string; focus?: ReferenceFocus };

/** Persist identity, never the mutable display number. Reserved syntax is canonical URI encoding. */
export function encodeReferenceMention(key: string): string {
  if (!key) throw new Error("Reference key must not be empty");
  return `[[lr-ref:${encodeURIComponent(key)}]]`;
}

/** Focus coordinates are normalized to the source image, including its edges. */
export function encodeFocusReferenceMention(key: string, focus: ReferenceFocus): string {
  if (typeof key !== "string" || !key || key.length > 2048 ||
      !focus || typeof focus.label !== "string" || !focus.label.trim() ||
      focus.label.length > 256 || /[\u0000-\u001f\u007f]/.test(focus.label) ||
      !Number.isFinite(focus.x) || !Number.isFinite(focus.y) ||
      focus.x < 0 || focus.x > 1 || focus.y < 0 || focus.y > 1)
    throw new ReferenceMentionError(typeof key === "string" ? key : "", "invalid");
  return `[[lr-focus:${encodeURIComponent(JSON.stringify({ key, label: focus.label, x: focus.x, y: focus.y }))}]]`;
}

export function parseReferenceMentions(value: string): ReferenceMentionPart[] {
  const parts: ReferenceMentionPart[] = [];
  const pattern = /\[\[lr-(ref|focus):([^\]\r\n]+)\]\]/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    let key: string;
    let focus: ReferenceFocus | undefined;
    try {
      if (match[1] === "focus") {
        // Bound decoding/JSON work for untrusted imported workflows.
        if (match[2].length > 24000) continue;
        const decoded = JSON.parse(decodeURIComponent(match[2]));
        if (!decoded || typeof decoded !== "object") continue;
        key = decoded.key;
        focus = { label: decoded.label, x: decoded.x, y: decoded.y };
        if (encodeFocusReferenceMention(key, focus) !== match[0]) continue;
      } else {
        key = decodeURIComponent(match[2]);
        if (!key || encodeReferenceMention(key) !== match[0]) continue;
      }
    } catch {
      continue;
    }
    const start = match.index!;
    if (start > cursor)
      parts.push({ type: "text", text: value.slice(cursor, start) });
    parts.push({ type: "reference", key, raw: match[0], ...(focus ? { focus } : {}) });
    cursor = start + match[0].length;
  }
  if (cursor < value.length)
    parts.push({ type: "text", text: value.slice(cursor) });
  return parts;
}

export function referenceMentionLabels(
  entries: readonly ReferenceEntry[],
): Map<string, string> {
  const counts = new Map<string, number>();
  return new Map(
    entries.map((entry) => {
      const kind = entry.reference.kind;
      const prefix =
        kind === "image" ? "图" : kind === "video" ? "视频" : "文本";
      const count = (counts.get(prefix) || 0) + 1;
      counts.set(prefix, count);
      return [entry.key, `@${prefix}${count}`];
    }),
  );
}

export class ReferenceMentionError extends Error {
  readonly code = "invalid-reference-mention";
  readonly key: string;
  readonly reason: "missing" | "invalid" | "ambiguous";
  constructor(key: string, reason: "missing" | "invalid" | "ambiguous") {
    super(
      reason === "missing"
        ? "提示词中的引用已被移除，请删除或重新插入该引用"
        : "提示词中的引用不可用，请检查引用素材",
    );
    this.name = "ReferenceMentionError";
    this.key = key;
    this.reason = reason;
  }
}

/** Resolve BEFORE freezing the request: entry carries the exact role and source, even for repeated source IDs. */
export function resolveReferenceMentions(
  value: string,
  entries: readonly ReferenceEntry[],
) {
  const labels = referenceMentionLabels(entries);
  const mentions: { key: string; label: string; entry: ReferenceEntry; focus?: ReferenceFocus }[] = [];
  const prompt = parseReferenceMentions(value)
    .map((part) => {
      if (part.type === "text") {
        // A malformed focus token must never silently become a provider instruction.
        if (part.text.includes("[[lr-focus:")) throw new ReferenceMentionError("", "invalid");
        return part.text;
      }
      const matches = entries.filter((entry) => entry.key === part.key);
      if (matches.length !== 1)
        throw new ReferenceMentionError(
          part.key,
          matches.length ? "ambiguous" : "missing",
        );
      const entry = matches[0];
      if (entry.issue || (part.focus && (entry.reference.kind !== "image" ||
          entry.usage === "label-only" || !entry.reference.mediaUrl?.trim())))
        throw new ReferenceMentionError(part.key, "invalid");
      const label = labels.get(part.key)!;
      mentions.push({ key: part.key, label, entry, ...(part.focus ? { focus: part.focus } : {}) });
      return part.focus
        ? `${label}中的对象${JSON.stringify(part.focus.label)}（归一化位置 x=${part.focus.x}, y=${part.focus.y}；左上角为(0,0)，右下角为(1,1)）`
        : label;
    })
    .join("");
  return { prompt, mentions };
}

/** Provider-facing identity legend. Call once, before ordinary context compilation. */
export function compileMentionedPrompt(
  value: string,
  entries: readonly ReferenceEntry[],
  options: {
    includeNoteTitles?: boolean;
    kind?: "text" | "image" | "video";
  } = {},
) {
  const resolved = resolveReferenceMentions(value, entries);
  if (options.kind === "text") {
    const focus = resolved.mentions.find((mention) => mention.focus);
    if (focus) throw new ReferenceMentionError(focus.key, "invalid");
  }
  const valid = entries.filter((entry) => !entry.issue);
  const references = valid.map(({ reference: r, role, sourceNodeId }) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    role,
    sourceNodeId,
    thumbnailUrl: r.thumbnailUrl,
    mediaUrl: r.mediaUrl,
    text: r.text,
  }));
  const mentionedKeys = new Set(
    resolved.mentions.map((mention) => mention.key),
  );
  const labels = referenceMentionLabels(entries);
  const referenceAliases = valid.map((entry) =>
    mentionedKeys.has(entry.key) ? labels.get(entry.key)! : "",
  );
  if (!resolved.mentions.length)
    return { ...resolved, references, referenceAliases };
  const images = valid.filter((entry) => entry.reference.kind === "image");
  const videos = valid.filter((entry) => entry.reference.kind === "video");
  const seen = new Set<string>();
  const legend = resolved.mentions.flatMap(({ key, label, entry }) => {
    if (seen.has(key)) return [];
    seen.add(key);
    const kind = entry.reference.kind;
    if (kind === "image" || kind === "video") {
      if (options.kind === "text" || entry.usage === "label-only")
        return [`${label}：仅作为素材标记，本次未传入媒体内容。`];
      const ordinal =
        (kind === "image" ? images : videos).findIndex(
          (candidate) => candidate.key === key,
        ) + 1;
      const role = entry.effectiveRole || entry.role;
      const frame =
        role === "firstFrame"
          ? "（首帧）"
          : role === "lastFrame"
            ? "（尾帧）"
            : "";
      return [
        `${label}：本次输入的第${ordinal}${kind === "image" ? "张图片" : "段视频"}${frame}。`,
      ];
    }
    return [];
  });
  return {
    ...resolved,
    prompt: legend.length
      ? `${resolved.prompt}\n\n提示词引用对应：\n${legend.join("\n\n")}`
      : resolved.prompt,
    references,
    referenceAliases,
  };
}

/** UI validation can show an actionable error without throwing during rendering. */
export function validateReferenceMentions(
  value: string,
  entries: readonly ReferenceEntry[],
): ReferenceMentionError | null {
  try {
    resolveReferenceMentions(value, entries);
    return null;
  } catch (error) {
    if (error instanceof ReferenceMentionError) return error;
    throw error;
  }
}

/** Copy only explicitly mapped identities; unmapped mentions remain invalid rather than aliasing another source. */
export function remapReferenceMentions(
  value: string,
  keys: ReadonlyMap<string, string>,
): string {
  return parseReferenceMentions(value)
    .map((part) => {
      if (part.type === "text") return part.text;
      const replacement = keys.get(part.key);
      return replacement === undefined
        ? part.raw
        : part.focus
          ? encodeFocusReferenceMention(replacement, part.focus)
          : encodeReferenceMention(replacement);
    })
    .join("");
}
