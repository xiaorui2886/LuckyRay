import {useState,useMemo,useCallback,type ReactNode} from 'react';
import {useI18n} from '../../core/i18n';
import {normalizeWikiLinkKey as normalizeNoteLinkKey} from '../../core/markdown/wikiTargets';
import {parseNotePreviewBlocks,parseNoteFrontmatter,type NoteInlineToken} from '../../core/services/noteRenderer';
import {isNoteMargin,useNoteDisplayMenu} from './editor/noteDisplay';
import {InlineFilename} from './editor/noteFilename';
import {NoteVideoPreview} from './editor/NoteVideoPreview';
import {NoteMedia} from './media/NoteMedia';
import {resolveAssetEmbed} from './editor/noteAssetResolver';
import type {LiveNote,LiveAsset as Asset,LiveTag as Tag,LiveNoteLink as NoteLink,LiveNoteEmbed as NoteEmbed,LiveNoteOpenOptions as NoteOpenOptions} from './editor/types';
export function assetKindLabel(kind: string | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (kind === "image") return t("editor.notes.assetKind.image");
  if (kind === "video") return t("editor.notes.assetKind.video");
  if (kind === "audio") return t("editor.notes.assetKind.audio");
  if (kind === "document") return t("editor.notes.assetKind.document");
  return t("editor.notes.assetKind.material");
}

type PreviewAssetMediaLike = {
  kind?: string;
  label?: string;
  name?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
};

function isPreviewVideoAsset(asset?: PreviewAssetMediaLike | null) {
  return (asset?.kind || "").toLocaleLowerCase() === "video";
}

export function PreviewAssetMedia({ asset, compact = false }: { asset: PreviewAssetMediaLike; compact?: boolean }) {
  const { t } = useI18n();
  const isVideo = isPreviewVideoAsset(asset);
  const videoSrc = isVideo ? asset.previewUrl || "" : "";
  const imageSrc = asset.thumbnailUrl || (!isVideo ? asset.previewUrl : "") || "";
  const alt = asset.name || asset.label || "";

  if (isVideo && videoSrc) {
    return <NoteVideoPreview key={videoSrc} source={videoSrc} thumbnail={asset.thumbnailUrl} />;
  }

  if (imageSrc) {
    return <img className="note-preview-asset-media" src={imageSrc} alt={compact ? "" : alt} />;
  }

  return <span className="note-preview-asset-media-fallback">{assetKindLabel(asset.kind, t)}</span>;
}

function extractFrontmatterMarkdown(text: string) {
  const normalized = text.replace(/^\uFEFF/, "");
  const firstBreak = normalized.indexOf("\n");
  if (!normalized.startsWith("---") || firstBreak < 0 || normalized.slice(0, firstBreak).trim() !== "---") return "";
  const closingMatch = /\n---\s*(?:\r?\n|$)/.exec(normalized.slice(firstBreak));
  if (!closingMatch) return "";
  return normalized.slice(0, firstBreak + closingMatch.index + closingMatch[0].length);
}

export function NotePreview({
  text,
  currentNoteId,
  noteLinks,
  noteEmbeds,
  assets,
  notes,
  tags,
  compact = false,
  onOpenNote,
  onCreateNote,
  onOpenAsset,
  onOpenTag,
  onCreateTag,
  onToggleTask,
  onOpenExternal,
}: {
  text: string;
  currentNoteId?: string | null;
  noteLinks: NoteLink[];
  noteEmbeds: NoteEmbed[];
  assets: Asset[];
  notes: LiveNote[];
  tags: Tag[];
  compact?: boolean;
  onOpenNote: (noteId: string, options?: NoteOpenOptions) => void;
  onCreateNote: (title: string, options?: NoteOpenOptions) => void;
  onOpenAsset: (assetId: string) => void;
  onOpenTag?: (tagId: string) => void;
  onCreateTag?: (name: string) => void;
  onToggleTask?: (bodyLine: number) => void;
  onOpenExternal?: (url:string) => void;
}) {
  const { t } = useI18n();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesCopyStatus, setPropertiesCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [copiedCodeKey, setCopiedCodeKey] = useState<string | null>(null);
  const [failedCodeKey, setFailedCodeKey] = useState<string | null>(null);
  const display = useNoteDisplayMenu();
  const [foldedHeadings, setFoldedHeadings] = useState<Set<string>>(() => new Set());
  const blocks = useMemo(() => parseNotePreviewBlocks(text), [text]);
  const foldKey = (key: string) => `${currentNoteId || ""}:${key}`;
  const foldableHeadings = useMemo(() => new Set(blocks.filter((block, index) => {
    if (block.type !== "heading") return false;
    const next = blocks.slice(index + 1).find(item => item.type !== "space");
    return next && (next.type !== "heading" || next.level > block.level);
  }).map(block => block.key)), [blocks]);
  const visibleBlocks = useMemo(() => {
    let hiddenLevel: number | null = null;
    return blocks.filter(block => {
      if (block.type === "heading" && hiddenLevel !== null && block.level <= hiddenLevel) hiddenLevel = null;
      if (hiddenLevel !== null) return false;
      if (block.type === "heading" && foldedHeadings.has(`${currentNoteId || ""}:${block.key}`)) hiddenLevel = block.level;
      return true;
    });
  }, [blocks, foldedHeadings, currentNoteId]);
  const frontmatter = useMemo(() => parseNoteFrontmatter(text), [text]);
  const frontmatterMarkdown = useMemo(() => extractFrontmatterMarkdown(text), [text]);
  const linkMap = useMemo(() => new Map(noteLinks.map((link) => [normalizeNoteLinkKey(link.targetTitle), link])), [noteLinks]);
  const noteMap = useMemo(() => new Map(notes.map((note) => [normalizeNoteLinkKey(note.title.trim()), note])), [notes]);
  const tagMap = useMemo(() => new Map(tags.map((tag) => [normalizeNoteLinkKey(tag.name), tag])), [tags]);
  const localizedAssetKind = useCallback((kind: string | undefined) => {
    const normalized = kind?.toLocaleLowerCase();
    if (normalized === "image") return t("editor.notes.preview.assetImage");
    if (normalized === "video") return t("editor.notes.preview.assetVideo");
    if (normalized === "audio") return t("editor.notes.preview.assetAudio");
    return t("editor.notes.preview.assetFile");
  }, [t]);
  const renderInline = useCallback((tokens: NoteInlineToken[], keyPrefix: string): ReactNode[] => {
    return tokens.map((token, index) => {
      if (token.type === "text") return token.value;
      if (token.type === "strong") {
        return <strong className="note-preview-strong" key={`${keyPrefix}-strong-${index}`}>{token.value}</strong>;
      }
      if (token.type === "emphasis") {
        return <em className="note-preview-emphasis" key={`${keyPrefix}-em-${index}`}>{token.value}</em>;
      }
      if (token.type === "code") {
        return <code className="note-preview-inline-code" key={`${keyPrefix}-code-${index}`}>{token.value}</code>;
      }
      if (token.type === "strike") {
        return <s className="note-preview-strike" key={`${keyPrefix}-strike-${index}`}>{token.value}</s>;
      }
      if (token.type === "asset") {
        const resolved = resolveAssetEmbed(token.target, noteEmbeds, assets, token.markdown ? "markdown" : "wiki");
        const asset = resolved.asset;
        const assetKind = asset?.kind?.toLocaleLowerCase();
        if (asset && (assetKind === "image" || isPreviewVideoAsset(asset))) {
          return <NoteMedia key={`${keyPrefix}-asset-${index}`} asset={asset} alt={token.display || asset.name}
            width={token.width} height={token.height} inline onOpenAsset={() => onOpenAsset(asset.id)} />;
        }
        const expanded = Boolean(token.width);
        const inlineWidth = token.width ? Math.min(Math.max(token.width, 180), 720) : undefined;
        return (
          <button
            key={`${keyPrefix}-asset-${index}`}
            className={`note-preview-asset-link${asset ? " with-thumb" : " missing"}${expanded ? " expanded" : ""}`}
            data-kind={assetKind || undefined}
            style={inlineWidth ? { width: inlineWidth, maxWidth: "100%" } : undefined}
            onClick={() => asset ? onOpenAsset(asset.id) : undefined}
          >
            {expanded ? (
              <>
                <span className="note-preview-asset-inline-media" aria-hidden="true" style={token.height ? { height: Math.min(token.height, 720) } : undefined}>
                  {asset ? <PreviewAssetMedia asset={asset} /> : <span className="note-preview-asset-media-fallback">{t("editor.notes.preview.assetMissing")}</span>}
                </span>
                <span className="note-preview-asset-inline-body">
                  <b>{asset?.name || token.display || token.target}</b>
                  <small>{asset ? localizedAssetKind(asset.kind) : t("editor.notes.preview.assetMissing")}</small>
                </span>
              </>
            ) : asset?.thumbnailUrl || asset?.previewUrl ? (
              <span className="note-preview-asset-inline-thumb" aria-hidden="true">
                <PreviewAssetMedia asset={asset} compact />
              </span>
            ) : null}
            {!expanded ? <span>{asset?.name || token.display}</span> : null}
          </button>
        );
      }
      if (token.type === "wiki") {
        const lookupTitle = token.title || token.target;
        const lookupKey = normalizeNoteLinkKey(lookupTitle);
        const link = linkMap.get(lookupKey) || linkMap.get(normalizeNoteLinkKey(token.target));
        const note = noteMap.get(lookupKey) || noteMap.get(normalizeNoteLinkKey(token.target));
        const headingPath = token.blockId ? null : token.subpath || null;
        const sameNoteAnchor = !token.title && Boolean(token.subpath || token.blockId);
        const targetNoteId = sameNoteAnchor ? currentNoteId : note?.id || link?.toNoteId;
        return (
          <button
            key={`${keyPrefix}-note-${index}`}
            className={`note-preview-wiki${targetNoteId ? "" : " missing"}`}
            onClick={() => targetNoteId ? onOpenNote(targetNoteId, { blockId: token.blockId, headingPath }) : lookupTitle ? onCreateNote(lookupTitle, { blockId: token.blockId, headingPath }) : undefined}
            title={token.subpath ? token.target : undefined}
          >
            {token.display}
          </button>
        );
      }
      if (token.type === "tag") {
        const tag = tagMap.get(normalizeNoteLinkKey(token.name)) || null;
        return (
          <button
            key={`${keyPrefix}-tag-${index}`}
            className={`note-preview-tag${tag ? "" : " missing"}`}
            onClick={() => tag?.id ? onOpenTag?.(tag.id) : onCreateTag?.(token.name)}
          >
            {token.display}
          </button>
        );
      }
      const linkedAsset = resolveAssetEmbed(token.href, noteEmbeds, assets, "markdown").asset;
      return (
        <a key={`${keyPrefix}-url-${index}`} href={token.href} target="_blank" rel="noreferrer" onClick={linkedAsset || onOpenExternal ? (event) => { event.preventDefault(); if (linkedAsset) onOpenAsset(linkedAsset.id); else onOpenExternal?.(token.href); } : undefined}>
          {token.label}
        </a>
      );
    });
  }, [assets, currentNoteId, linkMap, localizedAssetKind, noteEmbeds, noteMap, onCreateNote, onCreateTag, onOpenAsset, onOpenNote, onOpenTag, onOpenExternal, t, tagMap]);

  const blockAnchor = useCallback((blockId: string | null) => (
    blockId ? <span className="note-preview-block-id" title={t("editor.notes.preview.blockReference", { id: blockId })}>^{blockId}</span> : null
  ), [t]);

  const renderBlock = useCallback((block: ReturnType<typeof parseNotePreviewBlocks>[number]) => {
    if (block.type === "space") return <div className="note-preview-space" key={block.key} />;
    if (block.type === "hr") {
      return (
        <div className="note-preview-hr-wrap" data-note-block-id={block.blockId || undefined} key={block.key}>
          <hr className="note-preview-hr" />
          {blockAnchor(block.blockId)}
        </div>
      );
    }
    if (block.type === "code") {
      return (
        <pre className="note-preview-code" key={block.key}>
          <span className="note-preview-code-head">
            <span className="note-preview-code-lang">{block.language || "code"}</span>
            <button
              className="note-preview-code-copy"
              onClick={async (event) => {
                event.preventDefault();
                event.stopPropagation();
                try {
                  await navigator.clipboard.writeText(block.content);
                  setCopiedCodeKey(block.key);
                  setFailedCodeKey(null);
                  window.setTimeout(() => setCopiedCodeKey((current) => current === block.key ? null : current), 1100);
                } catch {
                  setFailedCodeKey(block.key);
                  setCopiedCodeKey(null);
                  window.setTimeout(() => setFailedCodeKey((current) => current === block.key ? null : current), 1400);
                }
              }}
            >
              {copiedCodeKey === block.key ? t("editor.notes.preview.copied") : failedCodeKey === block.key ? t("editor.notes.preview.copyFailed") : t("editor.notes.preview.copy")}
            </button>
          </span>
          <code>{block.content}</code>
        </pre>
      );
    }
    if (block.type === "asset-card") {
      const resolved = resolveAssetEmbed(block.target, noteEmbeds, assets);
      const asset = resolved.asset;
      const assetKind = asset?.kind?.toLocaleLowerCase();
      if (asset && (assetKind === "image" || isPreviewVideoAsset(asset))) {
        return <span className="note-preview-media-block" key={block.key} data-note-block-id={block.blockId || undefined}>
          <NoteMedia asset={asset} alt={block.display || asset.name} width={block.width} height={block.height}
            onOpenAsset={() => onOpenAsset(asset.id)} />
          {blockAnchor(block.blockId)}
        </span>;
      }
      const expanded = Boolean(block.width);
      const cardWidth = block.width ? Math.min(Math.max(block.width, 180), 720) : undefined;
      return (
        <button
          className={`note-preview-asset-card${asset ? "" : " missing"}${expanded ? " expanded" : ""}`}
          key={block.key}
          data-note-block-id={block.blockId || undefined}
          data-kind={assetKind || undefined}
          style={cardWidth ? { width: cardWidth, maxWidth: "100%" } : undefined}
          onClick={() => asset ? onOpenAsset(asset.id) : undefined}
        >
          {expanded ? (
            <>
              <span className="note-preview-asset-inline-media" aria-hidden="true" style={block.height ? { height: Math.min(block.height, 720) } : undefined}>
                {asset ? <PreviewAssetMedia asset={asset} /> : <span className="note-preview-asset-media-fallback">{t("editor.notes.preview.assetMissing")}</span>}
              </span>
              <span className="note-preview-asset-inline-body">
                <b>{asset?.name || block.display || block.target}</b>
                <small>{asset ? localizedAssetKind(asset.kind) : t("editor.notes.preview.assetMissing")}</small>
              </span>
            </>
          ) : (
            <>
              <span className="note-preview-asset-thumb">
                {asset?.thumbnailUrl || asset?.previewUrl ? <PreviewAssetMedia asset={asset} /> : t("editor.notes.preview.asset")}
              </span>
              <span>
                <b>{asset?.name || block.display || block.target}</b>
                <small>{asset ? localizedAssetKind(asset.kind) : t("editor.notes.preview.assetMissing")}</small>
              </span>
            </>
          )}
          {blockAnchor(block.blockId)}
        </button>
      );
    }
    if (block.type === "heading") {
      const folded = foldedHeadings.has(foldKey(block.key));
      const content = <>{foldableHeadings.has(block.key) && <button type="button" className="note-heading-fold" aria-label={folded ? "展开章节" : "折叠章节"} aria-expanded={!folded}
        onClick={() => setFoldedHeadings(previous => { const next = new Set(previous), key = foldKey(block.key); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{folded ? "›" : "⌄"}</button>}{renderInline(block.tokens, block.key)}{folded && <span aria-hidden="true"> …</span>}{blockAnchor(block.blockId)}</>;
      const headingProps = { className: "note-preview-heading", "data-note-block-id": block.blockId || undefined, "data-note-heading-key": block.headingKey || undefined };
      if (block.level === 1) return <h1 {...headingProps} key={block.key}>{content}</h1>;
      if (block.level === 2) return <h2 {...headingProps} key={block.key}>{content}</h2>;
      if (block.level === 3) return <h3 {...headingProps} key={block.key}>{content}</h3>;
      if (block.level === 5) return <h5 {...headingProps} key={block.key}>{content}</h5>;
      if (block.level === 6) return <h6 {...headingProps} key={block.key}>{content}</h6>;
      return <h4 {...headingProps} key={block.key}>{content}</h4>;
    }
    if (block.type === "list") {
      return <div className={`note-preview-list${block.ordered ? " ordered" : ""}`} data-note-block-id={block.blockId || undefined} key={block.key}><span className="note-preview-list-marker">{block.ordered ? block.marker : "•"}</span><span>{renderInline(block.tokens, block.key)}{blockAnchor(block.blockId)}</span></div>;
    }
    if (block.type === "task") {
      return (
        <div className={`note-preview-task${block.checked ? " checked" : ""}`} data-note-block-id={block.blockId || undefined} key={block.key}>
          <input
            type="checkbox"
            checked={block.checked}
            readOnly={!onToggleTask}
            tabIndex={onToggleTask ? 0 : -1}
            onChange={() => onToggleTask?.(block.line)}
          />
          <span>{renderInline(block.tokens, block.key)}{blockAnchor(block.blockId)}</span>
        </div>
      );
    }
    if (block.type === "quote") {
      return <blockquote data-note-block-id={block.blockId || undefined} key={block.key}>{renderInline(block.tokens, block.key)}{blockAnchor(block.blockId)}</blockquote>;
    }
    if (block.type === "align") {
      return (
        <div className={`note-preview-align align-${block.alignment}`} data-note-block-id={block.blockId || undefined} key={block.key}>
          {block.lines.map((line, index) => (
            <div className="note-preview-align-line" key={`${block.key}-line-${index}`}>{renderInline(line, `${block.key}-${index}`)}</div>
          ))}
          {blockAnchor(block.blockId)}
        </div>
      );
    }
    if (block.type === "callout") {
      return (
        <div className={`note-preview-callout callout-${block.kind}${block.folded ? " folded" : ""}`} data-note-block-id={block.blockId || undefined} key={block.key}>
          <div className="note-preview-callout-title">
            <span className="note-preview-callout-fold" aria-hidden="true">{block.folded ? ">" : "v"}</span>
            <span>{block.title}</span>
            {blockAnchor(block.blockId)}
          </div>
          {!block.folded && block.lines.map((line, index) => (
            <div className="note-preview-callout-line" key={`${block.key}-line-${index}`}>{renderInline(line, `${block.key}-${index}`)}</div>
          ))}
        </div>
      );
    }
    if (block.type === "table") {
      return (
        <div className="note-preview-table-wrap" data-note-block-id={block.blockId || undefined} key={block.key}>
          <table className="note-preview-table">
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={`${block.key}-h-${index}`} style={{ textAlign: block.alignments[index] || undefined }}>
                    {renderInline(header, `${block.key}-h-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${block.key}-r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${block.key}-r-${rowIndex}-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] || undefined }}>
                      {renderInline(cell, `${block.key}-r-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {blockAnchor(block.blockId)}
        </div>
      );
    }
    return <p data-note-block-id={block.blockId || undefined} key={block.key}>{renderInline(block.tokens, block.key)}{blockAnchor(block.blockId)}</p>;
  }, [assets, blockAnchor, copiedCodeKey, failedCodeKey, localizedAssetKind, noteEmbeds, onOpenAsset, onToggleTask, renderInline, t, foldableHeadings, foldedHeadings, currentNoteId]);

  return (
    <div className={`note-preview${compact ? " compact" : ""}`} data-limit-width={!compact && display.preferences.limitWidth}
      onContextMenu={event => { const content = event.currentTarget.querySelector<HTMLElement>(".note-preview-content"); if (!compact && content && isNoteMargin(event, content)) display.open(event); }}><div className="note-preview-content">
      {!compact && display.preferences.inlineTitle && <InlineFilename id={currentNoteId} title={notes.find(note => note.id === currentNoteId)?.title || "未命名笔记"} />}
      {!!frontmatter.properties.length && (
        <div className={`note-properties${propertiesOpen ? " open" : ""}`}>
          <div className="note-properties-head">
            <button className="note-properties-toggle" onClick={() => setPropertiesOpen((open) => !open)}>
              <span>{t("editor.notes.preview.properties")}</span>
              <small>{frontmatter.properties.length}</small>
            </button>
            <button
              className="note-properties-copy"
              onClick={async () => {
                if (!frontmatterMarkdown) return;
                try {
                  await navigator.clipboard.writeText(frontmatterMarkdown);
                  setPropertiesCopyStatus("copied");
                  window.setTimeout(() => setPropertiesCopyStatus("idle"), 1100);
                } catch {
                  setPropertiesCopyStatus("failed");
                  window.setTimeout(() => setPropertiesCopyStatus("idle"), 1400);
                }
              }}
            >
              {propertiesCopyStatus === "copied" ? t("editor.notes.preview.copied") : propertiesCopyStatus === "failed" ? t("editor.notes.preview.copyFailed") : t("editor.notes.preview.copy")}
            </button>
          </div>
          {propertiesOpen && (
            <div className="note-properties-list">
              {frontmatter.properties.map((property) => (
                <div className="note-property-row" key={property.key}>
                  <span className="note-property-key" title={property.key}>{property.key}</span>
                  <span className="note-property-values">
                    {(property.values.length ? property.values : [t("editor.notes.preview.propertyEmpty")]).slice(0, 6).map((value) => (
                      <em className={property.values.length ? "" : "empty"} key={value} title={value}>{value}</em>
                    ))}
                    {property.values.length > 6 && (
                      <em className="more" title={property.values.slice(6).join("，")}>+{property.values.length - 6}</em>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {blocks.length ? visibleBlocks.map(renderBlock) : <p className="note-preview-empty">{t("editor.notes.preview.empty")}</p>}
      </div>
      {display.menu}
    </div>
  );
}
