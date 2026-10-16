import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useI18n } from "../../core/i18n/index";
import type { MaterialCsvExportPlan, MaterialCsvExportTask } from "../../core/services/materials";
import { materialExportFriendlyPath } from "./materialExportPresentation";

export function MaterialCsvExportDialog({ planning, plan, description, onDescription, busy, error, onClose, onConfirm }: {
  planning: boolean; plan: MaterialCsvExportPlan | null; description: boolean;
  onDescription: (value: boolean) => void; busy: "idle" | "choosing" | "starting";
  error: string; onClose: () => void; onConfirm: () => void;
}) {
  const { t } = useI18n();
  const active = planning || Boolean(plan);
  const locked = busy !== "idle";
  const modal = useApplicationModalSurface<HTMLDivElement>(active, onClose, {
    closeOnBackdrop: !locked, closeOnEscape: !locked,
  });
  const wasBusy = useRef(false);
  useEffect(() => {
    if (active && wasBusy.current && !locked) {
      modal.surfaceRef.current?.querySelector<HTMLButtonElement>("[data-modal-initial-focus]")?.focus({ preventScroll: true });
    }
    wasBusy.current = locked;
  }, [active, locked, modal.surfaceRef]);
  if (!active) return null;
  const root = document.querySelector<HTMLElement>(".react-nav-shell") ?? document.body;
  return createPortal(<div className="modal-overlay-react experience-dialog-backdrop material-export-modal-backdrop"
      onPointerDown={modal.onBackdropPointerDown}>
    <div ref={modal.surfaceRef} tabIndex={-1} onKeyDown={modal.onSurfaceKeyDown}
      className="modal-box-react material-export-plan material-csv-plan experience-dialog"
      role="dialog" aria-modal="true" aria-label={t("materials.csv.title")}
      onPointerDown={(event) => event.stopPropagation()}>
      <h3>{t("materials.csv.title")}</h3>
      {planning ? <p role="status">{t("materials.csv.planning")}</p> : <>
        <p>{t("materials.csv.scope", { scope: plan?.scopeLabel ?? "", count: plan?.total ?? 0 })}</p>
        {plan?.includesDescendants && <p>{t("materials.csv.descendants")}</p>}
        <p className="material-csv-fields">{t("materials.csv.fields")}</p>
        <label className="material-export-option"><input type="checkbox" checked={description} disabled={locked}
          onChange={(event) => onDescription(event.target.checked)} />{t("materials.csv.description")}</label>
        <p className="material-export-hint">{t("materials.csv.privacyHint")}</p>
        <p className="material-export-hint">{t("materials.csv.metadataOnly")}</p>
        {error && <p className="material-export-error" role="alert">{error}</p>}
      </>}
      {locked && <p role="status">{t(busy === "choosing" ? "materials.csv.choosing" : "materials.csv.starting")}</p>}
      <div className="material-export-actions">
        <button type="button" data-modal-initial-focus onClick={onClose} disabled={locked}>{t("materials.export.close")}</button>
        {plan && <button type="button" className="primary" onClick={onConfirm} disabled={locked}>
          {t("materials.csv.chooseFile")}</button>}
      </div>
    </div>
  </div>, root);
}

export function MaterialCsvTaskRow({ task, retrying, onCancel, onRetry, onDismiss }: {
  task: MaterialCsvExportTask; retrying: boolean;
  onCancel: () => void; onRetry: () => void; onDismiss: () => void;
}) {
  const { t } = useI18n();
  const active = ["preparing", "running", "cancelling"].includes(task.phase);
  const path = materialExportFriendlyPath(task.outputPath ?? task.destination);
  return <article className={`material-export-task material-csv-task${active ? " is-active" : ""}`}
    aria-label={t("materials.csv.title")}>
    <div className="material-export-task-heading">
      <div className="material-export-task-identity"><strong>{t("materials.csv.title")}</strong>
        <span>{t(`materials.csv.phase.${task.phase}` as Parameters<typeof t>[0])}</span></div>
      {active ? <button type="button" className="material-export-cancel" onClick={onCancel}
        disabled={task.phase === "cancelling"}>{t("materials.export.cancel")}</button>
        : <button type="button" className="material-export-dismiss" onClick={onDismiss}
          aria-label={t("materials.export.close")}>×</button>}
    </div>
    <div className="material-export-counts">{task.completed}/{task.total}</div>
    <details className="material-export-path"><summary>{path.folder}</summary>
      <div className="material-export-path-full"><code>{path.full}</code></div></details>
    {task.error && <p className="material-export-error" role="alert">{task.error}</p>}
    {task.phase === "failed" && <div className="material-export-row-actions"><button type="button"
      onClick={onRetry} disabled={retrying}>{t(retrying ? "materials.csv.retrying" : "materials.csv.retry")}</button></div>}
  </article>;
}
