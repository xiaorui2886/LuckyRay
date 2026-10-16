import {useCallback,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useI18n} from '../../../core/i18n/index';
import type {AiWriteAction,EditorCommand} from '../../../core/services/editor';
import type {LiveEditorTableContext} from './LiveMarkdownEditor';
import type {LiveEditorTokenContext} from './types';
import {IconLink,IconExternal,IconText,IconBold,IconItalic,IconStrike,IconCode,IconParagraph,IconHeading,IconQuote,IconList,IconNumberedList,IconTaskList,IconAlignLeft,IconAlignCenter,IconAlignRight,IconPlus,IconMinus,IconArrowUp,IconArrowDown,IconArrowLeft,IconArrowRight,IconTable,IconSortAsc,IconSortDesc,IconCodeBlock,IconAsset,IconWiki,IconTag,IconAi,IconEdit,IconContinue,IconScissors,IconCopy,IconClipboard,IconClipboardText,IconTrash,IconSelectAll} from './noteMenuIcons';
export type TableEditorCommand =
  | "row-above"
  | "row-below"
  | "row-move-up"
  | "row-move-down"
  | "row-copy"
  | "row-delete"
  | "column-left"
  | "column-right"
  | "column-move-left"
  | "column-move-right"
  | "column-align-left"
  | "column-align-center"
  | "column-align-right"
  | "column-copy"
  | "column-delete"
  | "sort-asc"
  | "sort-desc";
const EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN = 8;

function clampEditorContextMenuPosition(x: number, y: number, width: number, height: number) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN, viewportWidth - width - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN);
  const maxTop = Math.max(EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN, viewportHeight - height - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(x, EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(y, EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN), maxTop),
  };
}

function positionEditorSubmenu(trigger: HTMLElement | null, submenu: HTMLElement | null) {
  if (!trigger || !submenu) return;
  const previousDisplay = submenu.style.display;
  const previousVisibility = submenu.style.visibility;
  submenu.style.display = "block";
  submenu.style.visibility = "hidden";
  const submenuWidth = submenu.offsetWidth || 150;
  const submenuHeight = submenu.offsetHeight || 0;
  submenu.style.display = previousDisplay;
  submenu.style.visibility = previousVisibility;

  const triggerRect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const usableHeight = Math.min(submenuHeight, viewportHeight - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN * 2);
  let left = triggerRect.right;
  let top = triggerRect.top - 4;

  if (left + submenuWidth > viewportWidth - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN) {
    left = triggerRect.left - submenuWidth;
  }
  left = Math.min(
    Math.max(left, EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN),
    Math.max(EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN, viewportWidth - submenuWidth - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN),
  );

  if (top + usableHeight > viewportHeight - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN) {
    top = viewportHeight - usableHeight - EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN;
  }
  top = Math.max(top, EDITOR_CONTEXT_MENU_VIEWPORT_MARGIN);

  submenu.style.setProperty("--editor-ctx-sub-left", `${left}px`);
  submenu.style.setProperty("--editor-ctx-sub-top", `${top}px`);
}

export function EditorContextMenu({
  x,
  y,
  aiBusy,
  assetInsertionEnabled = true,
  token,
  table,
  onCommand,
  onTableCommand,
  onAiWrite,
  onOpenToken,
  onOpenNoteInNewTab,
  onOpenAssetDetail,
  onCopyToken,
  onCopyTokenLabel,
  onCopyTokenTarget,
  onEditNoteAlias,
  onRenameTag,
  onRemoveToken,
}: {
  x: number;
  y: number;
  aiBusy: boolean;
  assetInsertionEnabled?: boolean;
  token?: LiveEditorTokenContext | null;
  table?: LiveEditorTableContext | null;
  onCommand: (command: EditorCommand) => void;
  onTableCommand: (command: TableEditorCommand) => void;
  onAiWrite: (action: AiWriteAction) => void;
  onOpenToken: (token: LiveEditorTokenContext) => void;
  onOpenNoteInNewTab: (token: LiveEditorTokenContext) => void;
  onOpenAssetDetail: (assetId: string) => void;
  onCopyToken: (token: LiveEditorTokenContext) => void;
  onCopyTokenLabel: (token: LiveEditorTokenContext) => void;
  onCopyTokenTarget: (token: LiveEditorTokenContext) => void;
  onEditNoteAlias: (token: LiveEditorTokenContext) => void;
  onRenameTag: (token: LiveEditorTokenContext) => void;
  onRemoveToken: (token: LiveEditorTokenContext) => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState(() => ({ left: x, top: y }));
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const next = clampEditorContextMenuPosition(x, y, rect.width, rect.height);
    setMenuPosition((current) => current.left === next.left && current.top === next.top ? current : next);
  }, [table, token, x, y]);

  const tokenLabel = token?.kind === "asset" ? t("editor.notes.context.assetRef") : token?.kind === "note" ? t("editor.notes.context.noteLink") : token?.kind === "tag" ? t("editor.notes.context.tagRef") : token?.kind === "external" ? t("editor.notes.context.externalLink") : "";
  const tokenIcon = token?.kind === "asset" ? <IconAsset /> : token?.kind === "tag" ? <IconTag /> : token?.kind === "external" ? <IconExternal /> : <IconWiki />;
  const openTokenLabel = token?.kind === "asset"
    ? (token.missing ? t("editor.notes.context.assetMissing") : t("editor.notes.context.locateMaterial"))
    : token
      ? (token.missing ? t("editor.notes.context.createOpen", { label: tokenLabel }) : t("editor.notes.context.openReference", { label: tokenLabel }))
      : "";
  return (
    <div ref={menuRef} className="editor-ctx-react" style={{ left: menuPosition.left, top: menuPosition.top }} onPointerDown={(event) => event.stopPropagation()}>
      {token && (
        <>
          <EditorCtxItem
            icon={tokenIcon}
            label={openTokenLabel}
            onClick={() => onOpenToken(token)}
          />
          {token.kind === "note" && token.noteId && <EditorCtxItem icon={<IconWiki />} label={t("editor.notes.context.openNewTab")} onClick={() => onOpenNoteInNewTab(token)} />}
          {token.kind === "asset" && token.assetId && <EditorCtxItem icon={<IconExternal />} label={t("editor.notes.context.locateMaterial")} onClick={() => onOpenAssetDetail(token.assetId!)} />}
          {(token.kind === "note" || token.kind === "external") && <EditorCtxItem icon={<IconEdit />} label={token.kind === "external" ? t("editor.notes.context.editLink") : t("editor.notes.context.editNoteRef")} onClick={() => onEditNoteAlias(token)} />}
          {(token.kind === "note" || token.kind === "external") && <EditorCtxItem icon={<IconCopy />} label={token.kind === "external" ? t("editor.notes.context.copyLinkAddress") : t("editor.notes.context.copyLinkTarget")} onClick={() => onCopyTokenTarget(token)} />}
          {token.kind === "tag" && token.tagId && <EditorCtxItem icon={<IconEdit />} label={t("editor.notes.dialog.renameTag")} onClick={() => onRenameTag(token)} />}
          {token.kind === "asset" && <EditorCtxItem icon={<IconCopy />} label={t("editor.notes.context.copyMaterialName")} onClick={() => onCopyTokenLabel(token)} />}
          <EditorCtxItem icon={<IconCopy />} label={t("editor.notes.context.copyMarkdown")} onClick={() => onCopyToken(token)} />
          <EditorCtxItem icon={<IconMinus />} label={t("editor.notes.context.removeReference")} onClick={() => onRemoveToken(token)} />
          <div className="editor-ctx-sep-react" />
        </>
      )}
      <EditorCtxItem icon={<IconLink />} label={t("editor.notes.context.addLink")} onClick={() => onCommand("link")} />
      <EditorCtxItem icon={<IconExternal />} label={t("editor.notes.context.addExternalLink")} onClick={() => onCommand("external-link")} />
      <div className="editor-ctx-sep-react" />
      <EditorCtxSubmenu icon={<IconText />} label={t("editor.notes.context.textFormatting")}>
        <EditorCtxItem icon={<IconBold />} label={t("editor.notes.context.bold")} onClick={() => onCommand("bold")} />
        <EditorCtxItem icon={<IconItalic />} label={t("editor.notes.context.italic")} onClick={() => onCommand("italic")} />
        <EditorCtxItem icon={<IconStrike />} label={t("editor.notes.context.strike")} onClick={() => onCommand("strikethrough")} />
        <EditorCtxItem icon={<IconCode />} label={t("editor.notes.context.code")} onClick={() => onCommand("code")} />
      </EditorCtxSubmenu>
      <EditorCtxSubmenu icon={<IconParagraph />} label={t("editor.notes.context.paragraphSettings")}>
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading1")} onClick={() => onCommand("heading1")} />
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading2")} onClick={() => onCommand("heading2")} />
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading3")} onClick={() => onCommand("heading3")} />
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading4")} onClick={() => onCommand("heading4")} />
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading5")} onClick={() => onCommand("heading5")} />
        <EditorCtxItem icon={<IconHeading />} label={t("editor.notes.context.heading6")} onClick={() => onCommand("heading6")} />
        <EditorCtxItem icon={<IconParagraph />} label={t("editor.notes.context.paragraph")} onClick={() => onCommand("paragraph")} />
        <EditorCtxItem icon={<IconQuote />} label={t("editor.notes.context.quote")} onClick={() => onCommand("blockquote")} />
        <EditorCtxItem icon={<IconList />} label={t("editor.notes.context.bulletedList")} onClick={() => onCommand("bulleted-list")} />
        <EditorCtxItem icon={<IconNumberedList />} label={t("editor.notes.context.numberedList")} onClick={() => onCommand("numbered-list")} />
        <EditorCtxItem icon={<IconTaskList />} label={t("editor.notes.context.taskList")} onClick={() => onCommand("task-list")} />
        <div className="editor-ctx-sep-react" />
        <EditorCtxItem icon={<IconAlignLeft />} label={t("editor.notes.context.alignLeft")} onClick={() => onCommand("align-left")} />
        <EditorCtxItem icon={<IconAlignCenter />} label={t("editor.notes.context.alignCenter")} onClick={() => onCommand("align-center")} />
        <EditorCtxItem icon={<IconAlignRight />} label={t("editor.notes.context.alignRight")} onClick={() => onCommand("align-right")} />
      </EditorCtxSubmenu>
      <EditorCtxSubmenu icon={<IconPlus />} label={t("editor.notes.context.insert")}>
        <EditorCtxItem icon={<IconMinus />} label={t("editor.notes.context.rule")} onClick={() => onCommand("horizontal-rule")} />
        <EditorCtxItem icon={<IconTable />} label={t("editor.notes.context.table")} onClick={() => onCommand("table")} />
        <EditorCtxItem icon={<IconQuote />} label={t("editor.notes.context.callout")} onClick={() => onCommand("callout")} />
        <EditorCtxItem icon={<IconCodeBlock />} label={t("editor.notes.context.codeBlock")} onClick={() => onCommand("code-block")} />
        <div className="editor-ctx-sep-react" />
        <EditorCtxItem icon={<IconAsset />} label={t("editor.notes.context.insertMaterial")} disabled={!assetInsertionEnabled} onClick={() => onCommand("insert-asset")} />
        <EditorCtxItem icon={<IconWiki />} label={t("editor.notes.context.wikiLink")} onClick={() => onCommand("wiki-link")} />
      </EditorCtxSubmenu>
      <EditorCtxSubmenu icon={<IconAi />} label={t("editor.notes.ai.write")}>
        <EditorCtxItem icon={<IconEdit />} label={t("editor.notes.context.rewrite")} disabled={aiBusy} onClick={() => onAiWrite("rewrite")} />
        <EditorCtxItem icon={<IconList />} label={t("editor.notes.context.shorten")} disabled={aiBusy} onClick={() => onAiWrite("shorten")} />
        <EditorCtxItem icon={<IconParagraph />} label={t("editor.notes.context.expand")} disabled={aiBusy} onClick={() => onAiWrite("expand")} />
        <div className="editor-ctx-sep-react" />
        <EditorCtxItem icon={<IconContinue />} label={t("editor.notes.context.continue")} disabled={aiBusy} onClick={() => onAiWrite("continue")} />
      </EditorCtxSubmenu>
      <div className="editor-ctx-sep-react" />
      <EditorCtxItem icon={<IconScissors />} label={t("editor.notes.context.cut")} onClick={() => onCommand("cut")} />
      <EditorCtxItem icon={<IconCopy />} label={t("editor.notes.context.copy")} onClick={() => onCommand("copy")} />
      <EditorCtxItem icon={<IconClipboard />} label={t("editor.notes.context.paste")} onClick={() => onCommand("paste")} />
      <EditorCtxItem icon={<IconClipboardText />} label={t("editor.notes.context.pastePlain")} onClick={() => onCommand("paste-text")} />
      <div className="editor-ctx-sep-react" />
      <EditorCtxItem icon={<IconSelectAll />} label={t("editor.notes.context.selectAll")} onClick={() => onCommand("select-all")} />
      {table && (
        <>
          <div className="editor-ctx-sep-react" />
          <EditorCtxSubmenu icon={<IconTable />} label={t("editor.notes.context.row")}>
            <EditorCtxItem icon={<IconPlus />} label={t("editor.notes.context.rowAbove")} onClick={() => onTableCommand("row-above")} />
            <EditorCtxItem icon={<IconPlus />} label={t("editor.notes.context.rowBelow")} onClick={() => onTableCommand("row-below")} />
            <div className="editor-ctx-sep-react" />
            <EditorCtxItem icon={<IconArrowUp />} label={t("editor.notes.context.rowMoveUp")} disabled={table.lineOffset <= 2} onClick={() => onTableCommand("row-move-up")} />
            <EditorCtxItem icon={<IconArrowDown />} label={t("editor.notes.context.rowMoveDown")} disabled={table.lineOffset < 2 || table.lineOffset - 2 >= table.rowCount - 1} onClick={() => onTableCommand("row-move-down")} />
            <div className="editor-ctx-sep-react" />
            <EditorCtxItem icon={<IconCopy />} label={t("editor.notes.context.rowCopy")} onClick={() => onTableCommand("row-copy")} />
            <EditorCtxItem icon={<IconTrash />} label={t("editor.notes.context.rowDelete")} disabled={table.lineOffset < 2} onClick={() => onTableCommand("row-delete")} />
          </EditorCtxSubmenu>
          <EditorCtxSubmenu icon={<IconTable />} label={t("editor.notes.context.column")}>
            <EditorCtxItem icon={<IconPlus />} label={t("editor.notes.context.columnLeft")} onClick={() => onTableCommand("column-left")} />
            <EditorCtxItem icon={<IconPlus />} label={t("editor.notes.context.columnRight")} onClick={() => onTableCommand("column-right")} />
            <div className="editor-ctx-sep-react" />
            {table.columnIndex > 0 && <EditorCtxItem icon={<IconArrowLeft />} label={t("editor.notes.context.columnMoveLeft")} onClick={() => onTableCommand("column-move-left")} />}
            {table.columnIndex < table.columnCount - 1 && <EditorCtxItem icon={<IconArrowRight />} label={t("editor.notes.context.columnMoveRight")} onClick={() => onTableCommand("column-move-right")} />}
            <div className="editor-ctx-sep-react" />
            <EditorCtxItem icon={<IconAlignLeft />} label={t("editor.notes.context.alignLeft")} onClick={() => onTableCommand("column-align-left")} />
            <EditorCtxItem icon={<IconAlignCenter />} label={t("editor.notes.context.columnAlignCenter")} onClick={() => onTableCommand("column-align-center")} />
            <EditorCtxItem icon={<IconAlignRight />} label={t("editor.notes.context.columnAlignRight")} onClick={() => onTableCommand("column-align-right")} />
            <div className="editor-ctx-sep-react" />
            <EditorCtxItem icon={<IconCopy />} label={t("editor.notes.context.columnCopy")} onClick={() => onTableCommand("column-copy")} />
            <EditorCtxItem icon={<IconTrash />} label={t("editor.notes.context.columnDelete")} disabled={table.columnCount <= 1} onClick={() => onTableCommand("column-delete")} />
          </EditorCtxSubmenu>
          <EditorCtxItem icon={<IconSortAsc />} label={t("editor.notes.context.sortAsc")} disabled={table.rowCount < 2} onClick={() => onTableCommand("sort-asc")} />
          <EditorCtxItem icon={<IconSortDesc />} label={t("editor.notes.context.sortDesc")} disabled={table.rowCount < 2} onClick={() => onTableCommand("sort-desc")} />
        </>
      )}
    </div>
  );
}

function EditorCtxSubmenu({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const updateSubmenuPosition = useCallback(() => {
    positionEditorSubmenu(itemRef.current, submenuRef.current);
  }, []);

  return (
    <div ref={itemRef} className="editor-ctx-item-react has-sub" tabIndex={0} onFocus={updateSubmenuPosition} onMouseEnter={updateSubmenuPosition}>
      {icon}
      <span>{label}</span>
      <span className="editor-ctx-arrow-react">{String.fromCharCode(8250)}</span>
      <div ref={submenuRef} className="editor-ctx-sub-react">{children}</div>
    </div>
  );
}

function EditorCtxItem({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="editor-ctx-item-react" disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
