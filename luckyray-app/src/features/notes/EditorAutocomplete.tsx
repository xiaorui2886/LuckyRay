import {useI18n} from '../../core/i18n';
import {PreviewAssetMedia} from './NotePreview';
import type {AutocompleteState,AutocompleteItem} from './sourceNoteEditor';
export function EditorAutocomplete({
  state,
  onHover,
  onSelect,
}: {
  state: AutocompleteState;
  onHover: (index: number) => void;
  onSelect: (item: AutocompleteItem) => void;
}) {
  const { t } = useI18n();
  const title = state.kind === "note"
    ? t("editor.notes.autocomplete.linkNote")
    : state.kind === "asset"
      ? t("editor.notes.autocomplete.embedAsset")
      : state.kind === "anchor"
        ? state.query.startsWith("#") ? t("editor.notes.autocomplete.currentAnchor") : t("editor.notes.autocomplete.noteAnchor")
        : t("editor.notes.autocomplete.addTag");
  const isNoteLink = state.kind === "note";
  const isAsset = state.kind === "asset";
  const isAnchor = state.kind === "anchor";
  return (
    <div
      className={`note-autocomplete-react${isNoteLink ? " note-autocomplete-wiki" : ""}${isAsset ? " note-autocomplete-asset" : ""}${isAnchor ? " note-autocomplete-anchor" : ""}`}
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {!isNoteLink && <div className="note-autocomplete-title">{title}</div>}
      <div className="note-autocomplete-list">
        {state.items.map((item, index) => (
          <button
            key={item.id}
            className={`note-autocomplete-item${index === state.selectedIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(index)}
            onPointerDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
          >
            {isAsset && (
              <span className="note-autocomplete-thumb" aria-hidden="true">
                <PreviewAssetMedia asset={item} compact />
              </span>
            )}
              <span className="note-autocomplete-item-text">
                <span className="note-autocomplete-label">{state.kind === "tag" ? `#${item.label}` : item.label}</span>
                {item.meta && <small>{item.meta}</small>}
                {isNoteLink && item.snippet && <small className="note-autocomplete-snippet">{item.snippet}</small>}
              </span>
          </button>
        ))}
      </div>
      {isNoteLink && (
        <div className="note-autocomplete-hints">
          <span>{t("editor.notes.autocomplete.hintHeading")}</span>
          <span>{t("editor.notes.autocomplete.hintBlock")}</span>
          <span>{t("editor.notes.autocomplete.hintDisplay")}</span>
        </div>
      )}
    </div>
  );
}
