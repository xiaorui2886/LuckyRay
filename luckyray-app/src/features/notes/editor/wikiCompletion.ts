import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import { isInsideInlineCodeAt, isPlainMarkdownProseAt } from "../../../core/markdown/proseRanges";
import { assetKindLabel } from "./noteAssetResolver";
import { getWikiAnchorCompletions, parseWikiAnchorQuery } from "./sameNoteAnchors";
import type { LiveAsset, LiveNote, LiveTag } from "./types";

export type WikiCompletionOptions = {
  notes: LiveNote[];
  assets: LiveAsset[];
  tags: LiveTag[];
};

type LiveAssetCompletion = Completion & {
  liveAsset?: LiveAsset;
};

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

function score(label: string, query: string) {
  const text = normalize(label);
  const q = normalize(query);
  if (!q) return 20;
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  const index = text.indexOf(q);
  return index >= 0 ? 10 + index : 1000;
}

function sortByQuery<T extends { label: string }>(items: T[], query: string) {
  return items
    .map((item) => ({ item, score: score(item.label, query) }))
    .filter((entry) => entry.score < 1000)
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label, "zh-CN"))
    .slice(0, 20)
    .map((entry) => entry.item);
}

function noteTitle(note: LiveNote) {
  return note.title?.trim() || "未命名笔记";
}

export function isPlainMarkdownCompletionAllowedAt(text: string, cursor: number) {
  return isPlainMarkdownProseAt(text, cursor);
}

export function isMarkdownCompletionAllowedAt(state: EditorState, pos: number) {
  const safePos = Math.max(0, Math.min(pos, state.doc.length));
  const currentLine = state.doc.lineAt(safePos);

  if (state.doc.line(1).text.replace(/^\uFEFF/, "").trim() === "---") {
    for (let lineNo = 2; lineNo <= state.doc.lines; lineNo += 1) {
      if (state.doc.line(lineNo).text.trim() === "---") {
        if (currentLine.number <= lineNo) return false;
        break;
      }
    }
  }

  let fenceMarker: string | null = null;
  for (let lineNo = 1; lineNo <= currentLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const fence = /^\s*(```|~~~)/.exec(line.text);
    if (fence) {
      if (lineNo === currentLine.number) return false;
      if (!fenceMarker) {
        fenceMarker = fence[1];
      } else if (fenceMarker === fence[1]) {
        fenceMarker = null;
      }
      continue;
    }
    if (lineNo === currentLine.number) break;
  }

  if (fenceMarker) return false;
  return !isInsideInlineCodeAt(currentLine.text, safePos - currentLine.from);
}

function filterAnchorCompletions(state: EditorState, notes: LiveNote[], query: string) {
  const parsed = parseWikiAnchorQuery(query);
  if (!parsed) return [];
  if (!parsed.noteTitle) return getWikiAnchorCompletions(state.doc.toString(), query);
  const targetTitle = parsed.noteTitle;
  const target = notes.find((note) => normalize(noteTitle(note)) === normalize(targetTitle));
  if (!target) return [];
  return getWikiAnchorCompletions(target.contentText || "", query);
}

function assetPathHint(asset: LiveAsset) {
  const normalized = (asset.libraryPath || asset.originalPath || "").replace(/\\/g, "/").trim();
  if (!normalized) return "素材库";
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "素材库";
}

export function renderLiveCompletionLeading(completion: Completion) {
  const asset = (completion as LiveAssetCompletion).liveAsset;
  if (!asset) return null;

  const thumb = document.createElement("span");
  thumb.className = "lr-live-completion-thumb";
  const isVideo = (asset.kind || "").toLocaleLowerCase() === "video";
  const mediaUrl = asset.thumbnailUrl || asset.previewUrl || "";
  if (mediaUrl && isVideo) {
    const video = document.createElement("video");
    video.src = asset.previewUrl || mediaUrl;
    if (asset.thumbnailUrl) video.poster = asset.thumbnailUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    thumb.appendChild(video);
  } else if (mediaUrl) {
    const image = document.createElement("img");
    image.src = mediaUrl;
    image.alt = asset.name;
    thumb.appendChild(image);
  } else {
    thumb.textContent = assetKindLabel(asset.kind);
  }
  return thumb;
}

function tokenContext(context: CompletionContext) {
  const pos = context.pos;
  if (!isMarkdownCompletionAllowedAt(context.state, pos)) return null;
  const start = Math.max(0, pos - 160);
  const before = context.state.sliceDoc(start, pos);

  const assetStart = before.lastIndexOf("![[");
  const noteStart = before.lastIndexOf("[[");
  if (assetStart >= 0 && noteStart === assetStart + 1) {
    const query = before.slice(assetStart + 3);
    if (!query.includes("]]") && !/[\r\n]/.test(query)) {
      return { kind: "asset" as const, from: start + assetStart + 3, query };
    }
  }

  if (noteStart >= 0) {
    const query = before.slice(noteStart + 2);
    if (!query.includes("]]") && !/[\r\n]/.test(query) && before[noteStart - 1] !== "!") {
      return { kind: "note" as const, from: start + noteStart + 2, query };
    }
  }

  const tagMatch = /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]*)$/.exec(before);
  if (tagMatch) {
    return {
      kind: "tag" as const,
      from: pos - (tagMatch[2] || "").length,
      query: tagMatch[2] || "",
    };
  }
  return null;
}

export function createWikiCompletionSource(options: WikiCompletionOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    const token = tokenContext(context);
    if (!token) return null;

    if (token.kind === "asset") {
      const items = sortByQuery(options.assets.map((asset) => ({ asset, label: asset.name })), token.query);
      return {
        from: token.from,
        options: items.map(({ asset }) => ({
          label: asset.name,
          detail: `${assetKindLabel(asset.kind)} · ${assetPathHint(asset)}`,
          type: "file",
          apply: `${asset.name}]]`,
          liveAsset: asset,
        })),
        validFor: /^[^\]\n]*$/,
      };
    }

    if (token.kind === "note") {
      const anchorQuery = parseWikiAnchorQuery(token.query);
      if (anchorQuery) {
        const anchors = filterAnchorCompletions(context.state, options.notes, token.query);
        return {
          from: token.from,
          filter: false,
          options: anchors.map((anchor) => ({
            label: anchor.label,
            detail: `${anchorQuery.noteTitle ? `${anchorQuery.noteTitle} · ` : ""}${anchor.detail} · 第 ${anchor.line} 行`,
            type: anchor.kind === "heading" ? "namespace" : "constant",
            apply: `${anchor.insertText}]]`,
          })),
          validFor: /^[^\]\n]*$/,
        };
      }

      const query = token.query.split(/[|#^]/)[0];
      const suffix = token.query.slice(query.length);
      const items = sortByQuery(options.notes.map((note) => ({ note, label: note.title || "未命名笔记" })), query);
      return {
        from: token.from,
        options: items.map(({ note }) => ({
          label: noteTitle(note),
          detail: note.folderPath || "知识库/",
          type: "text",
          apply: `${noteTitle(note)}${suffix}]]`,
        })),
        validFor: /^[^\]\n]*$/,
      };
    }

    const items = sortByQuery(options.tags.map((tag) => ({ tag, label: tag.name })), token.query);
    return {
      from: token.from,
      options: items.map(({ tag }) => ({
        label: tag.name,
        detail: `${tag.noteCount ?? 0} 笔记`,
        type: "keyword",
        apply: tag.name,
      })),
      validFor: /^[^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]*$/,
    };
  };
}
