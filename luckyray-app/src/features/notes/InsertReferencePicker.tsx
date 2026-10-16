import {useEffect,useRef} from 'react';
import {useI18n} from '../../core/i18n';
import {IconAsset,IconWiki} from './editor/noteMenuIcons';
import {PreviewAssetMedia} from './NotePreview';
import type {AutocompleteItem} from './sourceNoteEditor';
export type InsertPickerState = {
  kind: "asset" | "note";
  query: string;
  selectedIndex: number;
  selection: { start: number; end: number };
  alias?: string;
};
export function InsertReferencePicker({
  state,
  items,
  onQueryChange,
  onSelectIndex,
  onCancel,
  onInsert,
}: {
  state: InsertPickerState;
  items: AutocompleteItem[];
  onQueryChange: (query: string) => void;
  onSelectIndex: (index: number) => void;
  onCancel: () => void;
  onInsert: (item: AutocompleteItem) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const effectiveSelectedIndex = state.selectedIndex >= 0 && state.selectedIndex < items.length
    ? state.selectedIndex
    : items.length
      ? 0
      : -1;
  const selectedItem = effectiveSelectedIndex >= 0 ? items[effectiveSelectedIndex] || null : null;
  const isAsset = state.kind === "asset";

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const moveSelection = (direction: 1 | -1) => {
    if (!items.length) return;
    const next = effectiveSelectedIndex < 0
      ? (direction > 0 ? 0 : items.length - 1)
      : (effectiveSelectedIndex + direction + items.length) % items.length;
    onSelectIndex(next);
  };

  return (
    <div className="modal-overlay-react insert-picker-overlay" onPointerDown={onCancel}>
      <div className="insert-picker-react" onPointerDown={(event) => event.stopPropagation()}>
        <div className="insert-picker-header">
          <span className="insert-picker-icon">{isAsset ? <IconAsset /> : <IconWiki />}</span>
          <span>{isAsset ? t("editor.notes.insert.assetTitle") : t("editor.notes.insert.noteTitle")}</span>
        </div>
        <input
          ref={inputRef}
          className="insert-picker-search"
          value={state.query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveSelection(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (selectedItem) onInsert(selectedItem);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder={isAsset ? t("editor.notes.insert.searchAssets") : t("editor.notes.insert.searchNotes")}
        />
        <div className="insert-picker-list">
          {items.length ? items.map((item, index) => (
            <button
              aria-selected={index === effectiveSelectedIndex}
              className={`insert-picker-row${index === effectiveSelectedIndex ? " active" : ""}`}
              key={`${item.id}-${item.label}`}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectIndex(index);
              }}
              onDoubleClick={() => onInsert(item)}
              onClick={() => onSelectIndex(index)}
              type="button"
            >
              <span className="insert-picker-row-icon">
                {isAsset && (item.thumbnailUrl || item.previewUrl) ? (
                  <PreviewAssetMedia asset={item} compact />
                ) : isAsset ? <IconAsset /> : <IconWiki />}
              </span>
              <span className="insert-picker-row-main">
                <span className="insert-picker-row-title">{item.label}</span>
                {item.snippet ? <span className="insert-picker-row-snippet">{item.snippet}</span> : null}
              </span>
              <span className="insert-picker-row-meta">{item.meta || (isAsset ? t("editor.notes.insert.assetMeta") : t("editor.notes.insert.noteMeta"))}</span>
            </button>
          )) : (
            <div className="insert-picker-empty">{isAsset ? t("editor.notes.insert.noAssets") : t("editor.notes.insert.noNotes")}</div>
          )}
        </div>
        <div className="insert-picker-actions">
          <button type="button" className="insert-picker-close" onClick={onCancel}>{t("common.action.cancel")}</button>
          <button type="button" className="primary" disabled={!selectedItem} onClick={() => selectedItem && onInsert(selectedItem)}>{t("editor.notes.insert.insert")}</button>
        </div>
      </div>
    </div>
  );
}
