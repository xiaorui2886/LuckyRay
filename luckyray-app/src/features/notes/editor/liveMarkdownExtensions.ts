import { EditorSelection, EditorState, StateField, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { isMarkdownHorizontalRule, isMarkdownTableSeparatorLine, parseMarkdownTableAlignments, parseMarkdownTableCells, parseNoteFrontmatter } from "../../../core/services/noteRenderer";
import { normalizeMarkdownEmbedLookup } from "../../../core/markdown/embedTargets";
import { standardMarkdownReferences, isStandaloneVideoReference } from "../../../core/markdown/realVaultEmbeds";
import { AssetEmbedWidget, ExternalLinkWidget, FrontmatterPropertiesWidget, TagWidget, WikiLinkWidget } from "./assetEmbedWidgets";
import {
  CalloutBlockWidget,
  CodeBlockWidget,
  TableBlockWidget,
  type LiveCalloutBlock,
  type LiveCodeBlock,
  type LiveTableAlignment,
  type LiveTableBlock,
} from "./blockWidgets";
import { resolveAssetEmbed } from "./noteAssetResolver";
import { addPreparedAttachment, preparedAttachments, withPreparedAttachments } from "./preparedAttachment";
import type { LiveAsset, LiveEditorTokenContext, LiveNote, LiveNoteEmbed, LiveNoteLink, LiveNoteOpenOptions, LiveTag } from "./types";

class VaultAttachmentLinkWidget extends ExternalLinkWidget {
  private onOpenAttachment: () => void;
  constructor(options: ConstructorParameters<typeof ExternalLinkWidget>[0], onOpenAttachment: () => void) {
    super(options); this.onOpenAttachment = onOpenAttachment;
  }
  toDOM(view: EditorView) {
    const root = super.toDOM(view);
    const original = root.onmousedown;
    root.onmousedown = (event) => {
      if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopPropagation(); this.onOpenAttachment();
      } else { original?.call(root, event); }
    };
    return root;
  }
}

export type LiveMarkdownOptions = {
  assets: LiveAsset[];
  notes: LiveNote[];
  tags: LiveTag[];
  noteLinks: LiveNoteLink[];
  noteEmbeds: LiveNoteEmbed[];
  currentNoteId?: string | null;
  onOpenAsset?: (assetId: string) => void;
  onOpenNote?: (noteId: string, options?: LiveNoteOpenOptions) => void;
  onCreateNote?: (title: string, options?: LiveNoteOpenOptions) => void;
  onOpenTag?: (tagId: string) => void;
  onCreateTag?: (name: string) => void;
  onTokenContextMenu?: (event: MouseEvent, token: LiveEditorTokenContext) => void;
};

type PendingDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

type LiveRange = {
  from: number;
  to: number;
};

class HiddenAlignBoundaryWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = "lr-live-align-boundary-widget";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  ignoreEvent() {
    return true;
  }
}

const hiddenAlignBoundaryDecoration = Decoration.replace({
  widget: new HiddenAlignBoundaryWidget(),
});

function addAlignBoundaryDecoration(
  decorations: PendingDecoration[],
  line: { from: number; to: number },
  alignment: "left" | "center" | "right",
) {
  decorations.push({
    from: line.from,
    to: line.from,
    decoration: Decoration.line({ class: `lr-live-line-align boundary align-${alignment}` }),
  });
  if (line.to > line.from) {
    decorations.push({
      from: line.from,
      to: line.to,
      decoration: hiddenAlignBoundaryDecoration,
    });
  }
}

function normalizeLookup(value: string | null | undefined) {
  return normalizeMarkdownEmbedLookup(value);
}

function isInvisibleEmbedChar(value: string) {
  return /^[\uFEFF\u200B-\u200D\u2060]$/.test(value);
}

function isAssetPrefixedWikiToken(text: string, index: number) {
  let cursor = index - 1;
  while (cursor >= 0 && isInvisibleEmbedChar(text[cursor])) cursor -= 1;
  return cursor >= 0 && text[cursor] === "!";
}

function splitWikiTarget(raw: string) {
  const [targetPart, ...aliasParts] = raw.split("|");
  const target = targetPart.trim();
  const alias = aliasParts.join("|").trim();
  const hashIndex = target.indexOf("#");
  const title = hashIndex >= 0 ? target.slice(0, hashIndex).trim() : target;
  const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : "";
  const blockId = subpath.startsWith("^") ? subpath.slice(1).trim() || null : null;
  return {
    rawTarget: title,
    target,
    alias,
    display: alias || target || raw.trim(),
    subpath,
    blockId,
  };
}

function selectionOverlaps(state: EditorState, from: number, to: number) {
  const main = state.selection.main;
  if (main.empty) {
    return main.from > from && main.from < to;
  }
  return Math.max(main.from, from) < Math.min(main.to, to);
}

function selectionRevealsAssetSource(state: EditorState, from: number, to: number) {
  const main = state.selection.main;
  if (main.empty) {
    // Normal insertion/card clicks land at a boundary. Only an explicit move
    // inside the token reveals its editable Markdown source.
    return main.from > from && main.from < to;
  }
  // A complete token selection is an attachment selection, not source editing.
  // Partial selections and a caret inside the token still expose editable text.
  return !(main.from <= from && main.to >= to)
    && Math.max(main.from, from) < Math.min(main.to, to);
}

/** At a rendered attachment boundary, the first delete key selects its exact
 * reference. The standard selection-delete command handles the second press.
 * Inspect existing decorations instead of reparsing the document on a key. */
export function selectAdjacentAttachment(view: EditorView, direction: "backward" | "forward") {
  const main = view.state.selection.main;
  if (!main.empty || view.state.selection.ranges.length !== 1 || view.state.readOnly) return false;
  const targets: NonNullable<AssetEmbedWidget["selectionRange"]>[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const decorations = typeof source === "function" ? source(view) : source;
    decorations.between(Math.max(0, main.from - 1), Math.min(view.state.doc.length, main.to + 1), (_from, _to, decoration) => {
      const widget = decoration.spec.widget;
      if (!(widget instanceof AssetEmbedWidget)) return;
      const range = widget.selectionRange;
      if (range && main.from === (direction === "backward" ? range.to : range.from)) targets.push(range);
    });
    if (targets.length) break;
  }
  const target = targets[0];
  if (!target) return false;
  const { from, to, asset } = target;
  const markdown = view.state.doc.sliceString(from, to);
  const reference = standardMarkdownReferences(markdown)[0];
  const hasReceipt = view.state.field(preparedAttachments, false)?.some(item => item.from === from && item.to === to);
  // Preserve the already resolved widget in the existing text-owned history
  // projection. Undo must not await a new disk index after deleting a reference.
  const effects = asset && !hasReceipt ? [addPreparedAttachment.of({
    from, to, markdown, asset,
    embed: { targetName: reference ? `md:${reference.target}` : target.target, assetId: asset.id, isMissing: 0, resolutionStatus: "resolved" },
  })] : [];
  view.dispatch({ selection: { anchor: direction === "backward" ? to : from, head: direction === "backward" ? from : to }, effects, scrollIntoView: true });
  return true;
}

/** Rendered media has three keyboard stops: before, selected, after. Keep
 * Markdown atomic without letting the default atomic cursor skip these stops. */
export function moveAcrossAttachment(view: EditorView, forward: boolean) {
  const main = view.state.selection.main;
  if (view.state.selection.ranges.length !== 1) return false;
  let selection: EditorSelection | undefined;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    set.between(Math.max(0, main.from - 1), Math.min(view.state.doc.length, main.to + 1), (_from, _to, decoration) => {
      if (selection || !(decoration.spec.widget instanceof AssetEmbedWidget)) return;
      const range = decoration.spec.widget.selectionRange;
      if (!range) return;
      const { from, to } = range;
      if (!main.empty && main.from === from && main.to === to) {
        selection = EditorSelection.create([EditorSelection.cursor(forward ? to : from, forward ? 1 : -1)]);
      } else if (main.empty && main.head === (forward ? from : to)) {
        selection = EditorSelection.create([EditorSelection.range(forward ? from : to, forward ? to : from)]);
      } else if (main.empty && (forward ? main.head === from - 1 : main.head === to + 1)
        && view.state.doc.sliceString(forward ? main.head : to, forward ? from : main.head) === "\n") {
        selection = EditorSelection.create([EditorSelection.cursor(forward ? from : to, forward ? 1 : -1)]);
      }
    });
  }
  if (!selection) return false;
  view.dispatch({ selection, scrollIntoView: false, userEvent: "select" });
  return true;
}

/** Leave attachment selection/source editing without changing document text.
 * The source action is still allowed to put a caret inside the reference. */
export function dismissAttachmentInteraction(view: EditorView) {
  const main = view.state.selection.main;
  const decorations = view.state.facet(EditorView.decorations);
  for (const source of decorations) {
    const set = typeof source === "function" ? source(view) : source;
    let landing: number | null = null;
    set.between(0, view.state.doc.length, (_from, _to, decoration) => {
      const widget = decoration.spec.widget;
      if (!(widget instanceof AssetEmbedWidget)) return;
      const range = widget.sourceRange;
      if (main.empty && range.sourceVisible && main.from > range.from && main.from < range.to) landing = range.to;
      else if (!main.empty && main.from === range.from && main.to === range.to) landing = main.head;
      else if (!main.empty && range.sourceVisible && Math.max(main.from, range.from) < Math.min(main.to, range.to)) landing = range.to;
    });
    if (landing !== null) {
      view.dispatch({ selection: { anchor: landing }, scrollIntoView: false });
      return true;
    }
  }
  return false;
}

function selectionCovers(state: EditorState, from: number, to: number) {
  const main = state.selection.main;
  return !main.empty && main.from === from && main.to === to;
}

function overlapsAny(from: number, to: number, ranges: Array<{ from: number; to: number }>) {
  return ranges.some((range) => Math.max(from, range.from) < Math.min(to, range.to));
}

function getInlineCodeRanges(text: string): LiveRange[] {
  const ranges: LiveRange[] = [];
  const inlineCode = /`+[^`\n]*`+/g;
  let match: RegExpExecArray | null;
  while ((match = inlineCode.exec(text)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

function rangeContains(range: LiveRange | null, from: number, to: number) {
  return Boolean(range && from >= range.from && to <= range.to);
}

function selectionRevealsRange(state: EditorState, from: number, to: number) {
  const main = state.selection.main;
  if (main.empty) return main.from > from && main.from < to;
  return Math.max(main.from, from) < Math.min(main.to, to);
}

function isBlockToken(state: EditorState, from: number, to: number) {
  const line = state.doc.lineAt(from);
  const token = state.sliceDoc(from, to).trim();
  return line.text.trim() === token;
}

const headingFocus = StateEffect.define<boolean>();
const headingFocusState = StateField.define({ create: () => false, update: (value, tr) => tr.effects.find(effect => effect.is(headingFocus))?.value ?? value });

function selectionOnSameLine(state: EditorState, from: number) {
  const main = state.selection.main;
  if (!main.empty) return false;
  return state.doc.lineAt(main.from).number === state.doc.lineAt(from).number;
}

function parseTableAlignments(line: string): LiveTableAlignment[] {
  return parseMarkdownTableAlignments(line) as LiveTableAlignment[];
}

function findFrontmatterRange(state: EditorState): (LiveRange & { properties: ReturnType<typeof parseNoteFrontmatter>["properties"] }) | null {
  if (state.doc.lines < 2) return null;
  const firstLine = state.doc.line(1);
  if (firstLine.text.trim() !== "---") return null;
  for (let lineNo = 2; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    if (line.text.trim() !== "---") continue;
    const text = state.sliceDoc(firstLine.from, line.to);
    return {
      from: firstLine.from,
      to: line.to,
      properties: parseNoteFrontmatter(text).properties,
    };
  }
  return null;
}

function findCodeBlocks(state: EditorState): LiveCodeBlock[] {
  const blocks: LiveCodeBlock[] = [];
  let open: { marker: string; from: number; language: string; content: string[] } | null = null;

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const fence = /^\s*(```|~~~)\s*([\w-]+)?/.exec(line.text);
    if (!fence) continue;

    if (!open) {
      open = { marker: fence[1], from: line.from, language: fence[2] || "", content: [] };
      continue;
    }
    if (fence[1] !== open.marker) continue;
    blocks.push({ from: open.from, to: line.to, language: open.language, content: open.content.join("\n") });
    open = null;
    continue;
  }

  if (open) blocks.push({ from: open.from, to: state.doc.length, language: open.language, content: open.content.join("\n") });
  return blocks;
}

function collectCodeBlockContent(state: EditorState, blocks: LiveCodeBlock[]) {
  if (!blocks.length) return blocks;
  return blocks.map((block) => {
    const contentLines: string[] = [];
    let inContent = false;
    for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
      const line = state.doc.line(lineNo);
      if (line.to < block.from || line.from > block.to) continue;
      if (line.from === block.from) {
        inContent = true;
        continue;
      }
      if (line.to === block.to && /^\s*(```|~~~)/.test(line.text)) break;
      if (inContent) contentLines.push(line.text);
    }
    return { ...block, content: contentLines.join("\n") };
  });
}

function findCalloutBlocks(state: EditorState): LiveCalloutBlock[] {
  const blocks: LiveCalloutBlock[] = [];
  let lineNo = 1;

  while (lineNo <= state.doc.lines) {
    const startLine = state.doc.line(lineNo);
    const callout = /^>\s*\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)$/.exec(startLine.text.trim());
    if (!callout) {
      lineNo += 1;
      continue;
    }

    const body: string[] = [];
    let endLine = startLine;
    lineNo += 1;
    while (lineNo <= state.doc.lines) {
      const line = state.doc.line(lineNo);
      if (!/^>\s?/.test(line.text)) break;
      body.push(line.text.replace(/^>\s?/, ""));
      endLine = line;
      lineNo += 1;
    }

    blocks.push({
      kind: callout[1].toLocaleLowerCase(),
      title: callout[3].trim() || callout[1],
      body,
      folded: callout[2] === "-",
      from: startLine.from,
      to: endLine.to,
    });
  }

  return blocks;
}

function findTableBlocks(state: EditorState): LiveTableBlock[] {
  const blocks: LiveTableBlock[] = [];
  let lineNo = 1;

  while (lineNo < state.doc.lines) {
    const headerLine = state.doc.line(lineNo);
    const separatorLine = state.doc.line(lineNo + 1);
    const headerText = headerLine.text.trim();
    if (!headerText.includes("|") || !isMarkdownTableSeparatorLine(separatorLine.text)) {
      lineNo += 1;
      continue;
    }

    const headers = parseMarkdownTableCells(headerLine.text);
    const alignments = parseTableAlignments(separatorLine.text);
    const rows: string[][] = [];
    let endLine = separatorLine;
    lineNo += 2;

    while (lineNo <= state.doc.lines) {
      const rowLine = state.doc.line(lineNo);
      const rowText = rowLine.text.trim();
      if (!rowText || !rowText.includes("|") || /^(```|~~~)/.test(rowText)) break;
      rows.push(parseMarkdownTableCells(rowLine.text));
      endLine = rowLine;
      lineNo += 1;
    }

    blocks.push({
      headers,
      rows,
      alignments,
      from: headerLine.from,
      to: endLine.to,
    });
  }

  return blocks;
}

function buildLiveMarkdownDecorations(state: EditorState, options: LiveMarkdownOptions): DecorationSet {
  const text = state.doc.toString();
  const notesByTitle = new Map(options.notes.map((note) => [normalizeLookup(note.title), note]));
  const linksByTitle = new Map(options.noteLinks.map((link) => [normalizeLookup(link.targetTitle), link]));
  const tagsByName = new Map(options.tags.map((tag) => [normalizeLookup(tag.name), tag]));
  const decorations: PendingDecoration[] = [];
  const replacedRanges: Array<{ from: number; to: number }> = [];
  const codeBlocks = collectCodeBlockContent(state, findCodeBlocks(state));
  const calloutBlocks = findCalloutBlocks(state);
  const frontmatterRange = findFrontmatterRange(state);
  const inlineCodeRanges = getInlineCodeRanges(text);
  const parserExclusionRanges: LiveRange[] = [
    ...codeBlocks.map((block) => ({ from: block.from, to: block.to })),
    ...calloutBlocks.map((block) => ({ from: block.from, to: block.to })),
    ...(frontmatterRange ? [{ from: frontmatterRange.from, to: frontmatterRange.to }] : []),
  ];
  const tableBlocks = findTableBlocks(state).filter((block) => !overlapsAny(block.from, block.to, parserExclusionRanges));
  const hiddenCodeBlocks = codeBlocks.filter((block) => !selectionRevealsRange(state, block.from, block.to));
  const hiddenCalloutBlocks = calloutBlocks.filter((block) => !selectionRevealsRange(state, block.from, block.to));
  const hiddenTableBlocks = tableBlocks;
  const blockExcludedRanges: LiveRange[] = [
    ...parserExclusionRanges,
    ...tableBlocks.map((block) => ({ from: block.from, to: block.to })),
  ];
  const semanticExcludedRanges: LiveRange[] = [
    ...blockExcludedRanges,
    ...inlineCodeRanges,
  ];
  const hideFrontmatter = Boolean(frontmatterRange?.properties.length && !selectionRevealsRange(state, frontmatterRange.from, frontmatterRange.to));
  if (frontmatterRange) {
    if (hideFrontmatter) {
      decorations.push({
        from: frontmatterRange.from,
        to: frontmatterRange.to,
        decoration: Decoration.replace({
          widget: new FrontmatterPropertiesWidget({
            properties: frontmatterRange.properties,
            from: frontmatterRange.from,
            to: frontmatterRange.to,
          }),
          block: true,
        }),
      });
      replacedRanges.push({ from: frontmatterRange.from, to: frontmatterRange.to });
    }
  }
  for (const block of hiddenCodeBlocks) {
    decorations.push({
      from: block.from,
      to: block.to,
      decoration: Decoration.replace({
        widget: new CodeBlockWidget(block),
        block: true,
      }),
    });
    replacedRanges.push({ from: block.from, to: block.to });
  }
  for (const block of hiddenCalloutBlocks) {
    decorations.push({
      from: block.from,
      to: block.to,
      decoration: Decoration.replace({
        widget: new CalloutBlockWidget(block),
        block: true,
      }),
    });
    replacedRanges.push({ from: block.from, to: block.to });
  }
  for (const block of hiddenTableBlocks) {
    decorations.push({
      from: block.from,
      to: block.to,
      decoration: Decoration.replace({
        widget: new TableBlockWidget(block),
        block: true,
      }),
    });
    replacedRanges.push({ from: block.from, to: block.to });
  }
  let inFrontmatter = false;
  let codeFenceMarker: string | null = null;
  let alignBlock: "left" | "center" | "right" | null = null;
  let calloutBlockKind: string | null = null;

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const trimmed = line.text.trim();
    const nextLineText = lineNo < state.doc.lines ? state.doc.line(lineNo + 1).text : "";

    if (hideFrontmatter && rangeContains(frontmatterRange, line.from, line.to)) continue;
    if (hiddenCodeBlocks.some((range) => rangeContains(range, line.from, line.to))) continue;
    if (hiddenCalloutBlocks.some((range) => rangeContains(range, line.from, line.to))) continue;
    if (hiddenTableBlocks.some((range) => rangeContains(range, line.from, line.to))) continue;

    if (frontmatterRange && lineNo === 1 && trimmed === "---") {
      inFrontmatter = true;
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-frontmatter boundary" }) });
      continue;
    }

    if (inFrontmatter) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-frontmatter${trimmed === "---" ? " boundary" : ""}` }) });
      if (lineNo > 1 && trimmed === "---") inFrontmatter = false;
      continue;
    }

    if (isMarkdownHorizontalRule(trimmed)) {
      if (!selectionOnSameLine(state, line.from)) {
        decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-hr" }) });
      }
      continue;
    }

    const fenceLine = /^(```|~~~)/.exec(trimmed);
    if (fenceLine) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-code fence" }) });
      if (!codeFenceMarker) {
        codeFenceMarker = fenceLine[1];
      } else if (codeFenceMarker === fenceLine[1]) {
        codeFenceMarker = null;
      }
      continue;
    }

    if (codeFenceMarker) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-code" }) });
      continue;
    }

    if (alignBlock) {
      if (/^<\/div>\s*$/i.test(trimmed)) {
        addAlignBoundaryDecoration(decorations, line, alignBlock);
        alignBlock = null;
      } else {
        decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-align align-${alignBlock}` }) });
      }
      continue;
    }

    const alignMatch = /^<div\s+align=["']?(left|center|right)["']?>\s*$/i.exec(trimmed);
    if (alignMatch) {
      alignBlock = alignMatch[1].toLocaleLowerCase() as "left" | "center" | "right";
      addAlignBoundaryDecoration(decorations, line, alignBlock);
      continue;
    }

    const calloutMatch = /^>\s*\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)$/.exec(trimmed);
    if (calloutMatch) {
      calloutBlockKind = calloutMatch[1].toLocaleLowerCase();
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-callout kind-${calloutBlockKind}` }) });
    } else if (/^>\s?/.test(trimmed) && calloutBlockKind) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-callout body kind-${calloutBlockKind}` }) });
    } else {
      calloutBlockKind = null;
    }

    if (calloutMatch || (/^>\s?/.test(trimmed) && calloutBlockKind)) {
      continue;
    } else if (trimmed.includes("|") && (isMarkdownTableSeparatorLine(trimmed) || isMarkdownTableSeparatorLine(nextLineText) || isMarkdownTableSeparatorLine(lineNo > 1 ? state.doc.line(lineNo - 1).text : ""))) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-table${isMarkdownTableSeparatorLine(trimmed) ? " separator" : ""}` }) });
    } else if (/^#{1,6}\s+/.test(trimmed)) {
      const level = /^#+/.exec(trimmed)?.[0].length || 1;
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `lr-live-line-heading h${level}` }) });
      const marker = /^\s{0,3}#{1,6}\s+/.exec(line.text);
      if (marker && !(state.field(headingFocusState, false) && selectionOnSameLine(state, line.from))) {
        decorations.push({ from: line.from, to: line.from + marker[0].length, decoration: Decoration.replace({}) });
      }
    } else if (/^>\s?/.test(trimmed)) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-quote" }) });
    } else if (/^\s*[-*]\s+\[[ xX]\](?:\s+.*)?$/.test(line.text)) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-task" }) });
      const taskMatch = /^(\s*[-*]\s+)\[([ xX])\]/.exec(line.text);
      if (taskMatch) {
        const from = line.from + taskMatch[1].length;
        const to = from + 3;
        const checked = taskMatch[2].toLocaleLowerCase() === "x";
        if (!selectionOnSameLine(state, from)) {
          decorations.push({
            from,
            to,
            decoration: Decoration.mark({
              class: `lr-live-task-box${checked ? " checked" : ""}`,
              attributes: {
                "data-lr-task-checkbox": checked ? "checked" : "unchecked",
                "data-lr-task-from": String(from),
                title: checked ? "标记为未完成" : "标记为已完成",
              },
            }),
          });
        }
      }
    } else if (/^\s*(?:[-*](?:\s+.*)?|\d+[.)](?:\s+.*)?)$/.test(line.text)) {
      decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: "lr-live-line-list" }) });
    }
  }

  const assetPattern = /![\uFEFF\u200B-\u200D\u2060]*(?:\\?\[){2}([^\]\n]+?)(?:\\?\]){2}/g;
  let match: RegExpExecArray | null;
  const standardReferences = standardMarkdownReferences(text);
  const assetMatches: Array<{ from: number; to: number; target: string; width?: number | null; height?: number | null; markdown?: boolean; label?: string }> = [];
  while ((match = assetPattern.exec(text))) {
    assetMatches.push({ from: match.index, to: match.index + match[0].length, target: match[1] });
  }
  for (const reference of standardReferences.filter((reference) => (reference.embedded && reference.local) || isStandaloneVideoReference(text, reference))) {
    assetMatches.push({ from: reference.from, to: reference.to, target: reference.target, width: reference.width, height: reference.height, markdown: true, label: reference.label });
  }
  for (const token of assetMatches.sort((a, b) => a.from - b.from)) {
    const { from, to } = token;
    if (overlapsAny(from, to, semanticExcludedRanges)) continue;
    if (overlapsAny(from, to, replacedRanges)) continue;
    const embed = resolveAssetEmbed(token.target, options.noteEmbeds, options.assets, token.markdown ? "markdown" : "wiki");
    if (token.width) embed.width = token.width;
    if (token.height) embed.height = token.height;
    if (token.markdown) embed.display = (token.label || "").replace(/\|\d{1,4}(?:x\d{1,4})?$/, "");
    const assetKind = embed.asset?.kind?.toLocaleLowerCase();
    // Media and explicit-width embeds retain their visual size next to prose.
    const expanded = Boolean(embed.width) || assetKind === "image" || assetKind === "video";
    // Keep preceding prose on its own short line. Media starting a line uses
    // inline flow so text entered at its far boundary can fit beside it. The
    // widget supplies text-height boundary coordinates for CM's drawn caret.
    const block = expanded
      ? Boolean(state.doc.lineAt(from).text.slice(0, from - state.doc.lineAt(from).from).trim())
      : isBlockToken(state, from, to);
    const sourceVisible = selectionRevealsAssetSource(state, from, to);
    const widget = new AssetEmbedWidget({
      embed,
      from,
      to,
      block,
      expanded,
      selected: !state.selection.main.empty && state.selection.main.from <= from && state.selection.main.to >= to,
      sourceVisible,
      onOpenAsset: options.onOpenAsset,
      onTokenContextMenu: options.onTokenContextMenu,
    });

    if (sourceVisible) {
      decorations.push({ from, to, decoration: Decoration.mark({ class: "lr-live-asset-source" }) });
      decorations.push({
        from: to,
        to,
        decoration: Decoration.widget({ widget, block, side: 1 }),
      });
      replacedRanges.push({ from, to });
      continue;
    }

    decorations.push({
      from,
      to,
      decoration: Decoration.replace({
        widget,
        block,
        // Don't leave phantom text lines around a whole-line media block.
        inclusiveStart: block && state.doc.lineAt(from).from === from,
        inclusiveEnd: block && state.doc.lineAt(to).to === to,
      }),
    });
    replacedRanges.push({ from, to });
  }

  const wikiPattern = /(?:\\?\[){2}([^\]\n]+?)(?:\\?\]){2}/g;
  while ((match = wikiPattern.exec(text))) {
    if (isAssetPrefixedWikiToken(text, match.index)) continue;
    const from = match.index;
    const to = from + match[0].length;
    if (overlapsAny(from, to, semanticExcludedRanges)) continue;
    if (overlapsAny(from, to, replacedRanges)) continue;
    if (selectionOverlaps(state, from, to) && !selectionCovers(state, from, to)) continue;
    const parsed = splitWikiTarget(match[1]);
    const sameNoteAnchor = !parsed.rawTarget && Boolean(parsed.subpath || parsed.blockId);
    const note = parsed.rawTarget ? notesByTitle.get(normalizeLookup(parsed.rawTarget)) || null : null;
    const link = parsed.rawTarget ? linksByTitle.get(normalizeLookup(parsed.rawTarget)) || null : null;
    decorations.push({
      from,
      to,
      decoration: Decoration.replace({
        widget: new WikiLinkWidget({
          rawTarget: parsed.rawTarget,
          display: parsed.display,
          targetLabel: parsed.target,
          alias: parsed.alias,
          note,
          link,
          targetNoteId: sameNoteAnchor ? options.currentNoteId || null : null,
          canCreate: !sameNoteAnchor,
          from,
          to,
          selected: selectionCovers(state, from, to),
          openOptions: {
            blockId: parsed.blockId,
            headingPath: parsed.blockId ? null : parsed.subpath || null,
          },
          onOpenNote: options.onOpenNote,
          onCreateNote: options.onCreateNote,
          onTokenContextMenu: options.onTokenContextMenu,
        }),
      }),
    });
    replacedRanges.push({ from, to });
  }

  const externalLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const externalMatches: Array<{ from: number; to: number; label: string; href: string; local: boolean }> = standardReferences
    .filter((reference) => !reference.embedded && reference.local)
    .map((reference) => ({ ...reference, href: reference.target }));
  while ((match = externalLinkPattern.exec(text))) {
    externalMatches.push({ from: match.index, to: match.index + match[0].length, label: match[1], href: match[2], local: false });
  }
  for (const token of externalMatches.sort((a, b) => a.from - b.from)) {
    const { from, to } = token;
    if (overlapsAny(from, to, semanticExcludedRanges)) continue;
    if (overlapsAny(from, to, replacedRanges)) continue;
    if (selectionOnSameLine(state, from) && !selectionCovers(state, from, to)) {
      decorations.push({ from, to, decoration: Decoration.mark({ class: "lr-live-external-source" }) });
      continue;
    }
    const linkOptions = { label: token.label, href: token.href, from, to, selected: selectionCovers(state, from, to), onTokenContextMenu: options.onTokenContextMenu };
    const localAsset = token.local ? resolveAssetEmbed(token.href, options.noteEmbeds, options.assets, "markdown").asset : null;
    if (token.local && !localAsset) continue;
    decorations.push({
      from,
      to,
      decoration: Decoration.replace({
        widget: localAsset ? new VaultAttachmentLinkWidget(linkOptions, () => options.onOpenAsset?.(localAsset.id)) : new ExternalLinkWidget(linkOptions),
      }),
    });
    replacedRanges.push({ from, to });
  }

  const tagPattern = /(^|[\s([{（【《「『])#([^\s#[\](){},.;:!?，。、；：！？（）【】《》「」『』]+)/g;
  while ((match = tagPattern.exec(text))) {
    const from = match.index + match[1].length;
    const to = from + match[2].length + 1;
    if (overlapsAny(from, to, semanticExcludedRanges)) continue;
    if (overlapsAny(from, to, replacedRanges)) continue;
    const tagName = match[2];
    const tag = tagsByName.get(normalizeLookup(tagName)) || null;
    if (selectionOnSameLine(state, from) && !selectionCovers(state, from, to)) {
      decorations.push({ from, to, decoration: Decoration.mark({ class: "lr-live-tag" }) });
    } else {
      decorations.push({
        from,
        to,
        decoration: Decoration.replace({
          widget: new TagWidget({
            name: tagName,
            tag,
            from,
            to,
            selected: selectionCovers(state, from, to),
            onOpenTag: options.onOpenTag,
            onCreateTag: options.onCreateTag,
            onTokenContextMenu: options.onTokenContextMenu,
          }),
        }),
      });
      replacedRanges.push({ from, to });
    }
  }

  const blockIdPattern = /(^|[^\S\r\n])(\^[A-Za-z0-9_-]+)(?=[^\S\r\n]*(?:\r?\n|$))/gm;
  while ((match = blockIdPattern.exec(text))) {
    const from = match.index + match[1].length;
    const to = from + match[2].length;
    if (overlapsAny(from, to, semanticExcludedRanges)) continue;
    if (overlapsAny(from, to, replacedRanges)) continue;
    decorations.push({ from, to, decoration: Decoration.mark({ class: "lr-live-block-id" }) });
  }

  const inlineMarks: Array<{ pattern: RegExp; className: string }> = [
    { pattern: /`([^`\n]+)`/g, className: "lr-live-code" },
    { pattern: /~~([^~\n]+)~~/g, className: "lr-live-strike" },
    { pattern: /\*\*([^*\n]+)\*\*/g, className: "lr-live-strong" },
    { pattern: /(^|[^*])\*([^*\n]+)\*/g, className: "lr-live-emphasis" },
  ];
  for (const mark of inlineMarks) {
    while ((match = mark.pattern.exec(text))) {
      const from = match.index;
      const to = from + match[0].length;
      if (overlapsAny(from, to, blockExcludedRanges)) continue;
      if (overlapsAny(from, to, replacedRanges)) continue;
      decorations.push({ from, to, decoration: Decoration.mark({ class: mark.className }) });
    }
  }

  return Decoration.set(decorations.map((item) => item.decoration.range(item.from, item.to)), true);
}

export function liveMarkdownPreview(options: LiveMarkdownOptions) {
  const decorationsField = StateField.define<DecorationSet>({
    create(state) {
      return buildLiveMarkdownDecorations(state, withPreparedAttachments(state, options));
    },
    update(decorations, transaction) {
      if (transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(headingFocus))) {
        return buildLiveMarkdownDecorations(transaction.state, withPreparedAttachments(transaction.state, options));
      }
      return decorations;
    },
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.editorAttributes.of(view => {
        const { main, ranges } = view.state.selection;
        let attachmentOnly = false;
        if (ranges.length === 1 && !main.empty) view.state.field(field).between(main.from, main.to, (from, to, decoration) => {
          if (from === main.from && to === main.to && decoration.spec.widget instanceof AssetEmbedWidget
            && decoration.spec.widget.selectionRange) attachmentOnly = true;
        });
        return { "data-attachment-only-selection": String(attachmentOnly) };
      }),
      // CodeMirror's cursor movement skips rendered references atomically.
      // Explicit source editing removes this range while its source is visible.
      EditorView.atomicRanges.of((view) => {
        const ranges: ReturnType<Decoration["range"]>[] = [];
        view.state.field(field).between(0, view.state.doc.length, (from, to, decoration) => {
          const widget = decoration.spec.widget;
          if (widget instanceof AssetEmbedWidget && widget.selectionRange) ranges.push(decoration.range(from, to));
        });
        return Decoration.set(ranges, true);
      }),
    ],
  });
  return [headingFocusState, decorationsField, EditorView.domEventHandlers({
    focus: (_event, view) => { view.dispatch({ effects: headingFocus.of(true) }); },
    blur: (_event, view) => { view.dispatch({ effects: headingFocus.of(false) }); },
    mousemove: (event, view) => {
      const line = (event.target as Element).closest?.(".lr-live-line-heading");
      const rect = line?.getBoundingClientRect();
      view.dom.querySelectorAll<HTMLElement>(".cm-foldGutter button").forEach(button => {
        const bounds = button.getBoundingClientRect();
        button.toggleAttribute("data-hovered", Boolean(rect && bounds.top < rect.bottom && bounds.bottom > rect.top));
      });
    },
    mouseleave: (_event, view) => { view.dom.querySelectorAll("[data-hovered]").forEach(button => button.removeAttribute("data-hovered")); },
  }), EditorState.transactionFilter.of(transaction => {
    const { main, ranges } = transaction.state.selection;
    if (!transaction.selection || ranges.length !== 1 || !main.empty || main.assoc === -1) return transaction;
    let afterMedia = false;
    transaction.state.field(decorationsField).between(Math.max(0, main.head - 1), main.head, (_from, to, decoration) => {
      const token = decoration.spec.widget instanceof AssetEmbedWidget ? decoration.spec.widget.selectionRange : null;
      if (to === main.head && token && /^(image|video)$/i.test(token.asset?.kind || "")) afterMedia = true;
    });
    // At the trailing boundary associate the caret with the replaced media,
    // not the first character of the following text. Document offsets stay
    // unchanged, including for typing, undo and arrow traversal.
    return afterMedia ? [transaction, { selection: EditorSelection.create([EditorSelection.cursor(main.head, -1)]), sequential: true }] : transaction;
  })];
}

export function toggleTaskCheckboxAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const match = /^(\s*[-*]\s+)\[([ xX])\]/.exec(line.text);
  if (!match) return false;
  const from = line.from + match[1].length;
  const to = from + 3;
  const checked = match[2].toLocaleLowerCase() === "x";
  view.dispatch({
    changes: { from, to, insert: checked ? "[ ]" : "[x]" },
    selection: { anchor: to },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export const liveMarkdownTheme = EditorView.theme({
  "&": {
    height: "100%",
    background: "transparent",
    color: "var(--text-primary)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.8",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "28px 40px",
    caretColor: "var(--accent)",
  },
  ".cm-focused": {
    outline: "none",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-placeholder": {
    color: "var(--text-tertiary)",
    fontStyle: "italic",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
});
