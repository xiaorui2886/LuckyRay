import { attachNoteImage } from "../media/attachNoteImage";
import { releaseImage } from "../media/noteImageResources";
export { warmRecentImage } from "../media/noteImageResources";
import { attachmentAccessMessage } from "../../../core/services/vaultAttachmentErrors";
import { attachVideoPreview } from "./videoPreview";
import { openImageViewer } from "../media/imageViewer";
import { expandMediaIcon, expandNoteVideo, resolveNoteMediaSources, setNoteMediaAspect } from "../media/noteMediaGeometry";
import { applyRememberedMediaGeometry, rememberDecodedMediaGeometry } from "../media/noteMediaReadyCache";
import "../media/noteMedia.css";
import { standardMarkdownReferences } from "../../../core/markdown/realVaultEmbeds";
import { readableAttachmentReference } from "./attachmentReferenceLabel";
import { WidgetType, type EditorView } from "@codemirror/view";
import { assetKindLabel, type ResolvedAssetEmbed } from "./noteAssetResolver";
import type { LiveEditorTokenContext, LiveNote, LiveNoteLink, LiveNoteOpenOptions, LiveTag } from "./types";

export type LiveFrontmatterProperty = {
  key: string;
  values: string[];
};

type ExternalLinkWidgetOptions = {
  label: string;
  href: string;
  from: number;
  to: number;
  selected: boolean;
  onTokenContextMenu?: (event: MouseEvent, token: LiveEditorTokenContext) => void;
};

type AssetWidgetOptions = {
  embed: ResolvedAssetEmbed;
  from: number;
  to: number;
  block: boolean;
  expanded: boolean;
  selected: boolean;
  sourceVisible?: boolean;
  onOpenAsset?: (assetId: string) => void;
  onTokenContextMenu?: (event: MouseEvent, token: LiveEditorTokenContext) => void;
};

function setWholeTokenSelection(view: EditorView, from: number, to: number) {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

function selectAssetToken(view: EditorView, from: number, to: number, extend: boolean) {
  const anchor = extend ? view.state.selection.main.anchor : from;
  const head = extend ? (anchor <= from ? to : from) : to;
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  view.focus();
}

export class FrontmatterPropertiesWidget extends WidgetType {
  constructor(private readonly options: { properties: LiveFrontmatterProperty[]; from: number; to: number }) {
    super();
  }

  eq(other: FrontmatterPropertiesWidget) {
    return (
      other.options.from === this.options.from
      && other.options.to === this.options.to
      && JSON.stringify(other.options.properties) === JSON.stringify(this.options.properties)
    );
  }

  toDOM(view: EditorView) {
    const { properties, from, to } = this.options;
    const root = document.createElement("section");
    root.className = "lr-live-properties";
    root.contentEditable = "false";
    root.title = "点击编辑 Properties 源码";

    const header = document.createElement("div");
    header.className = "lr-live-properties-header";
    const title = document.createElement("span");
    title.textContent = "Properties";
    const count = document.createElement("small");
    count.textContent = `${properties.length}`;
    const copy = document.createElement("button");
    copy.className = "lr-live-properties-copy";
    copy.type = "button";
    copy.textContent = "复制";
    copy.title = "复制 Properties Markdown";
    copy.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    copy.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(view.state.doc.sliceString(from, to));
        copy.textContent = "已复制";
        window.setTimeout(() => { copy.textContent = "复制"; }, 1100);
      } catch {
        copy.textContent = "失败";
        window.setTimeout(() => { copy.textContent = "复制"; }, 1400);
      }
    };
    header.append(title, count, copy);
    root.appendChild(header);

    const list = document.createElement("div");
    list.className = "lr-live-properties-list";
    const visibleProperties = properties.slice(0, 8);
    visibleProperties.forEach((property) => {
      const row = document.createElement("div");
      row.className = "lr-live-property-row";
      const key = document.createElement("span");
      key.className = "lr-live-property-key";
      key.textContent = property.key;
      const values = document.createElement("span");
      values.className = "lr-live-property-values";
      const visibleValues = property.values.length ? property.values : ["空"];
      visibleValues.slice(0, 4).forEach((value) => {
        const chip = document.createElement("em");
        chip.className = property.values.length ? "" : "empty";
        chip.textContent = value;
        chip.title = value;
        values.appendChild(chip);
      });
      if (visibleValues.length > 4) {
        const more = document.createElement("em");
        more.className = "more";
        more.textContent = `+${visibleValues.length - 4}`;
        more.title = visibleValues.slice(4).join("，");
        values.appendChild(more);
      }
      row.append(key, values);
      list.appendChild(row);
    });
    if (properties.length > visibleProperties.length) {
      const row = document.createElement("div");
      row.className = "lr-live-property-row";
      const key = document.createElement("span");
      key.className = "lr-live-property-key";
      key.textContent = "更多";
      const values = document.createElement("span");
      values.className = "lr-live-property-values";
      const more = document.createElement("em");
      more.className = "more";
      more.textContent = `+${properties.length - visibleProperties.length} 项`;
      more.title = properties.slice(visibleProperties.length).map((property) => property.key).join("，");
      values.appendChild(more);
      row.append(key, values);
      list.appendChild(row);
    }
    root.appendChild(list);

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setWholeTokenSelection(view, from, to);
    };

    return root;
  }

  ignoreEvent() {
    return false;
  }
}

export class ExternalLinkWidget extends WidgetType {
  constructor(private readonly options: ExternalLinkWidgetOptions) {
    super();
  }

  eq(other: ExternalLinkWidget) {
    return (
      other.options.label === this.options.label
      && other.options.href === this.options.href
      && other.options.from === this.options.from
      && other.options.to === this.options.to
      && other.options.selected === this.options.selected
    );
  }

  toDOM(view: EditorView) {
    const { label, href, from, to, selected, onTokenContextMenu } = this.options;
    const root = document.createElement("span");
    root.className = `lr-live-external-link${selected ? " selected" : ""}`;
    root.contentEditable = "false";
    root.textContent = label || href;
    root.title = "单击编辑链接源码，Ctrl/Command 点击打开";
    root.dataset.lrTokenKind = "external";
    root.dataset.lrTokenFrom = String(from);
    root.dataset.lrTokenTo = String(to);
    root.dataset.lrTokenLabel = label || href;
    root.dataset.lrTokenHref = href;
    root.dataset.lrTokenMissing = "0";

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      setWholeTokenSelection(view, from, to);
    };
    root.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWholeTokenSelection(view, from, to);
      onTokenContextMenu?.(event, {
        kind: "external",
        from,
        to,
        label: label || href,
        href,
        missing: false,
      });
    };

    return root;
  }

  ignoreEvent() {
    return false;
  }
}

function buildAssetEmbedSyntax(target: string, width: number | null) {
  return `![[${target}${width ? `|${width}` : ""}]]`;
}

function commitAssetWidth(view: EditorView, from: number, to: number, target: string, width: number) {
  const nextWidth = Math.round(Math.max(width, 1));
  const replacement = resizeAssetReference(view.state.doc.sliceString(from, to), target, nextWidth);
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: from, head: from + replacement.length },
    scrollIntoView: true,
  });
  view.focus();
}

function isVideoAsset(kind?: string) {
  return (kind || "").toLocaleLowerCase() === "video";
}

function isImageAsset(kind?: string) {
  return (kind || "").toLocaleLowerCase() === "image";
}

const assetWidgetCleanup = new WeakMap<HTMLElement, () => void>();
const assetWidgetPositions = new WeakMap<HTMLElement, { options: AssetWidgetOptions; move: (from: number, to: number) => void; refreshImage?: (embed: ResolvedAssetEmbed) => void }>();
export function resizeAssetReference(source: string, target: string, width: number) {
  const reference = standardMarkdownReferences(source)[0];
  if (reference?.embedded && reference.from === 0 && reference.to === source.length) {
    const label = reference.label.replace(/\|\d{1,4}(?:x\d{1,4})?$/, "");
    return `![${label}|${width}${source.slice(2 + reference.label.length)}`;
  }
  return buildAssetEmbedSyntax(target, width);
}

export class AssetEmbedWidget extends WidgetType {
  constructor(private readonly options: AssetWidgetOptions) {
    super();
  }

  eq(other: AssetEmbedWidget) {
    return (
      other.options.embed.asset?.id === this.options.embed.asset?.id
      && other.options.embed.asset?.name === this.options.embed.asset?.name
      && other.options.embed.target === this.options.embed.target
      && other.options.embed.display === this.options.embed.display
      && other.options.embed.resolutionStatus === this.options.embed.resolutionStatus
      && other.options.embed.width === this.options.embed.width
      && other.options.embed.height === this.options.embed.height
      && other.options.embed.asset?.thumbnailUrl === this.options.embed.asset?.thumbnailUrl
      && other.options.embed.asset?.previewUrl === this.options.embed.asset?.previewUrl
      && other.options.selected === this.options.selected
      && other.options.block === this.options.block
      && other.options.expanded === this.options.expanded
      && other.options.sourceVisible === this.options.sourceVisible
      && other.options.from === this.options.from
      && other.options.to === this.options.to
    );
  }

  get selectionRange() {
    return this.options.sourceVisible ? null : { from: this.options.from, to: this.options.to, asset: this.options.embed.asset, target: this.options.embed.target };
  }

  get sourceRange() {
    return { from: this.options.from, to: this.options.to, sourceVisible: Boolean(this.options.sourceVisible) };
  }

  coordsAt(root: HTMLElement, pos: number) {
    if (!root.classList.contains("note-media") || this.options.sourceVisible) return null;
    const rect = root.getBoundingClientRect();
    const height = parseFloat(getComputedStyle(root).fontSize) * 1.2;
    const after = pos > 0;
    if (!after && this.options.block && root.previousElementSibling?.classList.contains("cm-line")) {
      const walker = document.createTreeWalker(root.previousElementSibling, NodeFilter.SHOW_TEXT);
      let lastText: Node | null = null;
      while (walker.nextNode()) lastText = walker.currentNode;
      const range = document.createRange();
      if (lastText) { range.setStart(lastText, lastText.textContent?.length || 0); range.collapse(true); }
      else { range.selectNodeContents(root.previousElementSibling); range.collapse(false); }
      const textRect = range.getBoundingClientRect();
      if (textRect.height > 0 && textRect.height < height * 2) return textRect;
    }
    const left = after ? rect.right : rect.left;
    // A genuine attachment boundary is a full-height edge. The preceding
    // prose branch above stays text-height; typed trailing text uses its own
    // native text coordinates once the caret moves past this boundary.
    return { left, right: left, top: rect.top, bottom: rect.bottom };
  }

  updateDOM(root: HTMLElement) {
    const previous = assetWidgetPositions.get(root);
    if (!previous) return false;
    const compatible = { ...previous.options, from: this.options.from, to: this.options.to, selected: this.options.selected };
    if (previous.refreshImage && isImageAsset(this.options.embed.asset?.kind)) {
      compatible.embed = { ...compatible.embed, width: this.options.embed.width, asset: {
        ...compatible.embed.asset!, thumbnailUrl: this.options.embed.asset?.thumbnailUrl, previewUrl: this.options.embed.asset?.previewUrl,
      } };
    }
    if (!new AssetEmbedWidget(compatible).eq(this)) return false;
    previous.move(this.options.from, this.options.to);
    root.classList.toggle("selected", Boolean(this.options.selected));
    if (previous.refreshImage) {
      root.style.width = this.options.embed.width ? `${Math.max(1, this.options.embed.width)}px` : "";
      previous.refreshImage(this.options.embed);
    }
    previous.options = this.options;
    return true;
  }

  destroy(root: HTMLElement) {
    assetWidgetPositions.delete(root);
    const cleanup = assetWidgetCleanup.get(root);
    cleanup?.(); assetWidgetCleanup.delete(root);
    const image = root.querySelector("img");
    if (image) releaseImage(image);
    const video = root.querySelector("video");
    if (video && !cleanup) { video.pause(); video.removeAttribute("src"); video.load(); }
  }

  toDOM(view: EditorView) {
    const { embed, block, expanded, selected, sourceVisible, onOpenAsset, onTokenContextMenu } = this.options;
    let { from, to } = this.options;
    const asset = embed.asset;
    const media = Boolean(asset && (isImageAsset(asset.kind) || isVideoAsset(asset.kind)) && (block || expanded));
    const root = document.createElement(block ? "figure" : "span");
    assetWidgetPositions.set(root, { options: this.options, move: (start, end) => {
      from = start; to = end;
      root.dataset.lrTokenFrom = String(start); root.dataset.lrTokenTo = String(end);
    } });
    root.className = `lr-live-asset-card${block ? " block" : " inline"}${expanded ? " expanded" : ""}${selected ? " selected" : ""}${sourceVisible ? " source-visible" : ""}${asset ? "" : " missing"}${media ? " note-media" : ""}`;
    const referenceLabel = readableAttachmentReference(embed.target, asset?.name);
    root.title = referenceLabel.directory ? `${referenceLabel.name} · ${referenceLabel.directory}` : referenceLabel.name;
    root.setAttribute("aria-label", root.title);
    let closeViewer: (() => void) | undefined;
    let disposeVideo: (() => void) | undefined;
    let disposeImage: (() => void) | undefined;
    let disposeResize: (() => void) | undefined;
    assetWidgetCleanup.set(root, () => { closeViewer?.(); disposeVideo?.(); disposeImage?.(); disposeResize?.(); });
    root.dataset.assetTarget = embed.target;
    root.dataset.lrTokenKind = "asset";
    root.dataset.lrTokenFrom = String(from);
    root.dataset.lrTokenTo = String(to);
    root.dataset.lrTokenLabel = asset?.name || embed.display || embed.target;
    root.dataset.lrTokenMissing = asset ? "0" : "1";
    root.dataset.kind = asset?.kind || "other";
    if (asset?.id) root.dataset.lrTokenAssetId = asset.id;
    root.contentEditable = "false";
    if (embed.width) {
      const safeWidth = Math.max(embed.width, 1);
      root.style.width = `${safeWidth}px`;
      root.style.maxWidth = "100%";
    }

    const preview = document.createElement("span");
    preview.className = "lr-live-asset-preview";
    if (embed.height) {
      if (media) root.style.setProperty("--note-media-height", `${Math.min(embed.height, 720)}px`);
      else { preview.style.height = `${Math.min(embed.height, 720)}px`; preview.style.maxHeight = "720px"; }
    }
    const mediaSources = resolveNoteMediaSources(asset || {});
    let previewUrl = asset?.previewUrl || "";
    let thumbnailUrl = media ? mediaSources.imageSource : asset?.thumbnailUrl || asset?.previewUrl || "";
    if (asset && isVideoAsset(asset.kind) && previewUrl && (block || expanded)) {
      const video = document.createElement("video");
      video.setAttribute("aria-label", embed.display || asset.name);
      const status = document.createElement("span");
      status.className = "lr-live-image-status";
      status.setAttribute("role", "status");
      preview.append(video, status);
      applyRememberedMediaGeometry(root, previewUrl);
      const controller = attachVideoPreview(video, {
        source: previewUrl, thumbnail: thumbnailUrl, controls: media,
        onAspect: (width, height) => { if (width && height) { root.style.setProperty("--asset-aspect", `${width} / ${height}`); setNoteMediaAspect(root, width, height); rememberDecodedMediaGeometry(previewUrl, width, height); } },
        onState: (state, message) => {
          preview.dataset.videoState = state;
          status.textContent = message || "正在读取视频预览帧";
          status.hidden = state === "ready" && !message;
        },
      });
      root.onmouseenter = controller.enter;
      root.onmouseleave = controller.leave;
      disposeVideo = controller.destroy;
    } else if (thumbnailUrl) {
      const status = document.createElement("span");
      status.className = "lr-live-image-status";
      status.setAttribute("role", "status");
      preview.append(status);
      const imageController = attachNoteImage({ root, viewport: preview, source: thumbnailUrl,
        preview: asset?.thumbnailUrl, alt: embed.display,
        onState: state => {
          preview.dataset.imageState = state === "error" && preview.querySelector("img") ? "preview-error" : state;
          status.hidden = state === "ready" || state === "preview";
          status.textContent = state === "error" ? "图片读取失败，可打开引用检查文件" : state === "loading" ? "图片加载中" : "";
        },
      });
      disposeImage = imageController;
      if (media && isImageAsset(asset?.kind)) assetWidgetPositions.get(root)!.refreshImage = next => {
        previewUrl = next.asset?.previewUrl || "";
        thumbnailUrl = resolveNoteMediaSources(next.asset || {}).imageSource;
        imageController.updateSource(thumbnailUrl, next.asset?.thumbnailUrl);
      };
    } else {
      preview.textContent = media ? "媒体源不可用，可打开素材检查文件" : assetKindLabel(asset?.kind);
      if (media) preview.setAttribute("role", "status");
    }

    let body: HTMLSpanElement | undefined;
    if (!media) {
      body = document.createElement("span");
      body.className = "lr-live-asset-body";
      const mediaIcon = document.createElement("span");
      mediaIcon.className = "lr-live-asset-kind-icon";
      mediaIcon.innerHTML = "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"1.6\"/><path d=\"M4.5 10.5l2.4-2.4 1.8 1.8 1.2-1.2 1.8 1.8\"/><circle cx=\"5.7\" cy=\"6\" r=\"1\"/></svg>";
      const text = document.createElement("span");
      text.className = "lr-live-asset-text";
      const name = document.createElement("span");
      name.className = "lr-live-asset-name";
      name.textContent = referenceLabel.name;
      const meta = document.createElement("span");
      meta.className = "lr-live-asset-meta";
      const resolutionLabels: Record<string, string> = { pending: "正在解析附件", missing: "当前知识库及素材库未找到来源", ambiguous: "存在多个匹配附件", unavailable: "附件解析暂不可用", "denied-path": "附件路径不允许访问", "invalid-encoding": "附件路径编码无效", "knowledge-path-reparse-forbidden": "附件路径不允许访问", "knowledge-path-traversal": "附件路径超出知识库", "knowledge-attachment-read-failed": "附件文件无法读取", "knowledge-operation-failed": "附件解析暂不可用" };
      meta.textContent = asset
        ? [assetKindLabel(asset.kind), referenceLabel.directory].filter(Boolean).join(" · ")
        : [attachmentAccessMessage(embed.resolutionStatus) || resolutionLabels[embed.resolutionStatus || "missing"] || `附件无法解析：${embed.resolutionStatus}`, referenceLabel.directory].filter(Boolean).join(" · ");
      text.append(name, meta);
      body.append(mediaIcon, text);
    }

    const actions = document.createElement("span");
    actions.className = "lr-live-asset-actions";
    if (asset) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "lr-live-asset-action";
      open.title = "打开素材";
      open.setAttribute("aria-label", "打开素材详情");
      open.innerHTML = "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M6 3H3.8A1.8 1.8 0 0 0 2 4.8v7.4A1.8 1.8 0 0 0 3.8 14h7.4a1.8 1.8 0 0 0 1.8-1.8V10\"/><path d=\"M9 2h5v5\"/><path d=\"M8 8l6-6\"/></svg>";
      open.onmousedown = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      open.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenAsset?.(asset.id);
      };
      actions.appendChild(open);
    }
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "lr-live-asset-action"; edit.title = "编辑引用源码";
    edit.setAttribute("aria-label", "编辑引用源码");
    edit.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 4-4 4 4 4M11 4l4 4-4 4M9 2 7 14"/></svg>';
    edit.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
    edit.onclick = event => { event.preventDefault(); event.stopPropagation(); view.dispatch({ selection: { anchor: Math.max(from + 1, to - 1) }, scrollIntoView: true }); view.focus(); };
    actions.appendChild(edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lr-live-asset-action";
    remove.title = "移除引用";
    remove.setAttribute("aria-label", "移除引用");
    remove.innerHTML = "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M4 4l8 8\"/><path d=\"M12 4l-8 8\"/></svg>";
    remove.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    remove.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    };
    if (media) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "lr-live-asset-action";
      expand.title = isVideoAsset(asset?.kind) ? previewUrl ? "全屏播放" : "打开视频" : "放大图片";
      expand.setAttribute("aria-label", expand.title);
      expand.innerHTML = expandMediaIcon;
      expand.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
      expand.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        const video = preview.querySelector("video");
        if (video) void expandNoteVideo(video, message => {
          const status = preview.querySelector<HTMLElement>("[role=status]");
          if (status) { status.textContent = message; status.hidden = false; }
        });
        else if (isVideoAsset(asset?.kind) && asset) onOpenAsset?.(asset.id);
        else { closeViewer?.(); closeViewer = openImageViewer({ src: previewUrl || thumbnailUrl, alt: embed.display || asset?.name || embed.target }, expand); }
      };
      actions.appendChild(expand);
    }
    actions.appendChild(remove);
    root.append(preview);
    if (body) root.append(body);
    if (media) {
      const caption = document.createElement("span");
      caption.className = "lr-live-asset-caption";
      const filename = document.createElement("span");
      filename.textContent = referenceLabel.name;
      caption.append(filename);
      if (referenceLabel.directory) {
        const directory = document.createElement("small");
        directory.textContent = referenceLabel.directory;
        caption.append(directory);
      }
      root.append(caption);
    }
    root.append(actions);
    if ((block || expanded) && isImageAsset(asset?.kind)) {
      const resizeHandle = document.createElement("span");
      resizeHandle.className = "lr-live-asset-resize";
      resizeHandle.title = "拖动调整素材宽度";
      resizeHandle.onmousedown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = root.getBoundingClientRect().width || embed.width || 320;
        root.dataset.assetWidth = String(startWidth);
        const container = root.closest<HTMLElement>(".cm-line") || view.contentDOM;
        const style = getComputedStyle(container);
        const maxWidth = Math.max(1, container.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"));
        root.classList.add("resizing");

        const onMove = (moveEvent: MouseEvent) => {
          const nextWidth = Math.round(Math.min(Math.max(startWidth + moveEvent.clientX - startX, Math.min(180, maxWidth)), maxWidth));
          root.style.width = `${nextWidth}px`;
          root.dataset.assetWidth = String(nextWidth);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          root.classList.remove("resizing");
          const nextWidth = Number(root.dataset.assetWidth || Math.round(root.getBoundingClientRect().width));
          commitAssetWidth(view, from, to, embed.target, Number.isFinite(nextWidth) ? nextWidth : startWidth);
        };

        disposeResize = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      };
      root.appendChild(resizeHandle);
    }
    // Selection belongs to the editor's mouseSelectionStyle so a press on the
    // attachment can continue into a text/media drag (including autoscroll).
    root.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectAssetToken(view, from, to, false);
      onTokenContextMenu?.(event, {
        kind: "asset",
        from,
        to,
        label: asset?.name || embed.display || embed.target,
        assetId: asset?.id || null,
        missing: !asset,
      });
    };
    let selectedPress: { x: number; y: number } | undefined;
    root.addEventListener("mousedown", event => {
      const main = view.state.selection.main;
      selectedPress = event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey
        && main.from === from && main.to === to && !main.empty
        && !(event.target as HTMLElement)?.closest("button, video, .lr-live-asset-resize")
        ? { x: event.clientX, y: event.clientY } : undefined;
    }, true);
    root.addEventListener("mousemove", event => {
      if (selectedPress && Math.hypot(event.clientX - selectedPress.x, event.clientY - selectedPress.y) > 4) selectedPress = undefined;
    });
    root.addEventListener("mouseleave", () => { selectedPress = undefined; });
    root.onclick = event => {
      const press = selectedPress;
      selectedPress = undefined;
      if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4
        || !media || !isImageAsset(asset?.kind)) return;
      event.preventDefault(); event.stopPropagation();
      closeViewer?.(); closeViewer = openImageViewer({ src: previewUrl || thumbnailUrl, alt: embed.display || asset?.name || embed.target }, view.contentDOM);
    };
    root.ondblclick = (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("video")) return;
      event.preventDefault();
      event.stopPropagation();
      if (media && isImageAsset(asset?.kind)) {
        closeViewer?.(); closeViewer = openImageViewer({ src: previewUrl || thumbnailUrl, alt: embed.display || asset?.name || embed.target }, view.contentDOM);
      } else if (asset) onOpenAsset?.(asset.id);
    };
    return root;
  }

  ignoreEvent() {
    return false;
  }
}

type WikiLinkWidgetOptions = {
  rawTarget: string;
  display: string;
  targetLabel?: string;
  alias?: string;
  note: LiveNote | null;
  link: LiveNoteLink | null;
  targetNoteId?: string | null;
  canCreate?: boolean;
  from: number;
  to: number;
  selected: boolean;
  openOptions?: LiveNoteOpenOptions;
  onOpenNote?: (noteId: string, options?: LiveNoteOpenOptions) => void;
  onCreateNote?: (title: string, options?: LiveNoteOpenOptions) => void;
  onTokenContextMenu?: (event: MouseEvent, token: LiveEditorTokenContext) => void;
};

function wikiLinkTooltipLines(options: WikiLinkWidgetOptions, resolvedNoteId: string | null) {
  const { rawTarget, display, targetLabel, alias, note, link, targetNoteId, canCreate = true, openOptions } = options;
  const sameNoteAnchor = Boolean(targetNoteId && !rawTarget);
  const title = note?.title || link?.targetTitle || (sameNoteAnchor ? "当前笔记" : rawTarget || display || "未命名笔记");
  const lines: Array<{ kind: "title" | "meta" | "hint"; text: string }> = [
    { kind: "title", text: title },
  ];
  const path = note?.folderPath?.trim();
  if (path) lines.push({ kind: "meta", text: path });
  if (targetLabel && targetLabel !== rawTarget && targetLabel !== display) lines.push({ kind: "meta", text: targetLabel });
  if (openOptions?.headingPath) lines.push({ kind: "meta", text: `# ${openOptions.headingPath}` });
  if (openOptions?.blockId) lines.push({ kind: "meta", text: `^${openOptions.blockId}` });
  if (alias) lines.push({ kind: "meta", text: `显示为 ${alias}` });
  lines.push({
    kind: "hint",
    text: resolvedNoteId ? "Ctrl + 点击打开，双击直接打开" : canCreate ? "缺失笔记，Ctrl + 点击或双击创建" : "未找到可跳转目标",
  });
  return lines;
}

export class WikiLinkWidget extends WidgetType {
  constructor(private readonly options: WikiLinkWidgetOptions) {
    super();
  }

  eq(other: WikiLinkWidget) {
    return (
      other.options.display === this.options.display
      && other.options.targetLabel === this.options.targetLabel
      && other.options.alias === this.options.alias
      && other.options.note?.id === this.options.note?.id
      && other.options.note?.folderPath === this.options.note?.folderPath
      && other.options.link?.toNoteId === this.options.link?.toNoteId
      && other.options.targetNoteId === this.options.targetNoteId
      && other.options.openOptions?.blockId === this.options.openOptions?.blockId
      && other.options.openOptions?.headingPath === this.options.openOptions?.headingPath
      && other.options.selected === this.options.selected
      && other.options.from === this.options.from
      && other.options.to === this.options.to
    );
  }

  toDOM(view: EditorView) {
    const { rawTarget, display, note, link, targetNoteId, canCreate = true, from, to, selected, openOptions, onOpenNote, onCreateNote, onTokenContextMenu } = this.options;
    const resolvedNoteId = targetNoteId || note?.id || link?.toNoteId || null;
    const root = document.createElement("span");
    root.className = `lr-live-wiki-link${resolvedNoteId ? "" : " missing"}${selected ? " selected" : ""}`;
    root.textContent = display || rawTarget;
    root.contentEditable = "false";
    root.tabIndex = 0;
    root.dataset.lrTokenKind = "note";
    root.dataset.lrTokenFrom = String(from);
    root.dataset.lrTokenTo = String(to);
    root.dataset.lrTokenLabel = display || rawTarget;
    root.dataset.lrTokenMissing = resolvedNoteId ? "0" : "1";
    root.dataset.lrTokenCreateTitle = rawTarget;
    if (resolvedNoteId) root.dataset.lrTokenNoteId = resolvedNoteId;
    if (openOptions?.blockId) root.dataset.lrTokenBlockId = openOptions.blockId;
    if (openOptions?.headingPath) root.dataset.lrTokenHeadingPath = openOptions.headingPath;
    root.title = resolvedNoteId ? "Ctrl + 点击打开笔记" : canCreate ? "缺失笔记，Ctrl + 点击或双击创建" : "未找到可跳转目标";

    const tooltipLines = wikiLinkTooltipLines(this.options, resolvedNoteId);
    root.setAttribute("aria-label", tooltipLines.map((line) => line.text).join("，"));
    root.removeAttribute("title");
    const tooltip = document.createElement("span");
    tooltip.className = "lr-live-wiki-tooltip";
    tooltip.setAttribute("aria-hidden", "true");
    for (const line of tooltipLines) {
      const item = document.createElement("span");
      item.className = `lr-live-wiki-tooltip-${line.kind}`;
      item.textContent = line.text;
      tooltip.appendChild(item);
    }
    root.appendChild(tooltip);

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && resolvedNoteId) {
        onOpenNote?.(resolvedNoteId, openOptions);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && canCreate) {
        onCreateNote?.(rawTarget, openOptions);
        return;
      }
      setWholeTokenSelection(view, from, to);
    };
    root.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWholeTokenSelection(view, from, to);
      onTokenContextMenu?.(event, {
        kind: "note",
        from,
        to,
        label: display || rawTarget,
        noteId: resolvedNoteId,
        createTitle: rawTarget,
        openOptions,
        missing: !resolvedNoteId,
      });
    };
    root.ondblclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (resolvedNoteId) onOpenNote?.(resolvedNoteId, openOptions);
      else if (canCreate) onCreateNote?.(rawTarget, openOptions);
    };
    return root;
  }

  ignoreEvent() {
    return false;
  }
}

type TagWidgetOptions = {
  name: string;
  tag: LiveTag | null;
  from: number;
  to: number;
  selected: boolean;
  onOpenTag?: (tagId: string) => void;
  onCreateTag?: (name: string) => void;
  onTokenContextMenu?: (event: MouseEvent, token: LiveEditorTokenContext) => void;
};

export class TagWidget extends WidgetType {
  constructor(private readonly options: TagWidgetOptions) {
    super();
  }

  eq(other: TagWidget) {
    return (
      other.options.name === this.options.name
      && other.options.tag?.id === this.options.tag?.id
      && other.options.selected === this.options.selected
      && other.options.from === this.options.from
      && other.options.to === this.options.to
    );
  }

  toDOM(view: EditorView) {
    const { name, tag, from, to, selected, onOpenTag, onCreateTag, onTokenContextMenu } = this.options;
    const root = document.createElement("span");
    root.className = `lr-live-tag-chip${tag ? "" : " missing"}${selected ? " selected" : ""}`;
    root.textContent = `#${name}`;
    root.contentEditable = "false";
    root.dataset.lrTokenKind = "tag";
    root.dataset.lrTokenFrom = String(from);
    root.dataset.lrTokenTo = String(to);
    root.dataset.lrTokenLabel = name;
    root.dataset.lrTokenMissing = tag ? "0" : "1";
    if (tag?.id) root.dataset.lrTokenTagId = tag.id;
    root.title = tag ? "Ctrl + 点击打开标签" : "双击创建标签";

    root.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && tag?.id) {
        onOpenTag?.(tag.id);
        return;
      }
      setWholeTokenSelection(view, from, to);
    };
    root.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWholeTokenSelection(view, from, to);
      onTokenContextMenu?.(event, {
        kind: "tag",
        from,
        to,
        label: name,
        tagId: tag?.id || null,
        missing: !tag,
      });
    };
    root.ondblclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (tag?.id) onOpenTag?.(tag.id);
      else onCreateTag?.(name);
    };
    return root;
  }

  ignoreEvent() {
    return false;
  }
}
