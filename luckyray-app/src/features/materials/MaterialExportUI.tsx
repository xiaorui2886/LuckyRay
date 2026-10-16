import { useEffect, useRef, useState, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { ExperienceOverlay } from "../../components/ExperienceOverlay";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useI18n } from "../../core/i18n/index";
import type { MaterialCsvExportTask, MaterialExportPlan, MaterialExportTask } from "../../core/services/materials";
import { MaterialCsvTaskRow } from "./MaterialCsvExportUI";
import {
  isMaterialExportRunning, materialExportFriendlyPath,
  type MaterialExportNotice, type MaterialExportTaskProblem,
} from "./materialExportPresentation";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ExportNotice({ notice, onDismiss, onAction }: {
  notice: MaterialExportNotice;
  onDismiss: () => void;
  onAction: () => void;
}) {
  const { t } = useI18n();
  const timerRef = useRef<number | null>(null);
  const remainingRef = useRef(4000);
  const startedRef = useRef(0);
  const hoveringRef = useRef(false);
  const focusedRef = useRef(false);
  const dismissRef = useRef(onDismiss);
  const [paused, setPaused] = useState(false);
  dismissRef.current = onDismiss;

  useEffect(() => {
    // The pointer or keyboard may reach a freshly mounted notice before this
    // effect runs. Never arm a timer after an earlier pause signal.
    if (!hoveringRef.current && !focusedRef.current && timerRef.current === null) {
      startedRef.current = Date.now();
      timerRef.current = window.setTimeout(() => dismissRef.current(), remainingRef.current);
    }
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [notice.id]);

  const pause = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
    }
    setPaused(true);
  };
  const resume = () => {
    if (hoveringRef.current || focusedRef.current || timerRef.current !== null) return;
    if (remainingRef.current <= 0) { dismissRef.current(); return; }
    startedRef.current = Date.now();
    timerRef.current = window.setTimeout(() => dismissRef.current(), remainingRef.current);
    setPaused(false);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focusedRef.current = false;
    resume();
  };

  return <section className={`experience-toast material-export-notice material-export-notice--${notice.tone}`}
    role="status" aria-live="polite" data-paused={paused}
    onMouseEnter={() => { hoveringRef.current = true; pause(); }}
    onMouseLeave={() => { hoveringRef.current = false; resume(); }}
    onFocusCapture={() => { focusedRef.current = true; pause(); }} onBlurCapture={onBlur}>
    <span className="material-export-notice-message">{notice.message}</span>
    {notice.action && <button type="button" onClick={() => { onAction(); onDismiss(); }}>
      {t(notice.action === "open" ? "materials.export.openDestination" : "materials.export.viewRecords")}
    </button>}
    <button type="button" className="material-export-notice-close" aria-label={t("materials.export.close")}
      onClick={onDismiss}>×</button>
    <span className="material-export-notice-timer" aria-hidden="true" />
  </section>;
}

export function MaterialExportUI({ planning, plan, submissionPhase, preserveHierarchy, onPreserveHierarchy,
  onCancelPlan, onConfirm, error, tasks, labels, panelOpen, onClosePanel, onOpenPanel,
  notices, onDismissNotice, taskProblems, actionErrors, retryState, retryChildren, retryErrors,
  onCancelTask, onRetry, onOpenDestination, onCopyDestination, onDismissTask, onClearCompleted,
  onRefreshTask,
  csvTasks, csvRetrying, onCancelCsvTask, onRetryCsvTask, onDismissCsvTask,
}: {
  planning: boolean;
  plan: MaterialExportPlan | null;
  submissionPhase: "idle" | "choosing" | "starting";
  preserveHierarchy: boolean;
  onPreserveHierarchy: (value: boolean) => void;
  onCancelPlan: () => void;
  onConfirm: () => void;
  error: string;
  tasks: MaterialExportTask[];
  labels: Record<string, string>;
  panelOpen: boolean;
  onClosePanel: () => void;
  onOpenPanel: () => void;
  notices: MaterialExportNotice[];
  onDismissNotice: (id: string) => void;
  taskProblems: Record<string, MaterialExportTaskProblem>;
  actionErrors: Record<string, string>;
  retryState: Record<string, "inflight" | "continued">;
  retryChildren: Record<string, string>;
  retryErrors: Record<string, string>;
  onCancelTask: (taskId: string) => void;
  onRetry: (task: MaterialExportTask) => void;
  onOpenDestination: (taskId: string) => void;
  onCopyDestination: (taskId: string, path: string) => void;
  onDismissTask: (taskId: string) => void;
  onClearCompleted: () => void;
  onRefreshTask: (taskId: string) => void;
  csvTasks: MaterialCsvExportTask[];
  csvRetrying: string | null;
  onCancelCsvTask: (taskId: string) => void;
  onRetryCsvTask: (taskId: string) => void;
  onDismissCsvTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const modalActive = planning || Boolean(plan);
  const busy = submissionPhase !== "idle";
  const modal = useApplicationModalSurface<HTMLDivElement>(modalActive, onCancelPlan, {
    closeOnBackdrop: !busy, closeOnEscape: !busy,
  });
  const wasBusyRef = useRef(false);
  useEffect(() => {
    // Disabling the focused chooser button can move focus to the document.
    // Restore the modal focus target once the native dialog/start call returns.
    if (modalActive && wasBusyRef.current && !busy) {
      modal.surfaceRef.current?.querySelector<HTMLButtonElement>("[data-modal-initial-focus]")
        ?.focus({ preventScroll: true });
    }
    wasBusyRef.current = busy;
  }, [busy, modalActive, modal.surfaceRef]);
  const panelRef = useRef<HTMLElement | null>(null);
  const running = tasks.filter(isMaterialExportRunning);
  const recent = tasks.filter((task) => !isMaterialExportRunning(task)).reverse();
  const runningCsv = csvTasks.filter((task) => ["preparing", "running", "cancelling"].includes(task.phase));
  const recentCsv = csvTasks.filter((task) => !["preparing", "running", "cancelling"].includes(task.phase)).reverse();
  const portalRoot = document.querySelector<HTMLElement>(".react-nav-shell") ?? document.body;

  useEffect(() => {
    if (panelOpen) panelRef.current?.querySelector<HTMLButtonElement>("[data-export-panel-initial-focus]")
      ?.focus({ preventScroll: true });
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target)
        || document.getElementById("materials-export-trigger")?.contains(target))) return;
      onClosePanel();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [onClosePanel, panelOpen]);

  const renderTask = (task: MaterialExportTask) => {
    const active = isMaterialExportRunning(task);
    const problem = taskProblems[task.taskId];
    const path = materialExportFriendlyPath(task.destination);
    const percentage = task.currentTotalBytes > 0
      ? Math.min(100, Math.floor(task.currentBytes / task.currentTotalBytes * 100)) : null;
    const retryChild = tasks.find((entry) => entry.taskId === retryChildren[task.taskId]);
    const recovered = retryChild?.phase === "completed" && retryChild.failed === 0
      && retryChild.cancelled === 0 && retryChild.succeeded === retryChild.total;
    const label = labels[task.taskId] || (task.total === 1 ? task.items[0]?.name : null)
      || t("materials.export.scope", { scope: t("materials.export.progressTitle"), count: task.total });
    const status = problem?.stopped
      ? t(problem.expired ? "materials.export.summaryExpired" : "materials.export.statusUnknown")
      : active ? t(task.phase === "cancelling" ? "materials.export.cancelling" : "materials.export.running")
        : task.failed > 0 ? t("materials.export.hasFailures")
          : task.cancelled > 0 ? t("materials.export.wasCancelled") : t("materials.export.done");
    return <section key={task.taskId} className={`material-export-task${active ? " is-active" : ""}`}
      data-export-task-id={task.taskId}>
      <header className="material-export-task-heading">
        <div className="material-export-task-identity"><strong title={label}>{label}</strong><span>{status}</span></div>
        {active ? <button type="button" className="material-export-cancel" onClick={() => onCancelTask(task.taskId)}
          disabled={task.phase === "cancelling" || Boolean(problem?.expired)}>
          {t(task.phase === "cancelling" ? "materials.export.cancelling" : "materials.export.cancel")}
        </button> : <button type="button" className="material-export-dismiss" onClick={() => onDismissTask(task.taskId)}
          disabled={retryState[task.taskId] === "inflight"}
          aria-label={t("materials.export.dismissRecord")}>×</button>}
      </header>
      <div className="material-export-counts">{task.completed}/{task.total} · {t("materials.export.successCount", { count: task.succeeded })} · {t("materials.export.failedCount", { count: task.failed })} · {t("materials.export.cancelledCount", { count: task.cancelled })}</div>
      <details className="material-export-path">
        <summary title={path.full}>{path.folder}</summary>
        <div className="material-export-path-full"><code>{path.full}</code>
          <button type="button" onClick={() => onCopyDestination(task.taskId, task.destination)}>{t("materials.export.copyPath")}</button></div>
      </details>
      {active && <>
        <div className="material-export-current" title={task.currentFile || undefined}>{task.currentFile || t("materials.export.preparing")}</div>
        {percentage !== null && <><progress value={task.currentBytes} max={task.currentTotalBytes}
          aria-label={t("materials.export.currentFileProgress")} />
          <small>{formatBytes(task.currentBytes)} / {formatBytes(task.currentTotalBytes)} · {percentage}%</small></>}
      </>}
      {problem && <p className="material-export-error" role="alert">{problem.message}
        {problem.stopped && !problem.expired && <button type="button" onClick={() => onRefreshTask(task.taskId)}>{t("materials.export.checkAgain")}</button>}
      </p>}
      {(actionErrors[task.taskId] || retryErrors[task.taskId]) && <p className="material-export-error" role="alert">{actionErrors[task.taskId] || retryErrors[task.taskId]}</p>}
      {!active && <div className="material-export-row-actions">
        <button type="button" onClick={() => onOpenDestination(task.taskId)}>{t("materials.export.openDestination")}</button>
        {task.failed > 0 && <button type="button" onClick={() => onRetry(task)} disabled={Boolean(retryState[task.taskId])}>
          {t(retryState[task.taskId] === "inflight" ? "materials.export.retrying"
            : retryState[task.taskId] === "continued" ? recovered ? "materials.export.recovered" : "materials.export.continuedByRetry"
              : "materials.export.retryFailed")}
        </button>}
      </div>}
      {!active && <details className="material-export-item-details">
        <summary>{t("materials.export.itemResults")}</summary>
        <ul>{task.items.map((item) => <li key={item.assetId}>
          <b>{item.name}</b> · {t(item.state === "succeeded" ? "materials.export.itemSucceeded" : item.state === "cancelled" ? "materials.export.itemCancelled" : "materials.export.itemFailed")}
          {item.outputPath && <span> — {materialExportFriendlyPath(item.outputPath).full}</span>}
          {item.error && <span className="material-export-error"> — {item.error}</span>}
        </li>)}</ul>
      </details>}
    </section>;
  };

  return createPortal(<>
    {modalActive && <div className="modal-overlay-react experience-dialog-backdrop material-export-modal-backdrop"
      onPointerDown={modal.onBackdropPointerDown}>
      <div ref={modal.surfaceRef} tabIndex={-1} onKeyDown={modal.onSurfaceKeyDown}
        className="modal-box-react material-export-plan experience-dialog" role="dialog" aria-modal="true"
        aria-label={t("materials.export.title")} onPointerDown={(event) => event.stopPropagation()}>
        <h3>{t("materials.export.title")}</h3>
        {planning ? <p role="status">{t("materials.export.planning")}</p> : <>
          <p>{t("materials.export.scope", { scope: plan?.scopeLabel ?? "", count: plan?.total ?? 0 })}</p>
          {plan?.includesDescendants && <p>{t("materials.export.descendants")}</p>}
          <label className="material-export-option"><input type="checkbox" checked={preserveHierarchy}
            disabled={busy} onChange={(event) => onPreserveHierarchy(event.target.checked)} />{t("materials.export.hierarchy")}</label>
          <p className="material-export-hint">{t("materials.export.copyOnly")}</p>
          {error && <p className="material-export-error" role="alert">{error}</p>}
        </>}
        {busy && <p role="status">{t(submissionPhase === "choosing" ? "materials.export.choosing" : "materials.export.starting")}</p>}
        <div className="material-export-actions">
          <button type="button" data-modal-initial-focus onClick={onCancelPlan} disabled={busy}>{t("materials.export.close")}</button>
          {plan && <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
            {t("materials.export.chooseDestination")}</button>}
        </div>
      </div>
    </div>}
    {notices.length > 0 && <ExperienceOverlay><div className="material-export-notices" hidden={panelOpen}>
      {notices.map((notice) => <ExportNotice key={notice.id} notice={notice}
        onDismiss={() => onDismissNotice(notice.id)}
        onAction={() => notice.action === "open" && notice.taskId
          ? onOpenDestination(notice.taskId) : onOpenPanel()} />)}
    </div></ExperienceOverlay>}
    {panelOpen && <aside id="materials-export-panel" ref={panelRef} className="material-export-panel"
      aria-label={t("materials.export.recordsTitle")}
      onKeyDown={(event) => { if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); onClosePanel();
        document.getElementById("materials-export-trigger")?.focus();
      } }}>
      <header className="material-export-panel-heading"><div><span>{t("materials.export.panelEyebrow")}</span>
        <strong>{t("materials.export.recordsTitle")}</strong></div>
        <button type="button" data-export-panel-initial-focus
          onClick={() => { onClosePanel(); document.getElementById("materials-export-trigger")?.focus(); }}
          aria-label={t("materials.export.close")}>×</button></header>
      <div className="material-export-panel-content">
        {(running.length > 0 || runningCsv.length > 0) && <div className="material-export-active-list" aria-label={t("materials.export.runningTitle")}>{running.map(renderTask)}
          {runningCsv.map((task) => <MaterialCsvTaskRow key={task.taskId} task={task}
            retrying={csvRetrying === task.taskId} onCancel={() => onCancelCsvTask(task.taskId)}
            onRetry={() => onRetryCsvTask(task.taskId)} onDismiss={() => onDismissCsvTask(task.taskId)} />)}</div>}
        <div className="material-export-history-header"><strong>{t("materials.export.recentTitle", { count: recent.length + recentCsv.length })}</strong>
          {(recent.some((task) => retryState[task.taskId] !== "inflight") || recentCsv.length > 0) && <button type="button" onClick={onClearCompleted}>{t("materials.export.clearCompleted")}</button>}</div>
        {(recent.length > 0 || recentCsv.length > 0) ? <div className="material-export-history-list">{recent.map(renderTask)}
          {recentCsv.map((task) => <MaterialCsvTaskRow key={task.taskId} task={task}
            retrying={csvRetrying === task.taskId} onCancel={() => onCancelCsvTask(task.taskId)}
            onRetry={() => onRetryCsvTask(task.taskId)} onDismiss={() => onDismissCsvTask(task.taskId)} />)}</div>
          : running.length === 0 && runningCsv.length === 0 ? <p className="material-export-empty">{t("materials.export.noRecords")}</p> : null}
      </div>
    </aside>}
  </>, portalRoot);
}
