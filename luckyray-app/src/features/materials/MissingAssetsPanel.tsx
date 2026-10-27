import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../core/i18n/index";
import { MATERIALS_MISSING_PANEL_ID } from "./materialsToolbarProtocol";
import type { MaterialMissingItem } from "./materialMissingRecovery";

export function MissingAssetsPanel({ open, list, loading, error, relocatingIds, removing, onScan, onRelocate, onRemove, onRemoveMany, onClose }: {
  open: boolean;
  list: MaterialMissingItem[];
  loading: boolean;
  error: string;
  relocatingIds: Set<string>;
  removing: boolean;
  onScan: () => void;
  onRelocate: (item: MaterialMissingItem) => void;
  onRemove: (item: MaterialMissingItem) => void;
  onRemoveMany: (ids: string[], all: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectAll = useRef<HTMLInputElement>(null);
  const selectedIds = list.filter((item) => selected.has(item.id)).map((item) => item.id);
  const allSelected = list.length > 0 && selectedIds.length === list.length;
  const busy = removing || loading || relocatingIds.size > 0;
  useEffect(() => {
    const valid = new Set(open ? list.map((item) => item.id) : []);
    setSelected((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [list, open]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedIds.length > 0 && !allSelected;
  }, [allSelected, open, selectedIds.length]);
  if (!open) return null;

  return <div id={MATERIALS_MISSING_PANEL_ID} className="missing-panel-react" role="region" aria-label={t("materials.missing.title")} aria-busy={removing}>
    <div className="missing-panel-header-react">
      <div className="missing-panel-heading-react"><span className="missing-panel-title-react">{t("materials.missing.title")}<span className="missing-panel-count-react">{list.length}</span></span><small>{t("materials.missing.recordOnly")}</small></div>
      <div className="missing-panel-actions-react">
        <button type="button" className="missing-rescan-react" onClick={onScan} disabled={busy}>
          <span className="material-action-icon-react sync-retry" aria-hidden="true" />{t(loading ? "materials.missing.scanning" : "materials.missing.scan")}
        </button>
        <button type="button" className="missing-close-react" aria-label={t("materials.missing.close")} title={t("materials.detail.close")} onClick={onClose}><span className="material-action-icon-react close" aria-hidden="true" /></button>
      </div>
    </div>
    <div className="missing-panel-toolbar-react">
      <label className="missing-select-all-react"><input ref={selectAll} type="checkbox" checked={allSelected} disabled={busy || list.length === 0} onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((item) => item.id)))} />{t("materials.missing.selectAll")}</label>
      <span className="missing-selection-count-react" role="status">{t(removing ? "materials.missing.removing" : "materials.missing.selectedCount", { count: selectedIds.length })}</span>
      <div className="missing-panel-actions-react">
        <button type="button" className="missing-bulk-remove-react" disabled={busy || selectedIds.length === 0 || Boolean(error)} onClick={() => onRemoveMany(selectedIds, false)}>{t("materials.missing.removeSelected")}{selectedIds.length > 0 && <span>{selectedIds.length}</span>}</button>
        <button type="button" className="missing-bulk-remove-react all" disabled={busy || list.length === 0 || Boolean(error)} onClick={() => onRemoveMany(list.map((item) => item.id), true)}>{t("materials.missing.removeAll")}</button>
      </div>
    </div>
    <div className="missing-panel-body-react">
      {loading && <div className="missing-empty-react">{t("materials.missing.scanningDetail")}</div>}
      {!loading && error && <div className="missing-empty-react" role="status">{t("materials.missing.failed", { error })}</div>}
      {!loading && !error && list.length === 0 && <div className="missing-empty-react">{t("materials.missing.empty")}</div>}
      {!loading && list.map((item) => <div key={item.id} className={`missing-item-react${selected.has(item.id) ? " selected" : ""}`} aria-busy={removing || relocatingIds.has(item.id)}>
        <label className="missing-item-select-react">
          <input type="checkbox" checked={selected.has(item.id)} disabled={busy} aria-label={t("materials.missing.selectAria", { name: item.name })} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />
          <span className="missing-item-info-react"><span className="missing-item-name-react" title={item.name}>{item.name}</span><span className="missing-item-path-react" title={item.libraryPath}>{item.libraryPath}</span></span>
        </label>
        <div className="missing-panel-actions-react">
          <button type="button" className="missing-item-relocate-react" onClick={() => onRelocate(item)} disabled={busy} aria-label={t("materials.missing.relocateAria", { name: item.name })}>{t(relocatingIds.has(item.id) ? "materials.missing.relocating" : "materials.missing.relocate")}</button>
          <button type="button" className="missing-item-remove-react" onClick={() => onRemove(item)} disabled={busy || Boolean(error)} aria-label={t("materials.missing.removeAria", { name: item.name })}>{t("materials.missing.remove")}</button>
        </div>
      </div>)}
    </div>
  </div>;
}
